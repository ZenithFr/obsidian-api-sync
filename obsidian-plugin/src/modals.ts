import { App, Modal, Notice, requestUrl } from 'obsidian';
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
