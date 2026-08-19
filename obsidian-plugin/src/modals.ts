import { App, Modal, requestUrl, TFile } from 'obsidian';
import type ObsidianApiSyncPlugin from './main';
import { ToastManager } from './utils';

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
                ToastManager.showInfo(`Restored ${originalPath}`);
                this.plugin.pullAllFiles(); // pull changes to get the restored file
            }
        } catch (err) {
            ToastManager.showError('ERR-TRASH-RESTORE', err);
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
                ToastManager.showInfo(`Restored version of ${path}`);
                this.plugin.pullAllFiles(); // pull changes to get the restored version
            }
        } catch (err) {
            ToastManager.showError('ERR-VER-RESTORE', err);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ─── Conflict Resolution Modal ────────────────────────────────────────────────

export class ConflictModal extends Modal {
    plugin: ObsidianApiSyncPlugin;
    conflictedPath: string;
    serverMtime?: number;
    onResolve: () => void;

    constructor(app: App, plugin: ObsidianApiSyncPlugin, path: string, serverMtime: number | undefined, onResolve: () => void) {
        super(app);
        this.plugin = plugin;
        this.conflictedPath = path;
        this.serverMtime = serverMtime;
        this.onResolve = onResolve;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '⚠️ Sync Conflict Detected' });

        let timeText = '';
        if (this.serverMtime) {
            const date = new Date(this.serverMtime);
            const istTime = date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' });
            timeText = ` at ${istTime} (IST)`;
        }

        contentEl.createEl('p', {
            text: `"${this.conflictedPath}" was edited on both the server${timeText} and locally since the last sync. Choose which version to keep.`
        });

        // ── Fetch both versions for diff ────────────────────────────────────
        let serverContent = '';
        let localContent = '';
        let fetchError = false;

        try {
            const encodedPath = this.conflictedPath.split('/').map(encodeURIComponent).join('/');
            const resp = await requestUrl({
                url: `${this.plugin.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
                headers: { Authorization: `Bearer ${this.plugin.settings.apiToken}` }
            });
            serverContent = resp.text || '';
        } catch {
            fetchError = true;
        }

        const localFile = this.app.vault.getAbstractFileByPath(this.conflictedPath);
        if (localFile instanceof TFile && !this.plugin.isBinaryFile(this.conflictedPath)) {
            try {
                localContent = await this.app.vault.read(localFile);
            } catch {
                fetchError = true;
            }
        }

        // ── Side-by-side diff ───────────────────────────────────────────────
        if (!fetchError && serverContent && localContent) {
            const diffWrapper = contentEl.createDiv({ cls: 'conflict-diff-wrapper' });
            diffWrapper.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0;max-height:360px;overflow-y:auto;';

            const serverCol = diffWrapper.createDiv({ cls: 'conflict-col' });
            const localCol  = diffWrapper.createDiv({ cls: 'conflict-col' });

            serverCol.style.cssText = 'background:var(--background-secondary);border-radius:6px;padding:10px;overflow-x:auto;';
            localCol.style.cssText  = serverCol.style.cssText;

            serverCol.createEl('h4', { text: '🖥 Server version' }).style.cssText = 'margin:0 0 6px;font-size:12px;opacity:.7;';
            localCol.createEl('h4',  { text: '💻 Your version'   }).style.cssText = 'margin:0 0 6px;font-size:12px;opacity:.7;';

            // Line-by-line diff using LCS approach (no external dep)
            const serverLines = serverContent.split('\n');
            const localLines  = localContent.split('\n');

            ConflictModal.renderLineDiff(serverLines, localLines, serverCol, localCol);
        } else if (!fetchError) {
            contentEl.createEl('p', { text: '(Binary file — cannot show diff. Choose which version to keep.)' })
                .style.cssText = 'opacity:.6;font-style:italic;';
        }

        // ── Action buttons ──────────────────────────────────────────────────
        const btnContainer = contentEl.createDiv({ cls: 'conflict-buttons' });
        btnContainer.style.cssText = 'display:flex;gap:10px;margin-top:12px;';

        const btnRemote = btnContainer.createEl('button', { text: 'Keep Server Version' });
        btnRemote.onclick = async () => {
            btnRemote.disabled = true;
            btnRemote.textContent = 'Pulling...';
            try {
                await this.plugin.pullAllFiles();
                ToastManager.showInfo(`Resolved: kept server version of ${this.conflictedPath}.`);
                this.close();
            } catch (err) {
                ToastManager.showError('ERR-FS-PULL-01', err);
                btnRemote.disabled = false;
                btnRemote.textContent = 'Keep Server Version';
            }
        };

        const btnLocal = btnContainer.createEl('button', { text: 'Keep My Version', cls: 'mod-warning' });
        btnLocal.onclick = async () => {
            btnLocal.disabled = true;
            btnLocal.textContent = 'Pushing...';
            try {
                const isBinary = this.plugin.isBinaryFile(this.conflictedPath);
                let contentStr = '';
                const file = this.app.vault.getAbstractFileByPath(this.conflictedPath);
                if (file instanceof TFile) {
                    if (isBinary) {
                        const buffer = await this.app.vault.readBinary(file);
                        contentStr = this.plugin.arrayBufferToBase64(buffer);
                    } else {
                        contentStr = await this.app.vault.read(file);
                    }
                    const encrypted = await this.plugin.encryptPayloadIfNeeded(contentStr, isBinary);
                    this.plugin.wsClient.sendFileModifyForce(this.conflictedPath, encrypted.contentStr, encrypted.isBinary);
                    ToastManager.showInfo(`Resolved: kept local version of ${this.conflictedPath}.`);
                    this.close();
                } else {
                    ToastManager.showError('ERR-FS-LOCAL-NOT-FOUND', 'Local file not found.');
                }
            } catch (err) {
                ToastManager.showError('ERR-FS-PUSH-01', err);
                btnLocal.disabled = false;
                btnLocal.textContent = 'Keep My Version';
            }
        };
    }

    /** Render a simple line-diff between two string arrays into two columns. */
    private static renderLineDiff(
        aLines: string[],
        bLines: string[],
        aEl: HTMLElement,
        bEl: HTMLElement
    ): void {
        // Build LCS length table
        const m = aLines.length;
        const n = bLines.length;
        const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = aLines[i - 1] === bLines[j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }

        // Back-trace to build diff operations
        type Op = { op: '=' | '-' | '+'; line: string };
        const aDiff: Op[] = [];
        const bDiff: Op[] = [];
        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
                aDiff.unshift({ op: '=', line: aLines[i - 1] });
                bDiff.unshift({ op: '=', line: bLines[j - 1] });
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                bDiff.unshift({ op: '+', line: bLines[j - 1] });
                aDiff.unshift({ op: '-', line: '' }); // placeholder for alignment
                j--;
            } else {
                aDiff.unshift({ op: '-', line: aLines[i - 1] });
                bDiff.unshift({ op: '+', line: '' }); // placeholder for alignment
                i--;
            }
        }

        const pre = (el: HTMLElement) => {
            const p = el.createEl('pre');
            p.style.cssText = 'margin:0;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;';
            return p;
        };
        const aContainer = pre(aEl);
        const bContainer = pre(bEl);

        for (let k = 0; k < aDiff.length; k++) {
            const aOp = aDiff[k];
            const bOp = bDiff[k];

            const aSpan = aContainer.createEl('span', { text: aOp.line + '\n' });
            const bSpan = bContainer.createEl('span', { text: bOp.line + '\n' });

            if (aOp.op === '-' && aOp.line !== '') {
                aSpan.style.cssText = 'background:rgba(255,80,80,.25);display:block;';
            } else if (bOp.op === '+' && bOp.line !== '') {
                bSpan.style.cssText = 'background:rgba(80,200,80,.2);display:block;';
            }
        }
    }

    onClose() {
        this.contentEl.empty();
        this.onResolve();
    }
}
