import { App, Modal, Notice, requestUrl, TFile } from 'obsidian';
import type ObsidianApiSyncPlugin from './main';

interface TrashedFile {
    ts: number;
    date: string;
    original_path: string;
    trash_path: string;
    size: number;
}

export class TrashRecoveryModal extends Modal {
    plugin: ObsidianApiSyncPlugin;
    trashedFiles: TrashedFile[] = [];

    constructor(app: App, plugin: ObsidianApiSyncPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Recover Deleted Files' });

        if (!this.plugin.settings.serverUrl || !this.plugin.settings.apiToken) {
            contentEl.createEl('p', { text: 'Server URL or API Token not configured.' });
            return;
        }

        const loadingEl = contentEl.createEl('p', { text: 'Loading deleted files...' });

        try {
            const resp = await requestUrl({
                url: `${this.plugin.settings.serverUrl.replace(/\/$/, '')}/api/history/trash`,
                headers: { Authorization: `Bearer ${this.plugin.settings.apiToken}` }
            });
            this.trashedFiles = resp.json.trash || [];
            loadingEl.remove();

            if (this.trashedFiles.length === 0) {
                contentEl.createEl('p', { text: 'No deleted files found.' });
                return;
            }

            const list = contentEl.createEl('ul');
            for (const file of this.trashedFiles) {
                const li = list.createEl('li');
                li.style.marginBottom = '10px';
                li.createEl('span', { text: `${new Date(file.ts).toLocaleString()} - ${file.original_path}` });
                
                const restoreBtn = li.createEl('button', { text: 'Restore' });
                restoreBtn.style.marginLeft = '10px';
                restoreBtn.onclick = async () => {
                    await this.restoreTrash(file.trash_path, file.original_path);
                    this.close();
                };
            }
        } catch (err) {
            loadingEl.remove();
            contentEl.createEl('p', { text: 'Failed to load deleted files.' });
            console.error(err);
        }
    }

    async restoreTrash(trashPath: string, originalPath: string) {
        try {
            const encodedTrashPath = encodeURIComponent(trashPath);
            const encodedOriginalPath = encodeURIComponent(originalPath);
            const resp = await requestUrl({
                url: `${this.plugin.settings.serverUrl.replace(/\/$/, '')}/api/history/restore-trash?trash_path=${encodedTrashPath}&original_path=${encodedOriginalPath}`,
                method: 'POST',
                headers: { Authorization: `Bearer ${this.plugin.settings.apiToken}` }
            });
            if (resp.status === 200) {
                new Notice(`Restored ${originalPath}`);
                this.plugin.pullAllFiles(); // pull changes to get the restored file
            }
        } catch (err) {
            new Notice(`Failed to restore ${originalPath}`);
            console.error(err);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

interface FileVersion {
    ts: number;
    date: string;
    path: string;
    size: number;
}

export class VersionHistoryModal extends Modal {
    plugin: ObsidianApiSyncPlugin;
    activeFilePath: string | null;
    versions: FileVersion[] = [];

    constructor(app: App, plugin: ObsidianApiSyncPlugin, activeFilePath: string | null) {
        super(app);
        this.plugin = plugin;
        this.activeFilePath = activeFilePath;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        if (!this.activeFilePath) {
            contentEl.createEl('h2', { text: 'Version History' });
            contentEl.createEl('p', { text: 'No active file selected.' });
            return;
        }

        contentEl.createEl('h2', { text: `Version History: ${this.activeFilePath}` });

        if (!this.plugin.settings.serverUrl || !this.plugin.settings.apiToken) {
            contentEl.createEl('p', { text: 'Server URL or API Token not configured.' });
            return;
        }

        const loadingEl = contentEl.createEl('p', { text: 'Loading versions...' });

        try {
            const encodedPath = this.activeFilePath.split('/').map(encodeURIComponent).join('/');
            const resp = await requestUrl({
                url: `${this.plugin.settings.serverUrl.replace(/\/$/, '')}/api/history/versions/${encodedPath}`,
                headers: { Authorization: `Bearer ${this.plugin.settings.apiToken}` }
            });
            this.versions = resp.json.versions || [];
            loadingEl.remove();

            if (this.versions.length === 0) {
                contentEl.createEl('p', { text: 'No previous versions found on server.' });
                return;
            }

            const list = contentEl.createEl('ul');
            for (const version of this.versions) {
                const li = list.createEl('li');
                li.style.marginBottom = '10px';
                li.createEl('span', { text: `${new Date(version.ts).toLocaleString()} (${Math.round(version.size / 1024)} KB)` });
                
                const restoreBtn = li.createEl('button', { text: 'Restore this version' });
                restoreBtn.style.marginLeft = '10px';
                restoreBtn.onclick = async () => {
                    await this.restoreVersion(this.activeFilePath!, version.ts);
                    this.close();
                };
            }
        } catch (err) {
            loadingEl.remove();
            contentEl.createEl('p', { text: 'Failed to load versions.' });
            console.error(err);
        }
    }

    async restoreVersion(path: string, ts: number) {
        try {
            const encodedPath = path.split('/').map(encodeURIComponent).join('/');
            const resp = await requestUrl({
                url: `${this.plugin.settings.serverUrl.replace(/\/$/, '')}/api/history/restore-version/${encodedPath}?ts=${ts}`,
                method: 'POST',
                headers: { Authorization: `Bearer ${this.plugin.settings.apiToken}` }
            });
            if (resp.status === 200) {
                new Notice(`Restored version of ${path}`);
                this.plugin.pullAllFiles(); // pull changes to get the restored version
            }
        } catch (err) {
            new Notice(`Failed to restore version of ${path}`);
            console.error(err);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ─── Conflict Resolution Modal ────────────────────────────────────────────────

export class ConflictResolutionModal extends Modal {
  plugin: ObsidianApiSyncPlugin;
  path: string;
  serverContent: string;
  clientContent: string;

  constructor(
    app: App,
    plugin: ObsidianApiSyncPlugin,
    path: string,
    serverContent: string,
    clientContent: string
  ) {
    super(app);
    this.plugin = plugin;
    this.path = path;
    this.serverContent = serverContent;
    this.clientContent = clientContent;
    this.modalEl.style.width = 'min(90vw, 1100px)';
    this.modalEl.style.maxWidth = '1100px';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '⚠️ Sync Conflict' });
    contentEl.createEl('p', {
      text: `"${this.path}" was edited on another device at the same time. Choose which version to keep.`,
    }).style.color = 'var(--text-muted)';

    const grid = contentEl.createDiv();
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0;';

    // Server version (left)
    const leftPanel = grid.createDiv();
    leftPanel.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    leftPanel.createEl('div', { text: '🌐 Server Version (Remote)' }).style.cssText =
      'font-size:0.85em;font-weight:600;color:var(--text-muted);';
    const serverPre = leftPanel.createEl('pre');
    serverPre.style.cssText =
      'background:var(--background-secondary);padding:12px;border-radius:6px;overflow:auto;max-height:380px;font-size:0.78em;white-space:pre-wrap;word-break:break-word;border:1px solid var(--background-modifier-border);';
    serverPre.setText(this.serverContent);

    // Client version (right)
    const rightPanel = grid.createDiv();
    rightPanel.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    rightPanel.createEl('div', { text: '💻 Your Local Version' }).style.cssText =
      'font-size:0.85em;font-weight:600;color:var(--interactive-accent);';
    const clientPre = rightPanel.createEl('pre');
    clientPre.style.cssText =
      'background:var(--background-secondary);padding:12px;border-radius:6px;overflow:auto;max-height:380px;font-size:0.78em;white-space:pre-wrap;word-break:break-word;border:1px solid var(--interactive-accent);';
    clientPre.setText(this.clientContent);

    // Action buttons
    const btnRow = contentEl.createDiv();
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;';

    // Merge manually
    const mergeBtn = btnRow.createEl('button', { text: '✏️ Merge Manually' });
    mergeBtn.onclick = async () => {
      const mergeFilePath = `${this.path}.merge-conflict`;
      const mergeContent = [
        '<<<<<<< YOUR VERSION',
        this.clientContent,
        '=======',
        this.serverContent,
        '>>>>>>> SERVER VERSION',
      ].join('\n');
      try {
        await this.app.vault.adapter.write(mergeFilePath, mergeContent);
        const mergeFile = this.app.vault.getAbstractFileByPath(mergeFilePath);
        if (mergeFile instanceof TFile) {
          await this.app.workspace.getLeaf().openFile(mergeFile);
        }
        new Notice(`Merge file created: ${mergeFilePath}. Edit and sync when done.`);
      } catch (e) {
        new Notice('Failed to create merge file.');
        console.error(e);
      }
      this.close();
    };

    // Keep server version
    const keepServerBtn = btnRow.createEl('button', { text: '🌐 Keep Server Version' });
    keepServerBtn.onclick = async () => {
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (file instanceof TFile) {
        this.plugin.remoteChangeLocks.set(this.path, Date.now() + 2000);
        await this.app.vault.modify(file, this.serverContent);
        new Notice(`✅ Kept server version of ${this.path}`);
      } else {
        new Notice('Could not find local file to overwrite.');
      }
      this.close();
    };

    // Keep local version (force-push to server)
    const keepLocalBtn = btnRow.createEl('button', { text: '💻 Keep My Version' });
    keepLocalBtn.addClass('mod-cta');
    keepLocalBtn.onclick = async () => {
      this.plugin.wsClient.sendFileModifyForce(this.path, this.clientContent);
      new Notice(`✅ Kept your local version of ${this.path}`);
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}
