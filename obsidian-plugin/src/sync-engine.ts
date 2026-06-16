import { App, Notice, TFile, TAbstractFile } from 'obsidian';
import { GDriveClient } from './gdrive-client';

interface CacheEntry {
  gdriveId: string;
  lastSyncMtime: number;
}

interface SyncCache {
  lastSyncTime: string; // ISO string for Drive API query
  files: Record<string, CacheEntry>;
}

export class SyncEngine {
  private app: App;
  private gdrive: GDriveClient;
  private plugin: any;
  private cache: SyncCache = { lastSyncTime: '1970-01-01T00:00:00Z', files: {} };
  private syncInProgress = false;

  constructor(app: App, gdrive: GDriveClient, plugin: any) {
    this.app = app;
    this.gdrive = gdrive;
    this.plugin = plugin;
  }

  async loadCache(): Promise<void> {
    const data = await this.plugin.loadData();
    if (data?.syncCache) {
      this.cache = data.syncCache;
    }
  }

  async saveCache(): Promise<void> {
    const data = await this.plugin.loadData() || {};
    data.syncCache = this.cache;
    await this.plugin.saveData(data);
  }

  async runSync(manual: boolean = false): Promise<void> {
    if (this.syncInProgress) {
      if (manual) new Notice("Sync already in progress...");
      return;
    }
    
    if (!this.plugin.settings.gdriveRefreshToken) {
       if (manual) new Notice("Google Drive not connected.");
       return;
    }

    this.syncInProgress = true;
    if (manual) new Notice("Starting Google Drive Sync...");

    try {
      await this.loadCache();
      const vaultRootId = await this.gdrive.ensureFolder(this.plugin.settings.gdriveFolderName || 'ObsidianVault');
      const syncStartTime = new Date().toISOString();

      // 1. PUSH CYCLE: Detect Local Edits & Deletions
      await this.pushLocalChanges(vaultRootId);

      // 2. PULL CYCLE: Detect Remote Edits & Deletions
      await this.pullRemoteChanges(vaultRootId);

      // 3. Update Sync Timestamp
      this.cache.lastSyncTime = syncStartTime;
      await this.saveCache();

      if (manual) new Notice("Google Drive Sync Complete!");
    } catch (err: any) {
      console.error("[GDrive Sync] Error:", err);
      new Notice(`Sync Error: ${err.message}`);
    } finally {
      this.syncInProgress = false;
    }
  }

  private async pushLocalChanges(vaultRootId: string): Promise<void> {
    // 1A. Detect Local Deletions (The Cache State Method)
    const cachedPaths = Object.keys(this.cache.files);
    for (const path of cachedPaths) {
      const exists = this.app.vault.getAbstractFileByPath(path);
      if (!exists) {
        // File was deleted locally! Trash it remotely.
        try {
          const entry = this.cache.files[path];
          await this.gdrive.trashFile(entry.gdriveId);
          delete this.cache.files[path];
        } catch (err) {
          console.warn(`[GDrive Sync] Failed to trash remote file for ${path}`, err);
        }
      }
    }

    // 1B. Detect Local Edits / New Files
    const allFiles = this.app.vault.getMarkdownFiles();
    for (const file of allFiles) {
      const localMtime = file.stat.mtime;
      const entry = this.cache.files[file.path];

      // If not in cache (new) OR local modified time is newer than last sync
      if (!entry || localMtime > entry.lastSyncMtime) {
        const content = await this.app.vault.read(file);

        if (!entry) {
          // Create new remote file
          const folderId = await this.ensureRemoteFolderTree(file.path, vaultRootId);
          const res = await this.gdrive.createFile(file.name, folderId, content);
          this.cache.files[file.path] = {
            gdriveId: res.id,
            lastSyncMtime: localMtime
          };
        } else {
          // Update existing remote file
          await this.gdrive.updateFileContent(entry.gdriveId, content);
          entry.lastSyncMtime = localMtime;
        }
      }
    }
  }

  private async pullRemoteChanges(vaultRootId: string): Promise<void> {
    // Query Drive for anything modified since lastSyncTime inside our vault
    const query = `modifiedTime > '${this.cache.lastSyncTime}'`;
    // We fetch everything modified recently. Note: For a true robust system, we should filter by our vault Root ID.
    // Drive API doesn't allow recursive parent filtering easily, so we fetch all and filter client-side.
    
    // Instead, we just fetch files owned by us modified recently.
    const allRecent = await this.gdrive.listFiles(query);
    
    for (const remoteFile of allRecent) {
      // Find the local path for this file ID from cache
      let localPath = Object.keys(this.cache.files).find(p => this.cache.files[p].gdriveId === remoteFile.id);
      
      // If we don't have it in cache, it's a completely new file from remote.
      // We need to resolve its path. For simplicity in V1, we put it in root if we can't resolve parents.
      // A robust implementation would walk the `parents` array to build the full path.
      if (!localPath && !remoteFile.trashed && remoteFile.mimeType === 'text/markdown') {
          localPath = remoteFile.name; // Fallback to root
          // Attempt to build path from parents if available (omitted for brevity)
      }

      if (!localPath) continue; // Skip folders or unrecognized files

      if (remoteFile.trashed) {
        // 2A. Remote Deletion Detected
        const localFile = this.app.vault.getAbstractFileByPath(localPath);
        if (localFile instanceof TFile) {
          await this.app.vault.trash(localFile, false); // move to Obsidian trash
        }
        delete this.cache.files[localPath];
      } else {
        // 2B. Remote Edit / New File Detected
        const remoteMtimeMs = new Date(remoteFile.modifiedTime).getTime();
        const entry = this.cache.files[localPath];

        // Conflict check: if we just pushed it, remoteMtime might be slightly newer due to Drive processing,
        // but we assume our push cycle handled our own edits.
        // Actually, if it's a true remote edit, we download it.
        if (!entry || remoteMtimeMs > entry.lastSyncMtime) {
          try {
            const content = await this.gdrive.getFileContent(remoteFile.id);
            const localFile = this.app.vault.getAbstractFileByPath(localPath);
            
            if (localFile instanceof TFile) {
              await this.app.vault.modify(localFile, content);
              this.cache.files[localPath].lastSyncMtime = localFile.stat.mtime;
            } else {
              // Create it locally
              const newFile = await this.app.vault.create(localPath, content);
              this.cache.files[localPath] = {
                gdriveId: remoteFile.id,
                lastSyncMtime: newFile.stat.mtime
              };
            }
          } catch (err) {
            console.warn(`[GDrive Sync] Failed to pull ${localPath}`, err);
          }
        }
      }
    }
  }

  private async ensureRemoteFolderTree(filePath: string, rootId: string): Promise<string> {
    const parts = filePath.split('/');
    parts.pop(); // remove filename
    if (parts.length === 0) return rootId;

    let currentParentId = rootId;
    for (const part of parts) {
      currentParentId = await this.gdrive.ensureFolder(part, currentParentId);
    }
    return currentParentId;
  }
}
