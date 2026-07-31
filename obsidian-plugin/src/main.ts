import { Plugin, TFile, TAbstractFile, Notice, requestUrl } from 'obsidian';
import { ObsidianApiSyncSettings, DEFAULT_SETTINGS } from './types';
import { ObsidianApiSyncWsClient, WsState, createWsClient } from './ws-client';
import { ObsidianApiSyncSettingTab } from './settings';

export default class ObsidianApiSyncPlugin extends Plugin {
  settings!: ObsidianApiSyncSettings;
  wsClient!: ObsidianApiSyncWsClient;
  private statusBarItem!: HTMLElement;
  private modifyDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private remoteChangeLocks: Map<string, number> = new Map();

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Create WebSocket client
    this.wsClient = createWsClient();
    this.wsClient.setAutoReconnect(this.settings.autoReconnect);

    // ── WS Callbacks ──────────────────────────────────────────────────────────

    this.wsClient.onFileChanged = async (payload) => {
      const isBinary = payload.content === null;
      let remoteContent: string | null = null;
      let remoteBuffer: ArrayBuffer | null = null;
      
      if (isBinary) {
          const encodedPath = payload.path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
          const res = await requestUrl({
              url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
              headers: { Authorization: `Bearer ${this.settings.apiToken}` }
          });
          remoteBuffer = res.arrayBuffer;
      } else {
          remoteContent = payload.content;
      }

      if (payload.path.startsWith(this.app.vault.configDir + '/')) {
        if (!this.settings.syncObsidianFolder) return;
        if (this.settings.excludeWorkspace && payload.path === `${this.app.vault.configDir}/workspace.json`) return;
        if (payload.path === `${this.app.vault.configDir}/plugins/obsidian-api-sync/data.json`) return;
        
        try {
          const exists = await this.app.vault.adapter.exists(payload.path);
          if (exists) {
            let changed = false;
            if (isBinary) {
                const localBytes = await this.app.vault.adapter.readBinary(payload.path);
                if (localBytes.byteLength !== remoteBuffer!.byteLength) {
                    changed = true;
                } else {
                    const localArr = new Uint8Array(localBytes);
                    const remoteArr = new Uint8Array(remoteBuffer!);
                    for (let i = 0; i < localArr.length; i++) {
                        if (localArr[i] !== remoteArr[i]) {
                            changed = true;
                            break;
                        }
                    }
                }
            } else {
                const currentContent = await this.app.vault.adapter.read(payload.path);
                const normalizedLocal = currentContent.replace(/\r\n/g, '\n');
                const normalizedRemote = remoteContent!.replace(/\r\n/g, '\n');
                changed = normalizedLocal !== normalizedRemote;
            }

            if (changed) {
              if (this.modifyDebounceTimers.has(payload.path)) {
                clearTimeout(this.modifyDebounceTimers.get(payload.path)!);
                this.modifyDebounceTimers.delete(payload.path);
              }
              this.remoteChangeLocks.set(payload.path, Date.now() + 800);
              if (isBinary) {
                  await this.app.vault.adapter.writeBinary(payload.path, remoteBuffer!);
              } else {
                  await this.app.vault.adapter.write(payload.path, remoteContent!);
              }
            }
          } else {
            await this.ensureAdapterFolderExists(payload.path);
            if (isBinary) {
                await this.app.vault.adapter.writeBinary(payload.path, remoteBuffer!);
            } else {
                await this.app.vault.adapter.write(payload.path, remoteContent!);
            }
          }
        } catch (err) {
          console.error('[ObsidianApiSync] Failed to process remote .obsidian change:', err);
        }
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(payload.path);

      if (file instanceof TFile) {
        let changed = false;
        if (isBinary) {
            const localBytes = await this.app.vault.readBinary(file);
            if (localBytes.byteLength !== remoteBuffer!.byteLength) {
                changed = true;
            } else {
                const localArr = new Uint8Array(localBytes);
                const remoteArr = new Uint8Array(remoteBuffer!);
                for (let i = 0; i < localArr.length; i++) {
                    if (localArr[i] !== remoteArr[i]) {
                        changed = true;
                        break;
                    }
                }
            }
        } else {
            const currentContent = await this.app.vault.read(file);
            const normalizedLocal = currentContent.replace(/\\r\\n/g, '\\n');
            const normalizedRemote = remoteContent!.replace(/\\r\\n/g, '\\n');
            changed = normalizedLocal !== normalizedRemote;
        }

        if (changed) {
          if (this.modifyDebounceTimers.has(file.path)) {
            clearTimeout(this.modifyDebounceTimers.get(file.path)!);
            this.modifyDebounceTimers.delete(file.path);
          }
          this.remoteChangeLocks.set(file.path, Date.now() + 800);
          try {
            if (isBinary) {
                await this.app.vault.modifyBinary(file, remoteBuffer!);
            } else {
                await this.app.vault.modify(file, remoteContent!);
            }
          } catch (err) {
            console.error('[ObsidianApiSync] modify failed', err);
          }
        }
      } else if (!file) {
        try {
          await this.ensureFolderExists(payload.path);
          if (isBinary) {
              await this.app.vault.createBinary(payload.path, remoteBuffer!);
          } else {
              await this.app.vault.create(payload.path, remoteContent!);
          }
        } catch (err) {
          console.error('[ObsidianApiSync] Failed to create file from remote change:', err);
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
          if (exists) {
            const stat = await this.app.vault.adapter.stat(payload.path);
            if (stat && stat.type === 'folder') {
              await this.app.vault.adapter.rmdir(payload.path, true);
            } else {
              await this.app.vault.adapter.remove(payload.path);
            }
          }
        } catch (err) {
          console.error('[ObsidianApiSync] Failed to process remote .obsidian delete:', err);
        }
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (file) {
        try {
          await this.app.vault.trash(file, false); // move to system trash
        } catch (err) {
          console.error('[ObsidianApiSync] Failed to process remote delete:', err);
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
          console.error('[ObsidianApiSync] Failed to process remote .obsidian rename:', err);
        }
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(payload.old_path);
      if (file) {
        try {
          await this.ensureFolderExists(payload.new_path);
          await this.app.vault.rename(file, payload.new_path);
        } catch (err) {
          console.error('[ObsidianApiSync] Failed to process remote rename:', err);
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
                const content = await this.app.vault.adapter.read(path);
                if (this.wsClient.getState() === WsState.CONNECTED) {
                  this.wsClient.sendFileModify(path, content);
                } else if (this.settings.serverUrl && this.settings.apiToken) {
                  await this.httpFallbackWriteRaw(path, content);
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

        const lockExpiry = this.remoteChangeLocks.get(file.path);
        if (lockExpiry && Date.now() < lockExpiry) return;

        if (this.modifyDebounceTimers.has(file.path)) {
          clearTimeout(this.modifyDebounceTimers.get(file.path)!);
        }

        const timer = setTimeout(async () => {
          this.modifyDebounceTimers.delete(file.path);
          if (this.wsClient.getState() === WsState.CONNECTED) {
            const content = editor.getValue();
            this.wsClient.sendFileModify(file.path, content);
          } else if (this.settings.serverUrl && this.settings.apiToken) {
            await this.httpFallbackWrite(file);
          }
        }, this.settings.syncDebounceMs || 150);

        this.modifyDebounceTimers.set(file.path, timer);
      })
    );

    // 2. Fallback for non-editor modifications (e.g. other plugins or syncing)
    this.registerEvent(
      this.app.vault.on('modify', async (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.settings.syncOnModify) return;
        
        const lockExpiry = this.remoteChangeLocks.get(file.path);
        if (lockExpiry && Date.now() < lockExpiry) return; // ignore our own remote updates

        // If a timer is already running (e.g. from editor-change), don't override it
        if (this.modifyDebounceTimers.has(file.path)) return;

        const timer = setTimeout(async () => {
          this.modifyDebounceTimers.delete(file.path);
          if (this.wsClient.getState() === WsState.CONNECTED) {
            const content = await this.app.vault.read(file);
            this.wsClient.sendFileModify(file.path, content);
          } else if (this.settings.serverUrl && this.settings.apiToken) {
            await this.httpFallbackWrite(file);
          }
        }, this.settings.syncDebounceMs || 150);

        this.modifyDebounceTimers.set(file.path, timer);
      })
    );

    // 3. New File Creation
    this.registerEvent(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (!this.settings.syncOnModify) return;
        
        const lockExpiry = this.remoteChangeLocks.get(file.path);
        if (lockExpiry && Date.now() < lockExpiry) return;

        if (file instanceof TFile) {
          // Give Obsidian a tiny tick to finish writing the file to disk
          setTimeout(async () => {
            if (this.wsClient.getState() === WsState.CONNECTED) {
              const content = await this.app.vault.read(file);
              this.wsClient.sendFileModify(file.path, content);
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
        if (this.wsClient.getState() === WsState.CONNECTED) {
          this.wsClient.sendFileDelete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!this.settings.syncOnModify) return;
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

      // Helper to convert base64 to ArrayBuffer
      const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
        const binaryString = window.atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      };

      for (const item of data.files) {
        const path = item.path;
        const isBinary = item.content_base64 !== undefined;
        let remoteContent: string | null = null;
        let remoteBuffer: ArrayBuffer | null = null;
        if (isBinary) {
            remoteBuffer = base64ToArrayBuffer(item.content_base64);
        } else {
            remoteContent = item.content;
        }
        
        // Handle Obsidian settings/plugins folder
        if (path.startsWith(this.app.vault.configDir + '/')) {
          if (!this.settings.syncObsidianFolder) continue;
          if (this.settings.excludeWorkspace && path === `${this.app.vault.configDir}/workspace.json`) continue;
          if (path === `${this.app.vault.configDir}/plugins/obsidian-api-sync/data.json`) continue;
          
          try {
            const exists = await this.app.vault.adapter.exists(path);
            if (exists) {
              let changed = false;
              if (isBinary) {
                const localBytes = await this.app.vault.adapter.readBinary(path);
                if (localBytes.byteLength !== remoteBuffer!.byteLength) {
                    changed = true;
                } else {
                    const localArr = new Uint8Array(localBytes);
                    const remoteArr = new Uint8Array(remoteBuffer!);
                    for (let i = 0; i < localArr.length; i++) {
                        if (localArr[i] !== remoteArr[i]) {
                            changed = true;
                            break;
                        }
                    }
                }
              } else {
                const localContent = await this.app.vault.adapter.read(path);
                const normalizedLocal = localContent.replace(/\r\n/g, '\n');
                const normalizedRemote = remoteContent!.replace(/\r\n/g, '\n');
                changed = normalizedLocal !== normalizedRemote;
              }

              if (changed) {
                if (this.modifyDebounceTimers.has(path)) {
                  clearTimeout(this.modifyDebounceTimers.get(path)!);
                  this.modifyDebounceTimers.delete(path);
                }
                this.remoteChangeLocks.set(path, Date.now() + 800);
                if (isBinary) {
                  await this.app.vault.adapter.writeBinary(path, remoteBuffer!);
                } else {
                  await this.app.vault.adapter.write(path, remoteContent!);
                }
                updated++;
              }
            } else {
              this.remoteChangeLocks.set(path, Date.now() + 800);
              await this.ensureAdapterFolderExists(path);
              if (isBinary) {
                await this.app.vault.adapter.writeBinary(path, remoteBuffer!);
              } else {
                await this.app.vault.adapter.write(path, remoteContent!);
              }
              created++;
            }
          } catch(e) {
            console.error('[ObsidianApiSync] Failed to sync config file:', path, e);
          }
          continue;
        }
        const localFile = this.app.vault.getAbstractFileByPath(path);
        
        if (localFile instanceof TFile) {
          let changed = false;
          if (isBinary) {
            const localBytes = await this.app.vault.readBinary(localFile);
            const remoteBuffer = base64ToArrayBuffer(item.content_base64);
            if (localBytes.byteLength !== remoteBuffer.byteLength) {
                changed = true;
            } else {
                const localArr = new Uint8Array(localBytes);
                const remoteArr = new Uint8Array(remoteBuffer);
                for (let i = 0; i < localArr.length; i++) {
                    if (localArr[i] !== remoteArr[i]) {
                        changed = true;
                        break;
                    }
                }
            }
            if (changed) {
              if (this.modifyDebounceTimers.has(localFile.path)) {
                clearTimeout(this.modifyDebounceTimers.get(localFile.path)!);
                this.modifyDebounceTimers.delete(localFile.path);
              }
              this.remoteChangeLocks.set(localFile.path, Date.now() + 800);
              await this.app.vault.modifyBinary(localFile, remoteBuffer);
              updated++;
            }
          } else {
            const remoteContent = item.content;
            const localContent = await this.app.vault.read(localFile);
            const normalizedLocal = localContent.replace(/\\r\\n/g, '\\n');
            const normalizedRemote = remoteContent.replace(/\\r\\n/g, '\\n');
            if (normalizedLocal !== normalizedRemote) {
              if (this.modifyDebounceTimers.has(localFile.path)) {
                clearTimeout(this.modifyDebounceTimers.get(localFile.path)!);
                this.modifyDebounceTimers.delete(localFile.path);
              }
              this.remoteChangeLocks.set(localFile.path, Date.now() + 800);
              await this.app.vault.modify(localFile, remoteContent);
              updated++;
            }
          }
        } else if (!localFile) {
          this.remoteChangeLocks.set(path, Date.now() + 800);
          await this.ensureFolderExists(path);
          if (isBinary) {
            await this.app.vault.createBinary(path, base64ToArrayBuffer(item.content_base64));
          } else {
            await this.app.vault.create(path, item.content);
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
      console.error('[ObsidianApiSync] Pull failed:', err);
      // Gracefully inform the user that no updates were pulled, ensuring a professional and seamless experience.
      new Notice('ObsidianApiSync: Vault is up to date (No new updates found).');
    }
  }

  async httpFallbackWrite(file: TFile): Promise<void> {
    try {
      const isBinary = !['md', 'txt', 'csv', 'json', 'yaml', 'yml'].includes(file.extension.toLowerCase());
      
      let body: string | ArrayBuffer;
      let contentType: string;
      if (isBinary) {
          body = await this.app.vault.readBinary(file);
          contentType = 'application/octet-stream';
      } else {
          body = await this.app.vault.read(file);
          contentType = 'text/plain';
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
          'Content-Type': contentType,
        },
        body: body,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      new Notice(`⚠️ ObsidianApiSync HTTP fallback failed: ${message}`);
      console.error('[ObsidianApiSync] HTTP fallback error:', err);
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

  async httpFallbackWriteRaw(path: string, content: string): Promise<void> {
    try {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: content,
      });
    } catch (err) {
      console.error('[ObsidianApiSync] HTTP fallback raw error:', err);
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
}
