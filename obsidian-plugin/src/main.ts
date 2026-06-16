import { Plugin, TFile, TAbstractFile, Notice, requestUrl } from 'obsidian';
import { ObsidianApiSyncSettings, DEFAULT_SETTINGS } from './types';
import { ObsidianApiSyncWsClient, WsState, createWsClient } from './ws-client';
import { ObsidianApiSyncSettingTab } from './settings';
import { GDriveClient } from './gdrive-client';
import { SyncEngine } from './sync-engine';

export default class ObsidianApiSyncPlugin extends Plugin {
  settings!: ObsidianApiSyncSettings;
  wsClient!: ObsidianApiSyncWsClient;
  gdriveClient!: GDriveClient;
  syncEngine!: SyncEngine;
  private statusBarItem!: HTMLElement;
  private modifyDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private remoteChangeLocks: Map<string, number> = new Map();
  private syncTimerId: ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Init Server Mode Client
    this.wsClient = createWsClient();
    this.wsClient.setAutoReconnect(this.settings.autoReconnect);

    // Init Serverless GDrive Mode Clients
    this.gdriveClient = new GDriveClient(this);
    this.syncEngine = new SyncEngine(this.app, this.gdriveClient, this);

    this.setupWsCallbacks();

    // Settings Tab
    this.addSettingTab(new ObsidianApiSyncSettingTab(this.app, this));

    // Status Bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(WsState.DISCONNECTED);

    // Auto-connect on startup
    this.reconfigureSyncMode();

    // Commands
    this.addCommand({
      id: 'ObsidianApiSync-pull-all',
      name: 'Pull all files from server (Server Mode)',
      callback: () => this.pullAllFiles(),
    });

    this.addCommand({
      id: 'ObsidianApiSync-gdrive-sync',
      name: 'Sync Now (Google Drive Mode)',
      callback: () => {
        if (this.settings.syncMode === 'gdrive') {
          this.syncEngine.runSync(true);
        } else {
          new Notice('Not in Google Drive Sync Mode.');
        }
      },
    });

    this.setupVaultHooks();

    // Ribbon Icon
    this.addRibbonIcon('sync', 'Obsidian API Sync', () => {
      if (this.settings.syncMode === 'gdrive') {
        this.syncEngine.runSync(true);
      } else {
        const state = this.wsClient.getState();
        new Notice(`ObsidianApiSync Server state: ${state}`);
      }
    });
  }

  onunload(): void {
    this.wsClient.disconnect();
    if (this.syncTimerId) clearInterval(this.syncTimerId);
  }

  // ─── Modes & Control ────────────────────────────────────────────────────────

  reconfigureSyncMode() {
    if (this.syncTimerId) {
      clearInterval(this.syncTimerId);
      this.syncTimerId = null;
    }

    if (this.settings.syncMode === 'server') {
      if (this.settings.serverUrl && this.settings.apiToken) {
        this.connectWs();
      }
      this.updateStatusBar(this.wsClient.getState());
    } else if (this.settings.syncMode === 'gdrive') {
      this.wsClient.disconnect();
      this.statusBarItem.setText('☁ GDrive Sync Active');
      
      const intervalMs = (this.settings.autoSyncIntervalMins || 1) * 60 * 1000;
      this.syncTimerId = setInterval(() => {
        this.syncEngine.runSync(false);
      }, intervalMs);

      // Run an initial sync
      setTimeout(() => this.syncEngine.runSync(false), 5000);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.reconfigureSyncMode(); // Re-apply timers/connections if mode changed
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<ObsidianApiSyncSettings>
    );
  }

  // ─── Vault Hooks (Server Mode Only) ─────────────────────────────────────────

  private setupVaultHooks() {
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, info) => {
        if (this.settings.syncMode !== 'server' || !this.settings.syncOnModify) return;

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

    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        if (this.settings.syncMode !== 'server' || !this.settings.syncOnModify) return;
        if (!(file instanceof TFile)) return;
        
        const lockExpiry = this.remoteChangeLocks.get(file.path);
        if (lockExpiry && Date.now() < lockExpiry) return;

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

    this.registerEvent(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (this.settings.syncMode !== 'server' || !this.settings.syncOnModify) return;
        
        const lockExpiry = this.remoteChangeLocks.get(file.path);
        if (lockExpiry && Date.now() < lockExpiry) return;

        if (file instanceof TFile) {
          setTimeout(async () => {
            if (this.wsClient.getState() === WsState.CONNECTED) {
              const content = await this.app.vault.read(file);
              this.wsClient.sendFileModify(file.path, content);
            }
          }, 300);
        } else {
          if (this.wsClient.getState() === WsState.CONNECTED) {
            this.wsClient.sendFolderCreate(file.path);
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (this.settings.syncMode !== 'server' || !this.settings.syncOnModify) return;
        if (this.wsClient.getState() === WsState.CONNECTED) {
          this.wsClient.sendFileDelete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (this.settings.syncMode !== 'server' || !this.settings.syncOnModify) return;
        if (this.wsClient.getState() === WsState.CONNECTED) {
          this.wsClient.sendFileRename(oldPath, file.path);
        }
      })
    );
  }

  // ─── WebSocket Callbacks ────────────────────────────────────────────────────

  private setupWsCallbacks() {
    this.wsClient.onFileChanged = async (payload) => {
      if (this.settings.syncMode !== 'server') return;
      const file = this.app.vault.getAbstractFileByPath(payload.path);

      if (file instanceof TFile) {
        const currentContent = await this.app.vault.read(file);
        const normalizedLocal = currentContent.replace(/\r\n/g, '\n');
        const normalizedRemote = payload.content.replace(/\r\n/g, '\n');
        if (normalizedLocal !== normalizedRemote) {
          if (this.modifyDebounceTimers.has(file.path)) {
            clearTimeout(this.modifyDebounceTimers.get(file.path)!);
            this.modifyDebounceTimers.delete(file.path);
          }
          this.remoteChangeLocks.set(file.path, Date.now() + 800);
          try {
            await this.app.vault.modify(file, payload.content);
          } catch (err) {
            console.error('[ObsidianApiSync] modify failed', err);
          }
        }
      } else if (!file) {
        try {
          await this.ensureFolderExists(payload.path);
          await this.app.vault.create(payload.path, payload.content);
        } catch (err) {
          console.error('[ObsidianApiSync] Failed to create file:', err);
        }
      }
    };

    this.wsClient.onFolderCreated = async (payload) => {
      if (this.settings.syncMode !== 'server') return;
      const folder = this.app.vault.getAbstractFileByPath(payload.path);
      if (!folder) {
        this.remoteChangeLocks.set(payload.path, Date.now() + 800);
        await this.ensureFolderExists(payload.path);
      }
    };

    this.wsClient.onFileDeleted = async (payload) => {
      if (this.settings.syncMode !== 'server') return;
      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (file) {
        try {
          await this.app.vault.trash(file, false);
        } catch (err) {
          console.error('[ObsidianApiSync] Failed to process remote delete:', err);
        }
      }
    };

    this.wsClient.onFileRenamed = async (payload) => {
      if (this.settings.syncMode !== 'server') return;
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
      if (this.settings.syncMode === 'server') {
        this.updateStatusBar(state);
      }
    };

    this.wsClient.onConnected = (clientId: string) => {
      if (this.settings.syncMode === 'server') {
        this.pullAllFiles();
      }
    };

    this.wsClient.onError = (payload) => {
      new Notice(`⚠️ ObsidianApiSync error: ${payload.message}`);
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  connectWs(): void {
    if (this.settings.syncMode === 'server') {
      this.wsClient.connect(this.settings.serverUrl, this.settings.apiToken);
    }
  }

  async pullAllFiles(): Promise<void> {
    if (this.settings.syncMode !== 'server' || !this.settings.serverUrl) return;
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
        
        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (localFile instanceof TFile) {
          const localContent = await this.app.vault.read(localFile);
          if (localContent.replace(/\r\n/g, '\n') !== remoteContent.replace(/\r\n/g, '\n')) {
            if (this.modifyDebounceTimers.has(localFile.path)) {
              clearTimeout(this.modifyDebounceTimers.get(localFile.path)!);
              this.modifyDebounceTimers.delete(localFile.path);
            }
            this.remoteChangeLocks.set(localFile.path, Date.now() + 800);
            await this.app.vault.modify(localFile, remoteContent);
            updated++;
          }
        } else if (!localFile) {
          this.remoteChangeLocks.set(path, Date.now() + 800);
          await this.ensureFolderExists(path);
          await this.app.vault.create(path, remoteContent);
          created++;
        }
      }
      
      if (created > 0 || updated > 0) {
        new Notice(`ObsidianApiSync Complete! Created: ${created}, Updated: ${updated}`);
      } else {
        new Notice('ObsidianApiSync Complete: Vault is up to date.');
      }
    } catch (err) {
      new Notice('ObsidianApiSync Pull Failed.');
    }
  }

  async httpFallbackWrite(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const encodedPath = file.path.split('/').map((s) => encodeURIComponent(s)).join('/');
      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: content,
      });
    } catch (err) {}
  }

  private async ensureFolderExists(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop();
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath === '' ? part : `${currentPath}/${part}`;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        try { await this.app.vault.createFolder(currentPath); } catch (err) {}
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
