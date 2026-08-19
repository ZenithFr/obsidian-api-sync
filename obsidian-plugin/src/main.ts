import { Plugin, TFile, TAbstractFile, Notice, TFolder, requestUrl } from 'obsidian';
import { ObsidianApiSyncSettings, DEFAULT_SETTINGS } from './types';
import { ObsidianApiSyncWsClient, WsState, createWsClient } from './ws-client';
import { ObsidianApiSyncSettingTab } from './settings';
import { TrashRecoveryModal, VersionHistoryModal, ConflictModal } from './modals';
import { encryptText, decryptText, encryptBinary, decryptBinary, arrayBufferToBase64, base64ToArrayBuffer, isEncryptedText, isEncryptedBinary } from './encryption';
import { ToastManager } from './utils';

export default class ObsidianApiSyncPlugin extends Plugin {
  settings!: ObsidianApiSyncSettings;
  wsClient!: ObsidianApiSyncWsClient;
  modifyVersions: Map<string, number> = new Map();
  modifyDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  activeConflicts: Set<string> = new Set();
  private statusBarItem!: HTMLElement;
  private remoteChangeLocks: Map<string, number> = new Map();
  private localModificationTimes: Map<string, number> = new Map();


  // ─── Helpers ─────────────────────────────────────────────────────────────

  shouldSyncPath(path: string, isFolder: boolean = false): boolean {
    if (path.startsWith(this.app.vault.configDir + '/')) {
      if (!this.settings.syncObsidianFolder) return false;
      if (this.settings.excludeWorkspace && path === `${this.app.vault.configDir}/workspace.json`) return false;
      if (path === `${this.app.vault.configDir}/plugins/obsidian-api-sync/data.json`) return false;
      return true;
    }

    if (!isFolder) {
      const extMatch = path.match(/\.([^.]+)$/);
      if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        const allowed = this.settings.allowedExtensions.split(',').map(s => s.trim().toLowerCase());
        if (!allowed.includes(ext)) return false;
      } else {
        return false;
      }
    }

    const mode = this.settings.syncMode;
    if (mode === 'include_all') return true;

    const paths = this.settings.selectiveSyncPaths.split('\n').map(s => s.trim()).filter(s => s);
    let matches = false;
    for (let p of paths) {
      if (p.endsWith('/')) {
        p = p.slice(0, -1);
      }
      if (path === p || path.startsWith(p + '/')) {
        matches = true;
        break;
      }
    }

    if (mode === 'include_selected') return matches;
    if (mode === 'exclude_selected') return !matches;
    return true;
  }

  isBinaryFile(path: string): boolean {
    const extMatch = path.match(/\.([^.]+)$/);
    if (!extMatch) return false;
    const ext = extMatch[1].toLowerCase();
    // Common text formats in Obsidian
    const textExts = ['md', 'canvas', 'txt', 'css', 'json', 'csv', 'js', 'ts'];
    return !textExts.includes(ext);
  }

  arrayBufferToBase64(buffer: ArrayBuffer): string {
    return arrayBufferToBase64(buffer);
  }

  base64ToArrayBuffer(base64: string): ArrayBuffer {
    return base64ToArrayBuffer(base64);
  }

  async encryptPayloadIfNeeded(contentStr: string, isBinary: boolean): Promise<{ contentStr: string, isBinary: boolean }> {
    if (!this.settings.encryptionPassword) return { contentStr, isBinary };
    if (isBinary) {
      const encryptedBuf = await encryptBinary(this.base64ToArrayBuffer(contentStr), this.settings.encryptionPassword);
      return { contentStr: this.arrayBufferToBase64(encryptedBuf), isBinary: true };
    } else {
      const encryptedText = await encryptText(contentStr, this.settings.encryptionPassword);
      return { contentStr: encryptedText, isBinary: false };
    }
  }

  async encryptBinaryBufferIfNeeded(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.settings.encryptionPassword) return buffer;
    return await encryptBinary(buffer, this.settings.encryptionPassword);
  }

  async uploadChunked(path: string, payloadStr: string, isBinary: boolean): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.apiToken) return;
    const uploadId = (Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15));
    
    let base64Content = payloadStr;
    if (!isBinary) {
      base64Content = this.arrayBufferToBase64(new TextEncoder().encode(payloadStr));
    }
    
    const chunkSize = 2 * 1024 * 1024; // 2MB
    const totalChunks = Math.ceil(base64Content.length / chunkSize);

    try {
      for (let i = 0; i < totalChunks; i++) {
        const chunk = base64Content.substring(i * chunkSize, (i + 1) * chunkSize);
        await requestUrl({
          url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/chunk`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.settings.apiToken}`
          },
          body: JSON.stringify({
            upload_id: uploadId,
            chunk_index: i,
            total_chunks: totalChunks,
            data: chunk
          })
        });
      }

      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/commit`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.apiToken}`
        },
        body: JSON.stringify({
          upload_id: uploadId,
          path: path,
          is_binary: isBinary,
          total_chunks: totalChunks
        })
      });
    } catch (e) {
      this.showError('ERR-NET-CHUNK-01', e);
      try {
        await requestUrl({
          url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/chunk/${uploadId}`,
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.settings.apiToken}` }
        });
      } catch (cancelErr) {
        console.error("Failed to cancel upload:", cancelErr);
      }
    }
  }

  async decryptInboundContent(path: string, remoteContent: string, isBinary: boolean): Promise<{ decryptedStr: string, decryptedIsBinary: boolean }> {
    if (!this.settings.encryptionPassword) {
      return { decryptedStr: remoteContent, decryptedIsBinary: isBinary };
    }
    if (isBinary) {
      const remoteBuffer = this.base64ToArrayBuffer(remoteContent);
      if (isEncryptedBinary(remoteBuffer)) {
        try {
          const decryptedBuffer = await decryptBinary(remoteBuffer, this.settings.encryptionPassword);
          return { decryptedStr: this.arrayBufferToBase64(decryptedBuffer), decryptedIsBinary: true };
        } catch (e) {
          throw new Error(`Failed to decrypt binary file ${path}`);
        }
      }
    } else {
      if (isEncryptedText(remoteContent)) {
        try {
          const decryptedText = await decryptText(remoteContent, this.settings.encryptionPassword);
          return { decryptedStr: decryptedText, decryptedIsBinary: false };
        } catch (e) {
          throw new Error(`Failed to decrypt text file ${path}`);
        }
      }
    }
    return { decryptedStr: remoteContent, decryptedIsBinary: isBinary };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Create WebSocket client
    this.wsClient = createWsClient();
    this.wsClient.setAutoReconnect(this.settings.autoReconnect);
    

    // ── WS Callbacks ──────────────────────────────────────────────────────────

    this.wsClient.onVaultRestored = async (payload) => {
      ToastManager.showInfo(`Server vault restored from snapshot ${payload.snapshot_id}! Re-syncing...`);
      
      // Reset caches
      
      // Pull all files after a brief delay to allow server to finish sending broadcasts
      setTimeout(() => {
        this.pullAllFiles();
      }, 1000);
    };

    this.wsClient.onFileChanged = async (payload) => {
      if (payload.is_binary && !payload.content) {
        try {
          const encodedPath = payload.path.split('/').map(encodeURIComponent).join('/');
          const resp = await requestUrl({
            url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/download/${encodedPath}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${this.settings.apiToken}` }
          });
          let buffer = resp.arrayBuffer;
          if (this.settings.encryptionPassword) {
            buffer = await decryptBinary(buffer, this.settings.encryptionPassword);
          }
          payload.content = this.arrayBufferToBase64(buffer);
        } catch (err) {
          this.showError('ERR-NET-BIN-01', err);
          return;
        }
      } else {
        try {
          const dec = await this.decryptInboundContent(payload.path, payload.content, !!payload.is_binary);
          payload.content = dec.decryptedStr;
          payload.is_binary = dec.decryptedIsBinary;
        } catch (err) {
          this.showError('ERR-CRYPTO-DEC-01', err);
          return;
        }
      }

      if (payload.path.startsWith(this.app.vault.configDir + '/')) {
        if (!this.settings.syncObsidianFolder) return;
        if (this.settings.excludeWorkspace && payload.path === `${this.app.vault.configDir}/workspace.json`) return;
        if (payload.path === `${this.app.vault.configDir}/plugins/obsidian-api-sync/data.json`) return;
        
        try {
          const exists = await this.app.vault.adapter.exists(payload.path);
          if (exists) {
            const currentContent = await this.app.vault.adapter.read(payload.path);
            const normalizedLocal = currentContent.replace(/\r\n/g, '\n');
            const normalizedRemote = payload.content.replace(/\r\n/g, '\n');
            if (normalizedLocal !== normalizedRemote) {
              if (this.modifyDebounceTimers.has(payload.path)) {
                clearTimeout(this.modifyDebounceTimers.get(payload.path)!);
                this.modifyDebounceTimers.delete(payload.path);
              }
              this.remoteChangeLocks.set(payload.path, Date.now() + 800);
              await this.app.vault.adapter.write(payload.path, payload.content);
            }
          } else {
            await this.ensureAdapterFolderExists(payload.path);
            await this.app.vault.adapter.write(payload.path, payload.content);
          }
        } catch (err) {
          this.showError('ERR-FS-OBS-01', err);
        }
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(payload.path);

      if (file instanceof TFile) {
        // Echo-loop prevention: only write if content actually differs
        let normalizedLocal = '';
        let normalizedRemote = '';
        if (payload.is_binary) {
          const currentBuffer = await this.app.vault.readBinary(file);
          normalizedLocal = this.arrayBufferToBase64(currentBuffer);
          normalizedRemote = payload.content;
        } else {
          const currentContent = await this.app.vault.read(file);
          normalizedLocal = currentContent.replace(/\r\n/g, '\n');
          normalizedRemote = payload.content.replace(/\r\n/g, '\n');
        }
        if (normalizedLocal !== normalizedRemote) {
          if (this.modifyDebounceTimers.has(file.path)) {
            clearTimeout(this.modifyDebounceTimers.get(file.path)!);
            this.modifyDebounceTimers.delete(file.path);
          }
          this.remoteChangeLocks.set(file.path, Date.now() + 800);
          try {
            if (payload.is_binary) {
              await this.app.vault.modifyBinary(file, this.base64ToArrayBuffer(payload.content));
            } else {
              await this.app.vault.modify(file, payload.content);
            }
          } catch (err) {
            this.showError('ERR-FS-MOD-01', err);
          }
        }
      } else if (!file) {
        // File doesn't exist locally yet — create it
        try {
          await this.ensureFolderExists(payload.path);
          if (payload.is_binary) {
            await this.app.vault.createBinary(payload.path, this.base64ToArrayBuffer(payload.content));
          } else {
            await this.app.vault.create(payload.path, payload.content);
          }
        } catch (err) {
          this.showError('ERR-FS-CRE-01', err);
        }
      }
    };

    this.wsClient.onFolderCreated = async (payload) => {
      if (payload.path.startsWith(this.app.vault.configDir + '/')) {
        if (!this.settings.syncObsidianFolder) return;
        this.remoteChangeLocks.set(payload.path, Date.now() + 800);
        await this.ensureAdapterFolderExists(payload.path + '/dummy');
        return;
      }

      const folder = this.app.vault.getAbstractFileByPath(payload.path);
      if (!folder) {
        this.remoteChangeLocks.set(payload.path, Date.now() + 800);
        await this.ensureFolderExists(payload.path);
      }
    };

    this.wsClient.onFileDeleted = async (payload) => {
      if (payload.path.startsWith(this.app.vault.configDir + '/')) {
        if (!this.settings.syncObsidianFolder) return;
        try {
          const exists = await this.app.vault.adapter.exists(payload.path);
          if (exists) await this.app.vault.adapter.remove(payload.path);
        } catch (err) {
          this.showError('ERR-FS-DEL-01', err);
        }
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (file) {
        try {
          await this.app.vault.trash(file, false); // move to system trash
        } catch (err) {
          this.showError('ERR-FS-DEL-02', err);
        }
      }
    };

    this.wsClient.onFileRenamed = async (payload) => {
      if (payload.old_path.startsWith(this.app.vault.configDir + '/')) {
        if (!this.settings.syncObsidianFolder) return;
        try {
          const exists = await this.app.vault.adapter.exists(payload.old_path);
          if (exists) {
            await this.ensureAdapterFolderExists(payload.new_path);
            await this.app.vault.adapter.rename(payload.old_path, payload.new_path);
          }
        } catch (err) {
          this.showError('ERR-FS-REN-01', err);
        }
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(payload.old_path);
      if (file) {
        try {
          await this.ensureFolderExists(payload.new_path);
          await this.app.vault.rename(file, payload.new_path);
        } catch (err) {
          this.showError('ERR-FS-REN-02', err);
        }
      }
    };

    this.wsClient.onStateChange = (state: WsState) => {
      this.updateStatusBar(state);
    };

    this.wsClient.onConnected = (clientId: string) => {
      console.log(`[ObsidianApiSync] Connected. Client ID: ${clientId}`);
      this.smartSync();
    };

    this.wsClient.onSmartSyncResponse = async (payload) => {
      let pulled = 0, pushed = 0;

      // Files server is newer on → request them over WS
      for (const path of payload.pull) {
        if (!this.shouldSyncPath(path, false)) continue;
        this.wsClient.sendFilePullRequest(path);
        // The FILE_CHANGED response is handled by onFileChanged
        pulled++;
      }

      // Files client is newer on → push them to server
      for (const path of payload.push) {
        if (!this.shouldSyncPath(path, false)) continue;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          const isBinary = this.isBinaryFile(file.path);
          if (isBinary) {
            const buffer = await this.app.vault.readBinary(file);
            const encrypted = await this.encryptBinaryBufferIfNeeded(buffer);
            await this.httpFallbackWriteRaw(file.path, encrypted, true);
          } else {
            const content = await this.app.vault.read(file);
            const encrypted = await this.encryptPayloadIfNeeded(content, false);
            if (encrypted.contentStr.length > 2 * 1024 * 1024) {
              await this.uploadChunked(file.path, encrypted.contentStr, false);
            } else {
              this.wsClient.sendFileModify(file.path, encrypted.contentStr, false);
            }
          }
          pushed++;
        }
      }

      // True text conflicts → open ConflictModal (side-by-side diff)
      for (const { path, server_mtime_ms } of payload.conflicts) {
        if (this.activeConflicts.has(path)) continue;
        this.activeConflicts.add(path);
        this.wsClient.clearQueueForPath(path);
        new ConflictModal(this.app, this, path, server_mtime_ms, () => {
          this.activeConflicts.delete(path);
        }).open();
      }

      const total = pulled + pushed + payload.conflicts.length;
      if (total === 0) {
        ToastManager.showInfo('Sync Complete: Vault is up to date.');
      } else {
        const parts = [];
        if (pulled > 0)  parts.push(`Pulled: ${pulled}`);
        if (pushed > 0)  parts.push(`Pushed: ${pushed}`);
        if (payload.conflicts.length > 0) parts.push(`Conflicts: ${payload.conflicts.length}`);
        ToastManager.showInfo(`Sync Complete! ${parts.join(', ')}`);
      }
    };

    this.wsClient.onError = (payload) => {
      if (payload.code === 'INVALID_PATH' && (payload.message === 'Path already exists.' || payload.message === 'A file already exists at this path.')) {
        console.debug('[ObsidianApiSync] Ignoring already exists error:', payload.message);
        return;
      }
      if (payload.code === 'CONFLICT' && payload.path) {
        if (this.activeConflicts.has(payload.path)) return;
        this.activeConflicts.add(payload.path);
        this.wsClient.clearQueueForPath(payload.path);
        
        console.warn(`[ObsidianApiSync] Conflict detected for ${payload.path}`);
        new ConflictModal(this.app, this, payload.path, payload.server_mtime, () => {
          this.activeConflicts.delete(payload.path!);
        }).open();
        return;
      }
      this.showError('ERR-NET-SRV-01', new Error(payload.message));
    };

    // ── Settings Tab ──────────────────────────────────────────────────────────
    this.addSettingTab(new ObsidianApiSyncSettingTab(this.app, this));

    // ── Status Bar ────────────────────────────────────────────────────────────
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(WsState.DISCONNECTED);

    // ── Auto-connect on startup ───────────────────────────────────────────────
    if (this.settings.serverUrl && this.settings.apiToken) {
      this.connectWs();
    }

    // ── Commands ──────────────────────────────────────────────────────────────
    this.addCommand({
      id: 'ObsidianApiSync-pull-all',
      name: 'Force pull all files from server (overwrites local)',
      callback: () => this.pullAllFiles(),
    });

    this.addCommand({
      id: 'ObsidianApiSync-restore-deleted',
      name: 'Restore deleted files (Server Trash)',
      callback: () => {
        new TrashRecoveryModal(this.app, this).open();
      }
    });

    this.addCommand({
      id: 'ObsidianApiSync-view-history',
      name: 'View version history for current file',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        new VersionHistoryModal(this.app, this, file ? file.path : null).open();
      }
    });

    // ── Editor & Vault Events ─────────────────────────────────────────────────
    
    // 0. Watch for raw filesystem changes (e.g., in .obsidian)
    this.registerEvent(
      // @ts-ignore - undocumented event for all file system changes
      this.app.vault.on('raw', (path: string) => {
        if (!this.settings.syncOnModify || !this.settings.syncObsidianFolder) return;
        if (typeof path !== 'string') return;
        if (!path.startsWith(this.app.vault.configDir + '/')) return;
        if (this.settings.excludeWorkspace && path === `${this.app.vault.configDir}/workspace.json`) return;
        if (path === `${this.app.vault.configDir}/plugins/obsidian-api-sync/data.json`) return;
        
        const lockExpiry = this.remoteChangeLocks.get(path);
        if (lockExpiry && Date.now() < lockExpiry) return;

        if (this.modifyDebounceTimers.has(path)) {
          clearTimeout(this.modifyDebounceTimers.get(path)!);
        }

        const version = (this.modifyVersions.get(path) || 0) + 1;
        this.modifyVersions.set(path, version);
        this.localModificationTimes.set(path, Date.now());

        const timer = setTimeout(async () => {
          this.modifyDebounceTimers.delete(path);
          try {
            const exists = await this.app.vault.adapter.exists(path);
            if (!exists) {
              if (this.wsClient.getState() === WsState.CONNECTED) {
                this.wsClient.sendFileDelete(path);
              }
            } else {
              const stat = await this.app.vault.adapter.stat(path);
              if (stat && stat.type === 'file') {
                const isBinary = this.isBinaryFile(path);
                if (isBinary) {
                  const buffer = await this.app.vault.adapter.readBinary(path);
                  if (buffer.byteLength > 133 * 1024 * 1024) return;
                  const encryptedBuf = await this.encryptBinaryBufferIfNeeded(buffer);
                  if (this.modifyVersions.get(path) !== version) return;
                  if (this.settings.serverUrl && this.settings.apiToken) {
                    await this.httpFallbackWriteRaw(path, encryptedBuf, true);
                  }
                } else {
                  const contentStr = await this.app.vault.adapter.read(path);
                  if (contentStr.length > 133 * 1024 * 1024) return;
                  const encrypted = await this.encryptPayloadIfNeeded(contentStr, false);
                  if (this.modifyVersions.get(path) !== version) return;
                  if (encrypted.contentStr.length > 2 * 1024 * 1024) {
                    await this.uploadChunked(path, encrypted.contentStr, false);
                  } else if (this.wsClient.getState() === WsState.CONNECTED) {
                    this.wsClient.sendFileModify(path, encrypted.contentStr, false);
                  } else if (this.settings.serverUrl && this.settings.apiToken) {
                    await this.httpFallbackWriteRaw(path, encrypted.contentStr, false);
                  }
                }
              }
            }
          } catch(e) {
            // Might be a directory or binary file, ignore
          }
        }, this.settings.syncDebounceMs || 150);
        
        this.modifyDebounceTimers.set(path, timer);
      })
    );

    // 1. Hook into editor changes for instant, letter-by-letter sync
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, info) => {
        if (!this.settings.syncOnModify) return;

        const file = info?.file || this.app.workspace.getActiveFile();
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncPath(file.path, false)) return;

        const lockExpiry = this.remoteChangeLocks.get(file.path);
        if (lockExpiry && Date.now() < lockExpiry) return;

        if (this.modifyDebounceTimers.has(file.path)) {
          clearTimeout(this.modifyDebounceTimers.get(file.path)!);
        }

        const currentContent = editor.getValue();
        const version = (this.modifyVersions.get(file.path) || 0) + 1;
        this.modifyVersions.set(file.path, version);
        this.localModificationTimes.set(file.path, Date.now());

        const timer = setTimeout(async () => {
          this.modifyDebounceTimers.delete(file.path);
          if (currentContent.length > 133 * 1024 * 1024) {
            this.showError('ERR-FS-SIZE-01', `File ${file.path} is over 100MB limit. Skipping.`);
            return;
          }
          const encrypted = await this.encryptPayloadIfNeeded(currentContent, false);
          if (this.modifyVersions.get(file.path) !== version) return;
          if (encrypted.contentStr.length > 2 * 1024 * 1024) {
            await this.uploadChunked(file.path, encrypted.contentStr, encrypted.isBinary);
          } else {
            this.wsClient.sendFileModify(file.path, encrypted.contentStr, encrypted.isBinary);
          }
        }, this.settings.syncDebounceMs || 150);

        this.modifyDebounceTimers.set(file.path, timer);
      })
    );

    // 2. Fallback for non-editor modifications (e.g. other plugins or syncing)
    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncPath(file.path, false)) return;
        if (!this.settings.syncOnModify) return;
        
        const lockExpiry = this.remoteChangeLocks.get(file.path);
        if (lockExpiry && Date.now() < lockExpiry) return; // ignore our own remote updates

        if (this.modifyDebounceTimers.has(file.path)) {
          clearTimeout(this.modifyDebounceTimers.get(file.path)!);
        }

        const version = (this.modifyVersions.get(file.path) || 0) + 1;
        this.modifyVersions.set(file.path, version);
        this.localModificationTimes.set(file.path, Date.now());

        const timer = setTimeout(async () => {
          this.modifyDebounceTimers.delete(file.path);
          const isBinary = this.isBinaryFile(file.path);
          if (isBinary) {
            const buffer = await this.app.vault.readBinary(file);
            if (buffer.byteLength > 133 * 1024 * 1024) return;
            const encryptedBuf = await this.encryptBinaryBufferIfNeeded(buffer);
            if (this.modifyVersions.get(file.path) !== version) return;
            await this.httpFallbackWriteRaw(file.path, encryptedBuf, true);
          } else {
            const contentStr = await this.app.vault.read(file);
            if (contentStr.length > 133 * 1024 * 1024) return;
            const encrypted = await this.encryptPayloadIfNeeded(contentStr, false);
            if (this.modifyVersions.get(file.path) !== version) return;
            if (encrypted.contentStr.length > 2 * 1024 * 1024) {
              await this.uploadChunked(file.path, encrypted.contentStr, false);
            } else {
              this.wsClient.sendFileModify(file.path, encrypted.contentStr, false);
            }
          }
        }, this.settings.syncDebounceMs || 150);

        this.modifyDebounceTimers.set(file.path, timer);
      })
    );

    // 3. New File Creation
    this.registerEvent(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (!this.settings.syncOnModify) return;
        if (!this.shouldSyncPath(file.path, file instanceof TFolder)) return;
        
        const lockExpiry = this.remoteChangeLocks.get(file.path);
        if (lockExpiry && Date.now() < lockExpiry) return;

        if (file instanceof TFile) {
          const version = (this.modifyVersions.get(file.path) || 0) + 1;
          this.modifyVersions.set(file.path, version);
          this.localModificationTimes.set(file.path, Date.now());

          // Give Obsidian a tiny tick to finish writing the file to disk
          setTimeout(async () => {
            if (this.wsClient.getState() === WsState.CONNECTED) {
              const isBinary = this.isBinaryFile(file.path);
              if (isBinary) {
                const buffer = await this.app.vault.readBinary(file);
                if (buffer.byteLength > 133 * 1024 * 1024) return;
                const encryptedBuf = await this.encryptBinaryBufferIfNeeded(buffer);
                if (this.modifyVersions.get(file.path) !== version) return;
                await this.httpFallbackWriteRaw(file.path, encryptedBuf, true);
              } else {
                const contentStr = await this.app.vault.read(file);
                if (contentStr.length > 133 * 1024 * 1024) return;
                const encrypted = await this.encryptPayloadIfNeeded(contentStr, false);
                if (this.modifyVersions.get(file.path) !== version) return;
                if (encrypted.contentStr.length > 2 * 1024 * 1024) {
                  await this.uploadChunked(file.path, encrypted.contentStr, false);
                } else {
                  this.wsClient.sendFileModify(file.path, encrypted.contentStr, false);
                }
              }
            }
          }, 300);
        } else {
          // It's a folder
          this.wsClient.sendFolderCreate(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (!this.settings.syncOnModify) return;
        if (!this.shouldSyncPath(file.path, file instanceof TFolder)) return;
        this.wsClient.sendFileDelete(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!this.settings.syncOnModify) return;
        if (!this.shouldSyncPath(file.path, file instanceof TFolder)) return;
        this.wsClient.sendFileRename(oldPath, file.path);
      })
    );

    // ── Ribbon Icon ───────────────────────────────────────────────────────────
    this.addRibbonIcon('sync', 'Obsidian API Sync', () => {
      const state = this.wsClient.getState();
      const messages: Record<WsState, string> = {
        [WsState.CONNECTED]: '🟢 ObsidianApiSync: Connected and syncing.',
        [WsState.CONNECTING]: '🟡 ObsidianApiSync: Connecting to server…',
        [WsState.RECONNECTING]: '🟡 ObsidianApiSync: Reconnecting to server…',
        [WsState.DISCONNECTED]: '🔴 ObsidianApiSync: Disconnected. Check settings.',
      };
      ToastManager.showInfo(messages[state] ?? `ObsidianApiSync state: ${state}`, 500);
    });
  }

  onunload(): void {
    this.wsClient.disconnect();
  }

  // ─── Public Methods ─────────────────────────────────────────────────────────

  connectWs(): void {
    this.wsClient.connect(this.settings.serverUrl, this.settings.apiToken);
  }

  /**
   * Smart sync: send the server a manifest of all local files with their mtimes.
   * The server classifies each as pull/push/conflict/ok and responds via
   * SMART_SYNC_RESPONSE, which is handled by wsClient.onSmartSyncResponse.
   *
   * This replaces the old blind pullAllFiles() on every connect.
   */
  async smartSync(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.apiToken) return;
    if (this.wsClient.getState() !== WsState.CONNECTED) return;

    ToastManager.showInfo('Syncing...', 500);

    try {
      const localFiles = this.app.vault.getFiles().filter(f => this.shouldSyncPath(f.path, false));
      const fileList = localFiles.map(f => ({
        path: f.path,
        client_mtime_ms: f.stat.mtime,
        hash: this.wsClient.getKnownHash(f.path) || '',
      }));

      this.wsClient.sendSmartSyncRequest(fileList);
      // Response handled asynchronously by wsClient.onSmartSyncResponse
    } catch (err) {
      this.showError('ERR-SMART-SYNC-01', err);
    }
  }

  async pullAllFiles(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.apiToken) return;
    
    ToastManager.showInfo('Syncing files from server...', 500);
    const pullStartTime = Date.now();
    try {
      const listResp = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files?include_content=true`,
        headers: { Authorization: `Bearer ${this.settings.apiToken}` }
      });
      const data = listResp.json;
      if (!data || !data.files) return;

      let created = 0;
      let updated = 0;

      for (const item of data.files) {
        const path = item.path;

        if ((this.localModificationTimes.get(path) || 0) > pullStartTime) {
          continue;
        }

        let remoteContent = item.content;
        let isBin = !!item.is_binary;
        
        if (remoteContent === null) {
          // Download large file
          try {
            const dlResp = await requestUrl({
              url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/download/${path.split('/').map(encodeURIComponent).join('/')}`,
              headers: { Authorization: `Bearer ${this.settings.apiToken}` }
            });
            remoteContent = this.arrayBufferToBase64(dlResp.arrayBuffer);
          } catch(e) {
            this.showError('ERR-NET-DL-01', e);
            continue;
          }
        }

        try {
          const dec = await this.decryptInboundContent(path, remoteContent, isBin);
          remoteContent = dec.decryptedStr;
          isBin = dec.decryptedIsBinary;
        } catch (err) {
          this.showError('ERR-CRYPTO-DEC-02', err);
          continue;
        }
        
        // Handle Obsidian settings/plugins folder
        if (path.startsWith(this.app.vault.configDir + '/')) {
          if (!this.settings.syncObsidianFolder) continue;
          if (this.settings.excludeWorkspace && path === `${this.app.vault.configDir}/workspace.json`) continue;
          if (path === `${this.app.vault.configDir}/plugins/obsidian-api-sync/data.json`) continue;
          
          try {
            const exists = await this.app.vault.adapter.exists(path);
            if (exists) {
              const localContent = await this.app.vault.adapter.read(path);
              const normalizedLocal = localContent.replace(/\r\n/g, '\n');
              const normalizedRemote = remoteContent.replace(/\r\n/g, '\n');
              if (normalizedLocal !== normalizedRemote) {
                if (this.modifyDebounceTimers.has(path)) {
                  clearTimeout(this.modifyDebounceTimers.get(path)!);
                  this.modifyDebounceTimers.delete(path);
                }
                this.remoteChangeLocks.set(path, Date.now() + 800);
                await this.app.vault.adapter.write(path, remoteContent);
                this.wsClient.updateHashCache(path, remoteContent, false);
                updated++;
              }
            } else {
              this.remoteChangeLocks.set(path, Date.now() + 800);
              await this.ensureAdapterFolderExists(path);
              await this.app.vault.adapter.write(path, remoteContent);
              this.wsClient.updateHashCache(path, remoteContent, false);
              created++;
            }
          } catch(e) {
            this.showError('ERR-FS-CONF-01', e);
          }
          continue;
        }

        if (!this.shouldSyncPath(path, false)) continue;
        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (localFile instanceof TFile) {
          let normalizedLocal = '';
          let normalizedRemote = '';
          if (isBin) {
            const currentBuffer = await this.app.vault.readBinary(localFile);
            normalizedLocal = this.arrayBufferToBase64(currentBuffer);
            normalizedRemote = remoteContent;
          } else {
            const localContent = await this.app.vault.read(localFile);
            normalizedLocal = localContent.replace(/\r\n/g, '\n');
            normalizedRemote = remoteContent.replace(/\r\n/g, '\n');
          }
          if (normalizedLocal !== normalizedRemote) {
            if (this.modifyDebounceTimers.has(localFile.path)) {
              clearTimeout(this.modifyDebounceTimers.get(localFile.path)!);
              this.modifyDebounceTimers.delete(localFile.path);
            }
            this.remoteChangeLocks.set(localFile.path, Date.now() + 800);
            if (isBin) {
              await this.app.vault.modifyBinary(localFile, this.base64ToArrayBuffer(remoteContent));
            } else {
              await this.app.vault.modify(localFile, remoteContent);
            }
            this.wsClient.updateHashCache(localFile.path, item.content, !!item.is_binary);
            updated++;
          }
        } else if (!localFile) {
          this.remoteChangeLocks.set(path, Date.now() + 800);
          await this.ensureFolderExists(path);
          if (isBin) {
            await this.app.vault.createBinary(path, this.base64ToArrayBuffer(remoteContent));
          } else {
            await this.app.vault.create(path, remoteContent);
          }
          this.wsClient.updateHashCache(path, item.content, !!item.is_binary);
          created++;
        }
      }
      
      if (created > 0 || updated > 0) {
        ToastManager.showInfo(`Sync Complete! Created: ${created}, Updated: ${updated}`);
      } else {
        ToastManager.showInfo('Sync Complete: Vault is up to date.');
      }
    } catch (err) {
      this.showError('ERR-NET-PULL-01', err);
    }
  }

  async httpFallbackWrite(file: TFile, contentStr?: string, isBinary?: boolean): Promise<void> {
    try {
      
      let finalContent: string | ArrayBuffer = contentStr || '';
      let isBin = isBinary !== undefined ? isBinary : this.isBinaryFile(file.path);
      if (!contentStr) {
        if (isBin) {
          finalContent = await this.app.vault.readBinary(file);
        } else {
          finalContent = await this.app.vault.read(file);
        }
      } else {
        if (isBin) {
          finalContent = this.base64ToArrayBuffer(contentStr);
        }
      }
    

      // Encode the file path so it's safe in a URL segment
      const encodedPath = file.path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');

      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: finalContent,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      this.showError('ERR-NET-HTTP-01', err);
    }
  }

  // ─── Settings Persistence ────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<ObsidianApiSyncSettings>
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private async ensureAdapterFolderExists(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop(); // remove filename
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath === '' ? part : `${currentPath}/${part}`;
      const exists = await this.app.vault.adapter.exists(currentPath);
      if (!exists) {
        try {
          await this.app.vault.adapter.mkdir(currentPath);
        } catch (err) {}
      }
    }
  }

  async httpFallbackWriteRaw(path: string, content: string | ArrayBuffer, isBinary: boolean = false): Promise<void> {
    try {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.settings.apiToken}`,
      };
      if (isBinary) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['X-Is-Binary'] = 'true';
      } else {
        headers['Content-Type'] = 'text/plain';
      }
      
      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
        method: 'POST',
        headers,
        body: content,
      });
    } catch (err) {
      this.showError('ERR-NET-HTTP-02', err);
    }
  }

  private async ensureFolderExists(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop(); // remove filename
    let currentPath = '';
    
    for (const part of parts) {
      currentPath = currentPath === '' ? part : `${currentPath}/${part}`;
      const folder = this.app.vault.getAbstractFileByPath(currentPath);
      if (!folder) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (err) {
          // Ignore if it was created concurrently
        }
      }
    }
  }

  private updateStatusBar(state: WsState): void {
    const labels: Record<WsState, string> = {
      [WsState.CONNECTED]: '🟢 ObsidianApiSync',
      [WsState.CONNECTING]: '🟡 ObsidianApiSync',
      [WsState.RECONNECTING]: '🟡 ObsidianApiSync',
      [WsState.DISCONNECTED]: '🔴 ObsidianApiSync',
    };
    this.statusBarItem.setText(labels[state] ?? 'ObsidianApiSync');
  }

  showError(context: string, err: any): void {
    ToastManager.showError(context, err);
  }
}