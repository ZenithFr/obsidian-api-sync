import re

def patch_main():
    with open('obsidian-plugin/src/main.ts', 'r') as f:
        content = f.read()

    # 1. Import arrayBufferToBase64 and base64ToArrayBuffer if available, but we'll just write our own helpers inside the class.
    helpers = """
  // ─── Helpers ─────────────────────────────────────────────────────────────

  shouldSyncPath(path: string, isFolder: boolean = false): boolean {
    if (path.startsWith(this.app.vault.configDir + '/')) {
      return true; // Config dir is handled separately via syncObsidianFolder
    }

    if (!isFolder) {
      const extMatch = path.match(/\\.([^.]+)$/);
      if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        const allowed = this.settings.allowedExtensions.split(',').map(s => s.trim().toLowerCase());
        if (!allowed.includes(ext)) return false;
      } else {
        return false;
      }
    }

    const mode = this.settings.syncMode;
    if (mode === 'include_all') return true;

    const paths = this.settings.selectiveSyncPaths.split('\\n').map(s => s.trim()).filter(s => s);
    let matches = false;
    for (const p of paths) {
      if (path.startsWith(p)) {
        matches = true;
        break;
      }
    }

    if (mode === 'include_selected') return matches;
    if (mode === 'exclude_selected') return !matches;
    return true;
  }

  isBinaryFile(path: string): boolean {
    const extMatch = path.match(/\\.([^.]+)$/);
    if (!extMatch) return false;
    const ext = extMatch[1].toLowerCase();
    // Common text formats in Obsidian
    const textExts = ['md', 'canvas', 'txt', 'css', 'json', 'csv', 'js', 'ts'];
    return !textExts.includes(ext);
  }

  arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
  }
"""

    content = content.replace("  // ─── Lifecycle ──────────────────────────────────────────────────────────────", helpers + "\n  // ─── Lifecycle ──────────────────────────────────────────────────────────────")

    # 2. Modify onFileChanged
    # Find the block where file is modified
    # replace app.vault.modify(file, payload.content) with binary check
    on_file_changed_text_modify = """          // Cancel any pending outbound syncs for this file since it was just overwritten
          if (this.modifyDebounceTimers.has(file.path)) {
            clearTimeout(this.modifyDebounceTimers.get(file.path)!);
            this.modifyDebounceTimers.delete(file.path);
          }
          // Lock for 800ms to allow Obsidian to update its UI without bouncing the change back
          this.remoteChangeLocks.set(file.path, Date.now() + 800);
          try {
            await this.app.vault.modify(file, payload.content);
          } catch (err) {
            this.showError("modify failed", err);
          }"""
    
    new_on_file_changed_modify = """          if (this.modifyDebounceTimers.has(file.path)) {
            clearTimeout(this.modifyDebounceTimers.get(file.path)!);
            this.modifyDebounceTimers.delete(file.path);
          }
          this.remoteChangeLocks.set(file.path, Date.now() + 800);
          try {
            if (payload.is_binary) {
              await this.app.vault.modifyBinary(file, this.base64ToArrayBuffer(payload.content));
            } else {
              await this.app.vault.modify(file, payload.content);
            }
          } catch (err) {
            this.showError("modify failed", err);
          }"""
    content = content.replace(on_file_changed_text_modify, new_on_file_changed_modify)

    # Replace currentContent in onFileChanged
    content = content.replace(
        "const currentContent = await this.app.vault.read(file);",
        """let normalizedLocal = '';
        let normalizedRemote = '';
        if (payload.is_binary) {
          const currentBuffer = await this.app.vault.readBinary(file);
          normalizedLocal = this.arrayBufferToBase64(currentBuffer);
          normalizedRemote = payload.content;
        } else {
          const currentContent = await this.app.vault.read(file);
          normalizedLocal = currentContent.replace(/\\r\\n/g, '\\n');
          normalizedRemote = payload.content.replace(/\\r\\n/g, '\\n');
        }"""
    )
    content = content.replace(
        "const normalizedLocal = currentContent.replace(/\\r\\n/g, '\\n');\n        const normalizedRemote = payload.content.replace(/\\r\\n/g, '\\n');\n        if (normalizedLocal !== normalizedRemote) {",
        "if (normalizedLocal !== normalizedRemote) {"
    )

    # 3. Create missing file logic
    content = content.replace(
        "await this.app.vault.create(payload.path, payload.content);",
        """if (payload.is_binary) {
            await this.app.vault.createBinary(payload.path, this.base64ToArrayBuffer(payload.content));
          } else {
            await this.app.vault.create(payload.path, payload.content);
          }"""
    )

    # 4. Vault event hooks filters
    # editor-change
    content = content.replace(
        "if (!(file instanceof TFile)) return;",
        "if (!(file instanceof TFile)) return;\n        if (!this.shouldSyncPath(file.path, false)) return;"
    )
    # modify
    content = content.replace(
        "if (!(file instanceof TFile)) return;\n        if (!this.settings.syncOnModify) return;",
        "if (!(file instanceof TFile)) return;\n        if (!this.settings.syncOnModify) return;\n        if (!this.shouldSyncPath(file.path, false)) return;"
    )
    # create
    content = content.replace(
        "if (!this.settings.syncOnModify) return;\n        \n        const lockExpiry",
        "if (!this.settings.syncOnModify) return;\n        if (!this.shouldSyncPath(file.path, file instanceof TFolder)) return;\n        \n        const lockExpiry"
    )
    # delete
    content = content.replace(
        "if (!this.settings.syncOnModify) return;\n        if (this.wsClient.getState()",
        "if (!this.settings.syncOnModify) return;\n        if (!this.shouldSyncPath(file.path, file instanceof TFolder)) return;\n        if (this.wsClient.getState()"
    )
    # rename
    content = content.replace(
        "if (!this.settings.syncOnModify) return;\n        if (this.wsClient.getState() === WsState.CONNECTED) {",
        "if (!this.settings.syncOnModify) return;\n        // Only sync rename if either old or new path is synced\n        if (!this.shouldSyncPath(file.path, file instanceof TFolder) && !this.shouldSyncPath(oldPath, file instanceof TFolder)) return;\n        if (this.wsClient.getState() === WsState.CONNECTED) {"
    )
    
    # 5. Read binary before sending modify
    read_and_send = """            if (this.wsClient.getState() === WsState.CONNECTED) {
              const content = await this.app.vault.read(file);
              this.wsClient.sendFileModify(file.path, content);
            } else if (this.settings.serverUrl && this.settings.apiToken) {
              await this.httpFallbackWrite(file);
            }"""
    new_read_and_send = """            const isBinary = this.isBinaryFile(file.path);
            let contentStr = '';
            if (isBinary) {
              const buffer = await this.app.vault.readBinary(file);
              contentStr = this.arrayBufferToBase64(buffer);
            } else {
              contentStr = await this.app.vault.read(file);
            }
            if (this.wsClient.getState() === WsState.CONNECTED) {
              this.wsClient.sendFileModify(file.path, contentStr, isBinary);
            } else if (this.settings.serverUrl && this.settings.apiToken) {
              await this.httpFallbackWrite(file, contentStr, isBinary);
            }"""
    content = content.replace(read_and_send, new_read_and_send)
    
    # create hook:
    content = content.replace(
        "const content = await this.app.vault.read(file);\n              this.wsClient.sendFileModify(file.path, content);",
        """const isBinary = this.isBinaryFile(file.path);
              let contentStr = '';
              if (isBinary) {
                const buffer = await this.app.vault.readBinary(file);
                contentStr = this.arrayBufferToBase64(buffer);
              } else {
                contentStr = await this.app.vault.read(file);
              }
              this.wsClient.sendFileModify(file.path, contentStr, isBinary);"""
    )
    
    # 6. httpFallbackWrite signature
    content = content.replace(
        "async httpFallbackWrite(file: TFile): Promise<void> {",
        "async httpFallbackWrite(file: TFile, contentStr?: string, isBinary?: boolean): Promise<void> {"
    )
    http_read = "const content = await this.app.vault.read(file);"
    new_http_read = """
      let finalContent: string | ArrayBuffer = contentStr || '';
      let isBin = isBinary !== undefined ? isBinary : this.isBinaryFile(file.path);
      if (!contentStr) {
        if (isBin) {
          finalContent = await this.app.vault.readBinary(file);
        } else {
          finalContent = await this.app.vault.read(file);
        }
      } else {
        if (isBin) {
          finalContent = this.base64ToArrayBuffer(contentStr);
        }
      }
    """
    content = content.replace(http_read, new_http_read)
    
    content = content.replace(
        "body: content,",
        "body: finalContent,"
    )

    # 7. pullAllFiles
    pull_all_content_check = """        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (localFile instanceof TFile) {
          const localContent = await this.app.vault.read(localFile);
          const normalizedLocal = localContent.replace(/\\r\\n/g, '\\n');
          const normalizedRemote = remoteContent.replace(/\\r\\n/g, '\\n');
          if (normalizedLocal !== normalizedRemote) {"""
    
    new_pull_all = """        if (!this.shouldSyncPath(path, false)) continue;
        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (localFile instanceof TFile) {
          let normalizedLocal = '';
          let normalizedRemote = '';
          if (item.is_binary) {
            const currentBuffer = await this.app.vault.readBinary(localFile);
            normalizedLocal = this.arrayBufferToBase64(currentBuffer);
            normalizedRemote = remoteContent;
          } else {
            const localContent = await this.app.vault.read(localFile);
            normalizedLocal = localContent.replace(/\\r\\n/g, '\\n');
            normalizedRemote = remoteContent.replace(/\\r\\n/g, '\\n');
          }
          if (normalizedLocal !== normalizedRemote) {"""
    content = content.replace(pull_all_content_check, new_pull_all)
    
    content = content.replace(
        "await this.app.vault.modify(localFile, remoteContent);",
        """if (item.is_binary) {
              await this.app.vault.modifyBinary(localFile, this.base64ToArrayBuffer(remoteContent));
            } else {
              await this.app.vault.modify(localFile, remoteContent);
            }"""
    )
    
    content = content.replace(
        "await this.app.vault.create(path, remoteContent);",
        """if (item.is_binary) {
            await this.app.vault.createBinary(path, this.base64ToArrayBuffer(remoteContent));
          } else {
            await this.app.vault.create(path, remoteContent);
          }"""
    )
    
    with open('obsidian-plugin/src/main.ts', 'w') as f:
        f.write(content)
        
patch_main()
