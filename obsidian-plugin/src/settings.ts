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
    syncObsidianFolder: boolean;
    excludeWorkspace: boolean;
    syncMode: 'include_all' | 'include_selected' | 'exclude_selected';
    selectiveSyncPaths: string;
    allowedExtensions: string;
  };
  wsClient: {
    getState(): WsState;
    setAutoReconnect(val: boolean): void;
    disconnect(): void;
  };
  saveSettings(): Promise<void>;
  connectWs(): void;
}

const TAB_DEFINITIONS = [
  { id: 'connection', label: '🔌 Connection' },
  { id: 'sync',       label: '⚙️ Sync' },
  { id: 'filters',    label: '🔍 Filters' },
  { id: 'configsync', label: '📂 Config Sync' },
] as const;

type TabId = typeof TAB_DEFINITIONS[number]['id'];

export class ObsidianApiSyncSettingTab extends PluginSettingTab {
  private plugin: ObsidianApiSyncPluginLike;
  private activeTab: TabId = 'connection';

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

    // ── Tab Bar ──────────────────────────────────────────────────────────────
    const tabBar = containerEl.createDiv();
    tabBar.style.cssText = [
      'display:flex',
      'gap:0',
      'border-bottom:1px solid var(--background-modifier-border)',
      'margin-bottom:20px',
      'overflow-x:auto',
    ].join(';');

    const contentEl = containerEl.createDiv();

    const renderTab = (id: TabId) => {
      this.activeTab = id;
      tabBar.querySelectorAll<HTMLButtonElement>('button[data-tab-id]').forEach(btn => {
        const isActive = btn.dataset.tabId === id;
        btn.style.borderBottom = isActive
          ? '2px solid var(--interactive-accent)'
          : '2px solid transparent';
        btn.style.color = isActive
          ? 'var(--interactive-accent)'
          : 'var(--text-muted)';
      });
      contentEl.empty();
      switch (id) {
        case 'connection': this.renderConnectionTab(contentEl); break;
        case 'sync':       this.renderSyncTab(contentEl); break;
        case 'filters':    this.renderFiltersTab(contentEl); break;
        case 'configsync': this.renderConfigSyncTab(contentEl); break;
      }
    };

    for (const tab of TAB_DEFINITIONS) {
      const btn = tabBar.createEl('button', { text: tab.label });
      btn.dataset.tabId = tab.id;
      btn.style.cssText = [
        'background:none',
        'border:none',
        'border-bottom:2px solid transparent',
        'padding:8px 16px',
        'cursor:pointer',
        'font-size:0.88em',
        'font-weight:500',
        'color:var(--text-muted)',
        'white-space:nowrap',
        'transition:color 0.15s,border-color 0.15s',
      ].join(';');
      btn.addEventListener('click', () => renderTab(tab.id as TabId));
    }

    renderTab(this.activeTab);
  }

  // ── Tab: Connection ─────────────────────────────────────────────────────────

  private renderConnectionTab(el: HTMLElement): void {

    // Quick Import
    el.createEl('h3', { text: '⚡ Quick Import' });
    const importDesc = el.createEl('p', {
      text: 'Paste the Base64 config string from the ObsidianApiSync Dashboard to auto-fill your Server URL and API Token.',
    });
    importDesc.style.color = 'var(--text-muted)';
    importDesc.style.fontSize = '0.9em';

    const importWrapper = el.createDiv();
    importWrapper.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:20px;';

    const textarea = importWrapper.createEl('textarea');
    textarea.placeholder = 'Paste Base64 config from ObsidianApiSync Dashboard…';
    textarea.rows = 3;
    textarea.style.cssText = 'flex:1;font-family:monospace;font-size:0.85em;resize:vertical;';

    const importBtn = importWrapper.createEl('button', { text: 'Import' });
    importBtn.style.cssText = 'align-self:flex-start;padding:4px 12px;';

    importBtn.addEventListener('click', async () => {
      const raw = textarea.value.trim();
      if (!raw) { new Notice('❌ Config string is empty'); return; }
      try {
        const decoded = atob(raw);
        const parsed = JSON.parse(decoded) as QuickImportConfig;
        if (typeof parsed.server !== 'string' || typeof parsed.token !== 'string' || !parsed.server || !parsed.token) {
          throw new Error('Missing server or token field');
        }
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

    // Server URL
    new Setting(el)
      .setName('Server URL')
      .setDesc('Base URL of the ObsidianApiSync API server (e.g. http://localhost:7010)')
      .addText(text =>
        text
          .setPlaceholder('http://localhost:7010')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async value => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // API Token
    new Setting(el)
      .setName('API Token')
      .setDesc('Bearer token used to authenticate with the ObsidianApiSync server.')
      .addText(text => {
        text
          .setPlaceholder('your-secret-token')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async value => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        return text;
      });

    new Setting(el)
      .setName('End-to-End Encryption Password')
      .setDesc('Optional. If set, encrypts your data before sending it to the server. WARNING: If you lose this password, your server data is unrecoverable!')
      .addText(text => {
        text
          .setPlaceholder('Encryption Password (leave blank to disable)')
          .setValue(this.plugin.settings.encryptionPassword || '')
          .onChange(async value => {
            this.plugin.settings.encryptionPassword = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        return text;
      });

    // Connection status
    el.createEl('h3', { text: 'Connection Status' });
    const statusDiv = el.createDiv();
    statusDiv.style.cssText = 'margin-bottom:8px;padding:8px 12px;border-radius:6px;background:var(--background-secondary);font-weight:600;';
    const state = this.plugin.wsClient.getState();
    const { label, color } = this.stateDisplay(state);
    statusDiv.setText(label);
    statusDiv.style.color = color;

    // Connect / Disconnect buttons
    new Setting(el)
      .setName('WebSocket Control')
      .setDesc('Manually connect or disconnect the live sync WebSocket.')
      .addButton(btn =>
        btn.setButtonText('Connect').setCta().onClick(() => {
          if (!this.plugin.settings.serverUrl || !this.plugin.settings.apiToken) {
            new Notice('❌ Please fill in Server URL and API Token first.');
            return;
          }
          this.plugin.connectWs();
          setTimeout(() => this.display(), 500);
        })
      )
      .addButton(btn =>
        btn.setButtonText('Disconnect').onClick(() => {
          this.plugin.wsClient.disconnect();
          setTimeout(() => this.display(), 200);
        })
      );
  }

  // ── Tab: Sync ───────────────────────────────────────────────────────────────

  private renderSyncTab(el: HTMLElement): void {
    new Setting(el)
      .setName('Sync on Modify')
      .setDesc('Automatically push changes to the server whenever a file is saved.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.syncOnModify)
          .onChange(async value => {
            this.plugin.settings.syncOnModify = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Sync Delay (ms)')
      .setDesc('Delay before sending changes. Lower values feel more instant but use more bandwidth. Recommended: 150–800ms.')
      .addSlider(slider =>
        slider
          .setLimits(50, 2000, 50)
          .setValue(this.plugin.settings.syncDebounceMs)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.syncDebounceMs = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Auto Reconnect')
      .setDesc('Automatically attempt to reconnect after an unexpected disconnection.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoReconnect)
          .onChange(async value => {
            this.plugin.settings.autoReconnect = value;
            this.plugin.wsClient.setAutoReconnect(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Base Reconnect Interval (ms)')
      .setDesc('Base delay for the first reconnect attempt. Subsequent attempts use exponential backoff (max 30 000 ms).')
      .addText(text =>
        text
          .setPlaceholder('3000')
          .setValue(String(this.plugin.settings.reconnectIntervalMs))
          .onChange(async value => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.reconnectIntervalMs = parsed;
              await this.plugin.saveSettings();
            }
          })
      );
  }

  // ── Tab: Filters ────────────────────────────────────────────────────────────

  private renderFiltersTab(el: HTMLElement): void {
    const desc = el.createEl('p', {
      text: 'Control exactly which files and folders get synced. These rules apply to both push and pull operations.',
    });
    desc.style.cssText = 'color:var(--text-muted);font-size:0.9em;margin-bottom:16px;';

    new Setting(el)
      .setName('Sync Mode')
      .setDesc('Choose whether to sync all files, only selected paths, or exclude selected paths.')
      .addDropdown(dropdown =>
        dropdown
          .addOption('include_all', 'Include All (Default)')
          .addOption('include_selected', 'Include Selected Paths Only')
          .addOption('exclude_selected', 'Exclude Selected Paths')
          .setValue(this.plugin.settings.syncMode)
          .onChange(async value => {
            this.plugin.settings.syncMode = value as never;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Selective Sync Paths')
      .setDesc('Folder or file paths to include or exclude (one per line). Example: "journal/" or "secret.md"')
      .addTextArea(text =>
        text
          .setPlaceholder('journal/\nattachments/\nsecret.md')
          .setValue(this.plugin.settings.selectiveSyncPaths)
          .onChange(async value => {
            this.plugin.settings.selectiveSyncPaths = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Allowed File Extensions')
      .setDesc('Comma-separated list of extensions to sync. Leave blank to allow all. Example: "md, canvas, pdf, png"')
      .addText(text =>
        text
          .setPlaceholder('md, canvas, pdf, png, jpg')
          .setValue(this.plugin.settings.allowedExtensions)
          .onChange(async value => {
            this.plugin.settings.allowedExtensions = value;
            await this.plugin.saveSettings();
          })
      );
  }

  // ── Tab: Config Sync ────────────────────────────────────────────────────────

  private renderConfigSyncTab(el: HTMLElement): void {
    const desc = el.createEl('p', {
      text: 'Sync Obsidian configuration files (plugins, themes, hotkeys) across your devices.',
    });
    desc.style.cssText = 'color:var(--text-muted);font-size:0.9em;margin-bottom:16px;';

    new Setting(el)
      .setName('Sync .obsidian folder (Plugins & Settings)')
      .setDesc('Sync your plugins, themes, and Obsidian settings across devices.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.syncObsidianFolder)
          .onChange(async value => {
            this.plugin.settings.syncObsidianFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Exclude workspace layout')
      .setDesc('Prevents workspace.json from syncing to avoid desktop/mobile layout conflicts.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.excludeWorkspace)
          .onChange(async value => {
            this.plugin.settings.excludeWorkspace = value;
            await this.plugin.saveSettings();
          })
      );
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private stateDisplay(state: WsState): { label: string; color: string } {
    switch (state) {
      case WsState.CONNECTED:    return { label: '🟢 Connected',     color: 'var(--color-green)' };
      case WsState.CONNECTING:   return { label: '🟡 Connecting…',   color: 'var(--color-yellow)' };
      case WsState.RECONNECTING: return { label: '🟡 Reconnecting…', color: 'var(--color-yellow)' };
      case WsState.DISCONNECTED:
      default:                   return { label: '🔴 Disconnected',  color: 'var(--color-red)' };
    }
  }
}
