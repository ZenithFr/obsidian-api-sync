import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { WsState } from './ws-client';
import type { QuickImportConfig } from './types';

/**
 * Minimal interface describing the parts of ObsidianApiSyncPlugin that
 * ObsidianApiSyncSettingTab needs — avoids a circular import cycle.
 */
interface ObsidianApiSyncPluginLike {
  settings: {
    serverUrl: string;
    apiToken: string;
    syncOnModify: boolean;
    syncDebounceMs: number;
    autoReconnect: boolean;
    reconnectIntervalMs: number;
  };
  wsClient: {
    getState(): WsState;
    setAutoReconnect(val: boolean): void;
    disconnect(): void;
  };
  saveSettings(): Promise<void>;
  connectWs(): void;
}

export class ObsidianApiSyncSettingTab extends PluginSettingTab {
  private plugin: ObsidianApiSyncPluginLike;

  constructor(app: App, plugin: ObsidianApiSyncPluginLike) {
    // PluginSettingTab requires a Plugin instance; the interface is compatible
    // at runtime because ObsidianApiSyncPlugin extends Plugin.
    super(app, plugin as never);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'ObsidianApiSync Vault Sync' });

    // ── Quick Import ─────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '⚡ Quick Import' });

    const importDesc = containerEl.createEl('p', {
      text: 'Paste the Base64 config string from the ObsidianApiSync Dashboard to auto-fill your Server URL and API Token.',
    });
    importDesc.style.color = 'var(--text-muted)';
    importDesc.style.fontSize = '0.9em';

    const importWrapper = containerEl.createDiv();
    importWrapper.style.display = 'flex';
    importWrapper.style.gap = '8px';
    importWrapper.style.alignItems = 'flex-start';
    importWrapper.style.marginBottom = '16px';

    const textarea = importWrapper.createEl('textarea');
    textarea.placeholder = 'Paste Base64 config from ObsidianApiSync Dashboard…';
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

        if (
          typeof parsed.server !== 'string' ||
          typeof parsed.token !== 'string' ||
          !parsed.server ||
          !parsed.token
        ) {
          throw new Error('Missing server or token field');
        }

        this.plugin.settings.serverUrl = parsed.server;
        this.plugin.settings.apiToken = parsed.token;
        await this.plugin.saveSettings();

        textarea.value = '';
        new Notice('✅ Config imported successfully');

        // Re-render the tab so new values appear in the fields below
        this.display();
      } catch {
        new Notice('❌ Invalid config string');
      }
    });

    // ── Server URL ────────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Base URL of the ObsidianApiSync API server (e.g. http://localhost:7010)')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:7010')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── API Token ─────────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('API Token')
      .setDesc('Bearer token used to authenticate with the ObsidianApiSync server.')
      .addText((text) => {
        text
          .setPlaceholder('your-secret-token')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          });

        // Make this field behave like a password input
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
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

    // ── Sync Delay (ms) ───────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Sync Delay (ms)')
      .setDesc('Delay before sending changes. Lower values feel more instant (letter-by-letter) but use more bandwidth. High values (800ms) save bandwidth.')
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

    // ── Auto Reconnect ────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Auto Reconnect')
      .setDesc('Automatically attempt to reconnect after an unexpected disconnection.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoReconnect)
          .onChange(async (value) => {
            this.plugin.settings.autoReconnect = value;
            this.plugin.wsClient.setAutoReconnect(value);
            await this.plugin.saveSettings();
          })
      );

    // ── Reconnect Interval ────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Base Reconnect Interval (ms)')
      .setDesc(
        'Base delay in milliseconds for the first reconnect attempt. Subsequent attempts use exponential backoff (max 30 000 ms).'
      )
      .addText((text) =>
        text
          .setPlaceholder('3000')
          .setValue(String(this.plugin.settings.reconnectIntervalMs))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.reconnectIntervalMs = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    // ── Connection Status ─────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Connection' });

    const statusDiv = containerEl.createDiv();
    statusDiv.style.marginBottom = '8px';
    statusDiv.style.padding = '8px 12px';
    statusDiv.style.borderRadius = '6px';
    statusDiv.style.backgroundColor = 'var(--background-secondary)';
    statusDiv.style.fontWeight = '600';

    const state = this.plugin.wsClient.getState();
    const { label, color } = this.stateDisplay(state);
    statusDiv.setText(label);
    statusDiv.style.color = color;

    // ── Connect / Disconnect buttons ──────────────────────────────────────────
    new Setting(containerEl)
      .setName('WebSocket Control')
      .setDesc('Manually connect or disconnect the live sync WebSocket.')
      .addButton((btn) =>
        btn
          .setButtonText('Connect')
          .setCta()
          .onClick(() => {
            if (!this.plugin.settings.serverUrl || !this.plugin.settings.apiToken) {
              new Notice('❌ Please fill in Server URL and API Token first.');
              return;
            }
            this.plugin.connectWs();
            // Slight delay then re-render so status indicator updates
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
