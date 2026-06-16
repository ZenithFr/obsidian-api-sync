import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { WsState } from './ws-client';
import type { QuickImportConfig } from './types';

interface ObsidianApiSyncPluginLike {
  settings: any;
  wsClient: {
    getState(): WsState;
    setAutoReconnect(val: boolean): void;
    disconnect(): void;
  };
  saveSettings(): Promise<void>;
  connectWs(): void;
  // Methods for GDrive
  gdriveClient?: {
    startDeviceFlow(): Promise<void>;
    disconnect(): Promise<void>;
  };
  syncEngine?: {
    runSync(): Promise<void>;
  };
}

export class ObsidianApiSyncSettingTab extends PluginSettingTab {
  private plugin: ObsidianApiSyncPluginLike;

  constructor(app: App, plugin: ObsidianApiSyncPluginLike) {
    super(app, plugin as never);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Hermes Sync' });

    // ── Sync Mode Toggle ──────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Sync Architecture')
      .setDesc('Choose between connecting to a Hermes Python server or syncing directly to Google Drive.')
      .addDropdown(dropdown => {
        dropdown
          .addOption('server', 'Hermes Server (Real-time)')
          .addOption('gdrive', 'Google Drive Direct (1-min Polling)')
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (val) => {
            this.plugin.settings.syncMode = val;
            await this.plugin.saveSettings();
            // Re-render settings tab to show/hide relevant sections
            this.display();
          });
      });

    containerEl.createEl('br');

    if (this.plugin.settings.syncMode === 'server') {
      this.displayServerSettings(containerEl);
    } else {
      this.displayGDriveSettings(containerEl);
    }
  }

  private displayServerSettings(containerEl: HTMLElement) {
    containerEl.createEl('h3', { text: 'Server Settings (Real-time)' });

    // ── Quick Import ─────────────────────────────────────────────────────────
    const importDesc = containerEl.createEl('p', {
      text: 'Paste the Base64 config string from the Dashboard to auto-fill your Server URL and API Token.',
    });
    importDesc.style.color = 'var(--text-muted)';
    importDesc.style.fontSize = '0.9em';

    const importWrapper = containerEl.createDiv();
    importWrapper.style.display = 'flex';
    importWrapper.style.gap = '8px';
    importWrapper.style.alignItems = 'flex-start';
    importWrapper.style.marginBottom = '16px';

    const textarea = importWrapper.createEl('textarea');
    textarea.placeholder = 'Paste Base64 config from Dashboard…';
    textarea.rows = 3;
    textarea.style.flex = '1';
    textarea.style.fontFamily = 'monospace';
    textarea.style.fontSize = '0.85em';
    textarea.style.resize = 'vertical';

    const importBtn = importWrapper.createEl('button', { text: 'Import' });
    importBtn.style.alignSelf = 'flex-start';
    importBtn.style.padding = '4px 12px';

    importBtn.addEventListener('click', async () => {
      const raw = textarea.value.trim();
      if (!raw) {
        new Notice('❌ Config string is empty');
        return;
      }
      try {
        const decoded = atob(raw);
        const parsed = JSON.parse(decoded) as QuickImportConfig;
        if (!parsed.server || !parsed.token) throw new Error('Missing fields');
        this.plugin.settings.serverUrl = parsed.server;
        this.plugin.settings.apiToken = parsed.token;
        await this.plugin.saveSettings();
        textarea.value = '';
        new Notice('✅ Config imported successfully');
        this.display();
      } catch {
        new Notice('❌ Invalid config string');
      }
    });

    // ── Server URL ────────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Base URL of the server (e.g. http://localhost:8000)')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:8000')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── API Token ─────────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('API Token')
      .setDesc('Bearer token used to authenticate with the server.')
      .addText((text) => {
        text
          .setPlaceholder('your-secret-token')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        return text;
      });

    // ── Sync on Modify ────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Sync on Modify')
      .setDesc('Automatically push changes to the server whenever a file is saved.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnModify)
          .onChange(async (value) => {
            this.plugin.settings.syncOnModify = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Sync Delay (ms)')
      .addSlider((slider) =>
        slider
          .setLimits(50, 2000, 50)
          .setValue(this.plugin.settings.syncDebounceMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncDebounceMs = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto Reconnect')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoReconnect)
          .onChange(async (value) => {
            this.plugin.settings.autoReconnect = value;
            this.plugin.wsClient.setAutoReconnect(value);
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: 'Connection' });
    const statusDiv = containerEl.createDiv();
    statusDiv.style.padding = '8px 12px';
    statusDiv.style.borderRadius = '6px';
    statusDiv.style.backgroundColor = 'var(--background-secondary)';
    statusDiv.style.fontWeight = '600';

    const state = this.plugin.wsClient.getState();
    const { label, color } = this.stateDisplay(state);
    statusDiv.setText(label);
    statusDiv.style.color = color;

    new Setting(containerEl)
      .setName('WebSocket Control')
      .addButton((btn) =>
        btn
          .setButtonText('Connect')
          .setCta()
          .onClick(() => {
            this.plugin.connectWs();
            setTimeout(() => this.display(), 500);
          })
      )
      .addButton((btn) =>
        btn.setButtonText('Disconnect').onClick(() => {
          this.plugin.wsClient.disconnect();
          setTimeout(() => this.display(), 200);
        })
      );
  }

  private displayGDriveSettings(containerEl: HTMLElement) {
    containerEl.createEl('h3', { text: 'Google Drive Direct (Serverless)' });

    const isConnected = !!this.plugin.settings.gdriveRefreshToken;

    if (isConnected) {
      const statusDiv = containerEl.createDiv();
      statusDiv.style.padding = '8px 12px';
      statusDiv.style.borderRadius = '6px';
      statusDiv.style.backgroundColor = 'var(--color-green)';
      statusDiv.style.color = '#fff';
      statusDiv.style.fontWeight = '600';
      statusDiv.setText(`✓ Connected as: ${this.plugin.settings.gdriveEmail}`);

      new Setting(containerEl)
        .setName('Drive Folder')
        .setDesc('The folder inside Google Drive that acts as your vault root.')
        .addText(text => text
          .setPlaceholder('ObsidianVault')
          .setValue(this.plugin.settings.gdriveFolderName || '')
          .onChange(async (val) => {
            this.plugin.settings.gdriveFolderName = val;
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName('Auto-Sync Interval (Minutes)')
        .setDesc('How often to check Google Drive for changes and push local edits.')
        .addSlider(slider => slider
          .setLimits(1, 15, 1)
          .setValue(this.plugin.settings.autoSyncIntervalMins || 1)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.autoSyncIntervalMins = val;
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName('Force Sync')
        .setDesc('Manually trigger a sync cycle right now.')
        .addButton(btn => btn
          .setButtonText('Sync Now')
          .setCta()
          .onClick(async () => {
            if (this.plugin.syncEngine) {
              await this.plugin.syncEngine.runSync();
              this.display();
            }
          })
        );

      new Setting(containerEl)
        .setName('Disconnect Google Drive')
        .addButton(btn => btn
          .setButtonText('Disconnect')
          .setWarning()
          .onClick(async () => {
            if (this.plugin.gdriveClient) {
              await this.plugin.gdriveClient.disconnect();
              this.display();
            }
          })
        );
    } else {
      const desc = containerEl.createEl('p', {
        text: 'Sync your vault directly to your Google Drive account. No Python server required. You will be provided a secure code to log in via your browser.',
      });
      desc.style.color = 'var(--text-muted)';

      new Setting(containerEl)
        .setName('Login with Google')
        .setDesc('Start the secure device login flow.')
        .addButton(btn => btn
          .setButtonText('Start Login')
          .setCta()
          .onClick(async () => {
            if (this.plugin.gdriveClient) {
              // startDeviceFlow will handle the modal popup
              await this.plugin.gdriveClient.startDeviceFlow(() => {
                this.display();
              });
            } else {
              new Notice("GDrive client not initialized");
            }
          })
        );
    }
  }

  private stateDisplay(state: WsState): { label: string; color: string } {
    switch (state) {
      case WsState.CONNECTED:
        return { label: '🟢 Connected', color: 'var(--color-green)' };
      case WsState.CONNECTING:
        return { label: '🟡 Connecting…', color: 'var(--color-yellow)' };
      case WsState.RECONNECTING:
        return { label: '🟡 Reconnecting…', color: 'var(--color-yellow)' };
      case WsState.DISCONNECTED:
      default:
        return { label: '🔴 Disconnected', color: 'var(--color-red)' };
    }
  }
}
