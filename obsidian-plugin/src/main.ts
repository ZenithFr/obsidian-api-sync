import { Plugin, TFile, TAbstractFile, Notice, requestUrl } from 'obsidian';
import { ObsidianApiSyncSettings, DEFAULT_SETTINGS } from './types';
import { ObsidianApiSyncWsClient, WsState, createWsClient } from './ws-client';
import { ObsidianApiSyncSettingTab } from './settings';
import { TrashRecoveryModal, VersionHistoryModal } from './modals';

export default class ObsidianApiSyncPlugin extends Plugin {
  settings!: ObsidianApiSyncSettings;
  wsClient!: ObsidianApiSyncWsClient;
  private statusBarItem!: HTMLElement;
  private modifyDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private remoteChangeLocks: Map<string, number> = new Map();


  // ─── Helpers ─────────────────────────────────────────────────────────────

  shouldSyncPath(path: string, isFolder: boolean = false): boolean {
    if (path.startsWith(this.app.vault.configDir + '/')) {
      return true; // Config dir is handled separately via syncObsidianFolder
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
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Create WebSocket client
    this.wsClient = createWsClient();
    this.wsClient.setAutoReconnect(this.settings.autoReconnect);

    // ── WS Callbacks ──────────────────────────────────────────────────────────

    this.wsClient.onFileChanged = async (payload) => {
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
          this.showError("Failed to process remote .obsidian change:", err);
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
            // User is actively typing, don't overwrite their local edits. Their pending sync will overwrite the server soon.
            return;
          }
          this.remoteChangeLocks.set(file.path, Date.now() + 800);
          try {
            if (payload.is_binary) {
              await this.app.vault.modifyBinary(file, this.base64ToArrayBuffer(payload.content));
            } else {
              await this.app.vault.modify(file, payload.content);
            }
          } catch (err) {
            this.showError("modify failed", err);
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
          this.showError("Failed to create file from remote change:", err);
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
          this.showError("Failed to process remote .obsidian delete:", err);
        }
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (file) {
        try {
          await this.app.vault.trash(file, false); // move to system trash
        } catch (err) {
          this.showError("Failed to process remote delete:", err);
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
          this.showError("Failed to process remote .obsidian rename:", err);
        }
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(payload.old_path);
      if (file) {
        try {
          await this.ensureFolderExists(payload.new_path);
          await this.app.vault.rename(file, payload.new_path);
        } catch (err) {
          this.showError("Failed to process remote rename:", err);
        }
      }
    };

    this.wsClient.onStateChange = (state: WsState) => {
      this.updateStatusBar(state);
    };

    this.wsClient.onConnected = (clientId: string) => {
      console.log(`[ObsidianApiSync] Connected. Client ID: ${clientId}`);
      this.pullAllFiles();
    };

    this.wsClient.onError = (payload) => {
      new Notice(`⚠️ ObsidianApiSync error [${payload.code}]: ${payload.message}`);
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
      name: 'Pull all files from server',
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
                let contentStr = '';
                if (isBinary) {
                  const buffer = await this.app.vault.adapter.readBinary(path);
                  contentStr = this.arrayBufferToBase64(buffer);
                } else {
                  contentStr = await this.app.vault.adapter.read(path);
                }
                if (this.wsClient.getState() === WsState.CONNECTED) {
                  this.wsClient.sendFileModify(path, contentStr, isBinary);
                } else if (this.settings.serverUrl && this.settings.apiToken) {
                  await this.httpFallbackWriteRaw(path, contentStr, isBinary);
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
        const timer = setTimeout(async () => {
          this.modifyDebounceTimers.delete(file.path);
          if (this.wsClient.getState() === WsState.CONNECTED) {
            this.wsClient.sendFileModify(file.path, currentContent);
          } else if (this.settings.serverUrl && this.settings.apiToken) {
            await this.httpFallbackWriteRaw(file.path, currentContent);
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

        // If a timer is already running (e.g. from editor-change), don't override it
        if (this.modifyDebounceTimers.has(file.path)) return;

        const timer = setTimeout(async () => {
          this.modifyDebounceTimers.delete(file.path);
          const isBinary = this.isBinaryFile(file.path);
          let contentStr = '';
          if (isBinary) {
            const buffer = await this.app.vault.readBinary(file);
            contentStr = this.arrayBufferToBase64(buffer);
          } else {
            contentStr = await this.app.vault.read(file);
          }
          
          if (this.wsClient.getState() === WsState.CONNECTED) {
            this.wsClient.sendFileModify(file.path, contentStr, isBinary);
          } else if (this.settings.serverUrl && this.settings.apiToken) {
            await this.httpFallbackWrite(file, contentStr, isBinary);
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
          // Give Obsidian a tiny tick to finish writing the file to disk
          setTimeout(async () => {
            if (this.wsClient.getState() === WsState.CONNECTED) {
              const isBinary = this.isBinaryFile(file.path);
              let contentStr = '';
              if (isBinary) {
                const buffer = await this.app.vault.readBinary(file);
                contentStr = this.arrayBufferToBase64(buffer);
              } else {
                contentStr = await this.app.vault.read(file);
              }
              this.wsClient.sendFileModify(file.path, contentStr, isBinary);
            }
          }, 300);
        } else {
          // It's a folder
          if (this.wsClient.getState() === WsState.CONNECTED) {
            this.wsClient.sendFolderCreate(file.path);
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (!this.settings.syncOnModify) return;
        if (!this.shouldSyncPath(file.path, file instanceof TFolder)) return;
        if (this.wsClient.getState() === WsState.CONNECTED) {
          this.wsClient.sendFileDelete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!this.settings.syncOnModify) return;
        if (!this.shouldSyncPath(file.path, file instanceof TFolder)) return;
        if (this.wsClient.getState() === WsState.CONNECTED) {
          this.wsClient.sendFileRename(oldPath, file.path);
        }
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
      new Notice(messages[state] ?? `ObsidianApiSync state: ${state}`);
    });
  }

  onunload(): void {
    this.wsClient.disconnect();
  }

  // ─── Public Methods ─────────────────────────────────────────────────────────

  connectWs(): void {
    this.wsClient.connect(this.settings.serverUrl, this.settings.apiToken);
  }

  async pullAllFiles(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.apiToken) return;
    
    new Notice('ObsidianApiSync: Syncing files from server...');
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
        const remoteContent = item.content;
        
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
                updated++;
              }
            } else {
              this.remoteChangeLocks.set(path, Date.now() + 800);
              await this.ensureAdapterFolderExists(path);
              await this.app.vault.adapter.write(path, remoteContent);
              created++;
            }
          } catch(e) {
            this.showError("Failed to sync config file:", path, e);
          }
          continue;
        }

        if (!this.shouldSyncPath(path, false)) continue;
        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (localFile instanceof TFile) {
          let normalizedLocal = '';
          let normalizedRemote = '';
          if (item.is_binary) {
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
              // Local unsaved changes exist, do not overwrite from remote
              continue;
            }
            this.remoteChangeLocks.set(localFile.path, Date.now() + 800);
            if (item.is_binary) {
              await this.app.vault.modifyBinary(localFile, this.base64ToArrayBuffer(remoteContent));
            } else {
              await this.app.vault.modify(localFile, remoteContent);
            }
            updated++;
          }
        } else if (!localFile) {
          this.remoteChangeLocks.set(path, Date.now() + 800);
          await this.ensureFolderExists(path);
          if (item.is_binary) {
            await this.app.vault.createBinary(path, this.base64ToArrayBuffer(remoteContent));
          } else {
            await this.app.vault.create(path, remoteContent);
          }
          created++;
        }
      }
      
      if (created > 0 || updated > 0) {
        new Notice(`ObsidianApiSync Complete! Created: ${created}, Updated: ${updated}`);
      } else {
        new Notice('ObsidianApiSync Complete: Vault is up to date.');
      }
    } catch (err) {
      this.showError("Pull failed:", err);
      new Notice('ObsidianApiSync Failed. Check console.');
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
      new Notice(`⚠️ ObsidianApiSync HTTP fallback failed${(err as any)?.status ? " [" + (err as any).status + "]" : ""}: ${message}`);
      this.showError("HTTP fallback error:", err);
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

  async httpFallbackWriteRaw(path: string, contentStr: string, isBinary: boolean = false): Promise<void> {
    try {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      let body: string | ArrayBuffer = contentStr;
      if (isBinary) {
          body = this.base64ToArrayBuffer(contentStr);
      }
      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body,
      });
    } catch (err) {
      this.showError("HTTP fallback raw error:", err);
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
    console.error(`[ObsidianApiSync] ${context}:`, err);
    const status = (err as any)?.status ? ` [${(err as any).status}]` : "";
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`❌ ObsidianApiSync: ${context}${status} - ${msg}`);
  }
}