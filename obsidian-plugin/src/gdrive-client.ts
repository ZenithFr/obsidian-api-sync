import { requestUrl, Notice, Modal, App } from 'obsidian';

// A generic Client ID must be of type "Desktop app" or "TVs and Limited Input devices"
// to use the Device Authorization Grant. Web Application types will fail.
const GDRIVE_CLIENT_ID = "688466971657-p9au1h7tljc33ku5i3vo08b7i4c47crl.apps.googleusercontent.com";

export class GDriveClient {
  private plugin: any;
  private accessToken: string = '';
  private tokenExpiry: number = 0;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  // ─── OAuth Device Flow ──────────────────────────────────────────────────────

  async startDeviceFlow(): Promise<void> {
    try {
      // 1. Request device code
      const res = await requestUrl({
        url: 'https://oauth2.googleapis.com/device/code',
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: `client_id=${GDRIVE_CLIENT_ID}&scope=https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email`
      });
      
      const data = res.json;
      if (!data.device_code) throw new Error("Invalid response from Google");

      // 2. Show UI to user
      const modal = new DeviceFlowModal(this.plugin.app, data.verification_url, data.user_code);
      modal.open();

      // 3. Poll for completion
      const interval = data.interval * 1000 || 5000;
      const deviceCode = data.device_code;
      
      let attempts = 0;
      const maxAttempts = 60; // 5 mins max

      const poll = async () => {
        if (attempts++ > maxAttempts) {
          modal.close();
          new Notice("Google Drive login timed out.");
          return;
        }

        try {
          const pollRes = await requestUrl({
            url: 'https://oauth2.googleapis.com/token',
            method: 'POST',
            contentType: 'application/x-www-form-urlencoded',
            body: `client_id=${GDRIVE_CLIENT_ID}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`
          });

          const pollData = pollRes.json;
          
          if (pollData.error) {
            if (pollData.error === 'authorization_pending') {
              setTimeout(poll, interval); // Keep waiting
            } else {
              modal.close();
              new Notice(`Login failed: ${pollData.error}`);
            }
          } else if (pollData.access_token) {
            // Success!
            modal.close();
            this.accessToken = pollData.access_token;
            this.tokenExpiry = Date.now() + (pollData.expires_in * 1000);
            
            this.plugin.settings.gdriveRefreshToken = pollData.refresh_token;
            
            // Get user email
            const email = await this.getUserEmail(this.accessToken);
            this.plugin.settings.gdriveEmail = email;
            
            await this.plugin.saveSettings();
            new Notice("✅ Successfully connected to Google Drive!");
            // Re-render settings tab if open
            this.plugin.app.setting.openTabById(this.plugin.manifest.id);
          }
        } catch (err: any) {
          // requestUrl throws on non-2xx statuses, which happens during 'authorization_pending' (HTTP 400)
          if (err.status === 400 && err.json?.error === 'authorization_pending') {
             setTimeout(poll, interval);
          } else {
             modal.close();
             new Notice("Error polling for token: " + err.message);
          }
        }
      };

      setTimeout(poll, interval);

    } catch (err: any) {
      new Notice("Failed to start Google Drive login: " + err.message);
    }
  }

  async disconnect(): Promise<void> {
    this.plugin.settings.gdriveRefreshToken = '';
    this.plugin.settings.gdriveFolderId = '';
    this.plugin.settings.gdriveFolderName = '';
    this.plugin.settings.gdriveEmail = '';
    this.accessToken = '';
    this.tokenExpiry = 0;
    await this.plugin.saveSettings();
    new Notice("Disconnected from Google Drive.");
  }

  private async getValidToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }
    
    const rt = this.plugin.settings.gdriveRefreshToken;
    if (!rt) throw new Error("No refresh token available");

    const res = await requestUrl({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: `client_id=${GDRIVE_CLIENT_ID}&refresh_token=${rt}&grant_type=refresh_token`
    });

    const data = res.json;
    if (data.error) {
      await this.disconnect();
      throw new Error("Google Drive session expired. Please log in again.");
    }

    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in * 1000);
    return this.accessToken;
  }

  private async getUserEmail(token: string): Promise<string> {
    try {
      const res = await requestUrl({
        url: 'https://www.googleapis.com/oauth2/v2/userinfo',
        headers: { Authorization: `Bearer ${token}` }
      });
      return res.json.email || 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  // ─── Drive API Wrapper ──────────────────────────────────────────────────────

  async listFiles(query: string, fields: string = "files(id, name, modifiedTime, mimeType, trashed, parents)"): Promise<any[]> {
    const token = await this.getValidToken();
    let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&pageSize=1000`;
    
    // Note: pagination not implemented here for brevity, assume < 1000 changes per interval
    const res = await requestUrl({
      url: url,
      headers: { Authorization: `Bearer ${token}` }
    });
    return res.json.files || [];
  }

  async getFileContent(fileId: string): Promise<string> {
    const token = await this.getValidToken();
    const res = await requestUrl({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      headers: { Authorization: `Bearer ${token}` }
    });
    return res.text;
  }

  async updateFileContent(fileId: string, content: string): Promise<any> {
    const token = await this.getValidToken();
    const res = await requestUrl({
      url: `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      method: 'PATCH',
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain'
      },
      body: content
    });
    return res.json;
  }

  async trashFile(fileId: string): Promise<void> {
    const token = await this.getValidToken();
    await requestUrl({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
      method: 'PATCH',
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ trashed: true })
    });
  }

  async createFile(name: string, parentId: string, content: string): Promise<any> {
    const token = await this.getValidToken();
    
    // Multipart upload
    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;

    const metadata = {
      name: name,
      parents: [parentId],
      mimeType: 'text/markdown'
    };

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: text/plain\r\n\r\n' +
      content +
      closeDelim;

    const res = await requestUrl({
      url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartRequestBody
    });
    
    return res.json;
  }

  async ensureFolder(name: string, parentId?: string): Promise<string> {
    let query = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentId) {
      query += ` and '${parentId}' in parents`;
    } else {
      query += ` and 'root' in parents`;
    }

    const files = await this.listFiles(query, "files(id)");
    if (files.length > 0) return files[0].id;

    // Create it
    const token = await this.getValidToken();
    const metadata: any = {
      name: name,
      mimeType: 'application/vnd.google-apps.folder'
    };
    if (parentId) metadata.parents = [parentId];

    const res = await requestUrl({
      url: 'https://www.googleapis.com/drive/v3/files',
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metadata)
    });
    
    return res.json.id;
  }
}

// ─── Modal UI ───────────────────────────────────────────────────────────────

class DeviceFlowModal extends Modal {
  private url: string;
  private code: string;

  constructor(app: App, url: string, code: string) {
    super(app);
    this.url = url;
    this.code = code;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    contentEl.createEl('h2', { text: 'Connect to Google Drive' });
    
    contentEl.createEl('p', { text: 'Please visit the following URL on any device:' });
    const link = contentEl.createEl('a', { text: this.url, href: this.url });
    link.style.fontSize = '1.2em';
    link.style.display = 'block';
    link.style.marginBottom = '1em';
    
    contentEl.createEl('p', { text: 'And enter this code:' });
    const codeEl = contentEl.createEl('div', { text: this.code });
    codeEl.style.fontSize = '2em';
    codeEl.style.fontWeight = 'bold';
    codeEl.style.letterSpacing = '2px';
    codeEl.style.padding = '10px';
    codeEl.style.backgroundColor = 'var(--background-secondary)';
    codeEl.style.textAlign = 'center';
    codeEl.style.borderRadius = '5px';
    
    contentEl.createEl('p', { text: 'Waiting for you to authorize... (This window will close automatically)' }).style.marginTop = '2em';
  }

  onClose() {
    this.contentEl.empty();
  }
}
