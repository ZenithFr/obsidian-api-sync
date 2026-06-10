import { Plugin, TFile, Notice, requestUrl } from 'obsidian';
import { ObsidianApiSyncSettings, DEFAULT_SETTINGS } from './types';
import { ObsidianApiSyncWsClient, WsState, createWsClient } from './ws-client';
import { ObsidianApiSyncSettingTab } from './settings';

export default class ObsidianApiSyncPlugin extends Plugin {
  settings!: ObsidianApiSyncSettings;
  wsClient!: ObsidianApiSyncWsClient;
  private statusBarItem!: HTMLElement;
  private modifyDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Create WebSocket client
    this.wsClient = createWsClient();
    this.wsClient.setAutoReconnect(this.settings.autoReconnect);

    // ── WS Callbacks ──────────────────────────────────────────────────────────

    this.wsClient.onFileChanged = async (payload) => {
      const file = this.app.vault.getAbstractFileByPath(payload.path);

      if (file instanceof TFile) {
        // Echo-loop prevention: only write if content actually differs
        const currentContent = await this.app.vault.read(file);
        const normalizedLocal = currentContent.replace(/\r\n/g, '\n');
        const normalizedRemote = payload.content.replace(/\r\n/g, '\n');
        if (normalizedLocal !== normalizedRemote) {
          await this.app.vault.modify(file, payload.content);
        }
      } else if (!file) {
        // File doesn't exist locally yet — create it
        try {
          await this.ensureFolderExists(payload.path);
          await this.app.vault.create(payload.path, payload.content);
        } catch (err) {
          console.error('[ObsidianApiSync] Failed to create file from remote change:', err);
        }
      }
    };

    this.wsClient.onFileDeleted = async (payload) => {
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

    // ── Vault Events ──────────────────────────────────────────────────────────
    this.registerEvent(
      this.app.vault.on('modify', (file: TFile) => {
        if (!this.settings.syncOnModify) return;

        if (this.modifyDebounceTimers.has(file.path)) {
          clearTimeout(this.modifyDebounceTimers.get(file.path)!);
        }

        const timer = setTimeout(async () => {
          this.modifyDebounceTimers.delete(file.path);
          if (this.wsClient.getState() === WsState.CONNECTED) {
            const content = await this.app.vault.read(file);
            this.wsClient.sendFileModify(file.path, content);
          } else if (this.settings.serverUrl && this.settings.apiToken) {
            await this.httpFallbackWrite(file);
          }
        }, 800);

        this.modifyDebounceTimers.set(file.path, timer);
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file: TFile) => {
        if (!this.settings.syncOnModify) return;
        if (this.wsClient.getState() === WsState.CONNECTED) {
          this.wsClient.sendFileDelete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TFile, oldPath: string) => {
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

      for (const item of data.files) {
        const path = item.path;
        const remoteContent = item.content;
        
        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (localFile instanceof TFile) {
          const localContent = await this.app.vault.read(localFile);
          const normalizedLocal = localContent.replace(/\r\n/g, '\n');
          const normalizedRemote = remoteContent.replace(/\r\n/g, '\n');
          if (normalizedLocal !== normalizedRemote) {
            await this.app.vault.modify(localFile, remoteContent);
            updated++;
          }
        } else if (!localFile) {
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
      console.error('[ObsidianApiSync] Pull failed:', err);
      new Notice('ObsidianApiSync Failed. Check console.');
    }
  }

  async httpFallbackWrite(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);

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
        body: content,
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
