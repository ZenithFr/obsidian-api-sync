import { App, Modal, Notice, requestUrl, TFile, Setting } from 'obsidian';
import type ObsidianApiSyncPlugin from './main';
import { diffLines } from 'diff';

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
      text: `"${this.path}" was edited on another device at the same time.`,
    }).style.color = 'var(--text-muted)';

    const isBinary = this.plugin.isBinaryFile(this.path);
    let mergeTextarea: HTMLTextAreaElement | null = null;
    let isResolving = false;

    if (!isBinary) {
      // Diff View
      contentEl.createEl('h3', { text: 'Visual Diff' }).style.margin = '10px 0 5px 0';
      
      const legend = contentEl.createDiv();
      legend.style.cssText = 'display:flex;gap:15px;margin-bottom:8px;font-size:0.85em;';
      legend.createSpan({ text: '■ Server Additions' }).style.color = '#2ecc71';
      legend.createSpan({ text: '■ Local Text (Missing on Server)' }).style.color = '#e74c3c';

      const diffPre = contentEl.createEl('pre');
      diffPre.style.cssText = 'background:var(--background-secondary);padding:12px;border-radius:6px;overflow:auto;max-height:300px;font-size:0.85em;white-space:pre-wrap;word-break:break-word;border:1px solid var(--background-modifier-border);';
      
      const diffParts = diffLines(this.clientContent, this.serverContent);
      diffParts.forEach(part => {
        const span = diffPre.createSpan({ text: part.value });
        if (part.added) {
          span.style.backgroundColor = 'rgba(46, 204, 113, 0.15)';
          span.style.color = '#2ecc71';
        } else if (part.removed) {
          span.style.backgroundColor = 'rgba(231, 76, 60, 0.15)';
          span.style.color = '#e74c3c';
          span.style.textDecoration = 'line-through';
        }
      });

      // Merge Editor
      contentEl.createEl('h3', { text: 'Final Merge Result' }).style.margin = '20px 0 5px 0';
      contentEl.createEl('p', { text: 'Edit this text to create your final merged version.' }).style.cssText = 'font-size:0.85em;color:var(--text-muted);margin:0 0 10px 0;';
      
      mergeTextarea = contentEl.createEl('textarea');
      mergeTextarea.value = this.clientContent; // Option A: Prepopulate with local
      mergeTextarea.style.cssText = 'width:100%;min-height:200px;font-family:var(--font-monospace);font-size:0.85em;padding:12px;background:var(--background-primary);border:1px solid var(--interactive-accent);border-radius:6px;resize:vertical;';
    } else {
      contentEl.createEl('p', { text: 'Binary file differences cannot be visually merged. Please select which version to keep.' }).style.cssText = 'color:var(--text-error);margin:10px 0;';
    }

    // Action buttons
    const btnRow = contentEl.createDiv();
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;';

    if (!isBinary && mergeTextarea) {
      // Resolve with Merged Text
      const resolveBtn = btnRow.createEl('button', { text: '✨ Resolve with Merged Text' });
      resolveBtn.addClass('mod-cta');
      resolveBtn.onclick = async () => {
        if (isResolving) return;
        isResolving = true;
        resolveBtn.disabled = true;

        const finalContent = mergeTextarea!.value;
        const file = this.app.vault.getAbstractFileByPath(this.path);
        if (file instanceof TFile) {
          this.plugin.remoteChangeLocks.set(this.path, Date.now() + 2000);
          
          await this.app.vault.modify(file, finalContent);
          
          // Force push to server
          this.plugin.wsClient.sendFileModifyForce(this.path, finalContent, false);
          
          new Notice(`✅ Merged conflict for ${this.path}`);
        } else {
          new Notice('Could not find local file to overwrite.');
        }
        this.close();
      };
    }

    // Keep server version
    const keepServerBtn = btnRow.createEl('button', { text: '🌐 Keep Server Version' });
    keepServerBtn.onclick = async () => {
      if (isResolving) return;
      isResolving = true;
      keepServerBtn.disabled = true;

      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (file instanceof TFile) {
        this.plugin.remoteChangeLocks.set(this.path, Date.now() + 2000);
        if (isBinary) {
          await this.app.vault.modifyBinary(file, this.plugin.base64ToArrayBuffer(this.serverContent));
        } else {
          await this.app.vault.modify(file, this.serverContent);
        }
        new Notice(`✅ Kept server version of ${this.path}`);
      } else {
        new Notice('Could not find local file to overwrite.');
      }
      this.close();
    };

    // Keep local version
    const keepLocalBtn = btnRow.createEl('button', { text: '💻 Keep My Version' });
    keepLocalBtn.onclick = async () => {
      if (isResolving) return;
      isResolving = true;
      keepLocalBtn.disabled = true;

      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (file instanceof TFile) {
        this.plugin.remoteChangeLocks.set(this.path, Date.now() + 2000);
        if (isBinary) {
          await this.app.vault.modifyBinary(file, this.plugin.base64ToArrayBuffer(this.clientContent));
        } else {
          await this.app.vault.modify(file, this.clientContent);
        }
        this.plugin.wsClient.sendFileModifyForce(this.path, this.clientContent, isBinary);
        new Notice(`✅ Kept your local version of ${this.path}`);
      } else {
        new Notice('Could not find local file to keep local version.');
      }
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}
