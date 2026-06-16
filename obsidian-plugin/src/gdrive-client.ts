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

  async startDeviceFlow(onSuccess?: () => void): Promise<void> {
    try {
      // 1. Request device code
      const res = await requestUrl({
        url: 'https://oauth2.googleapis.com/device/code',
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: `client_id=${GDRIVE_CLIENT_ID}&scope=https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email`,
        throw: false
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
            body: `client_id=${GDRIVE_CLIENT_ID}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
            throw: false
          });

          const pollData = pollRes.json;
          
          if (pollRes.status === 400 && pollData?.error === 'authorization_pending') {
            // This is completely normal and expected. Google returns 400 Bad Request until the user finishes logging in.
            setTimeout(poll, interval); 
          } else if (pollRes.status === 200 && pollData?.access_token) {
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
            if (onSuccess) onSuccess();
          } else {
            modal.close();
            new Notice(`Login failed: ${pollData?.error_description || pollData?.error || 'Unknown error'}`);
          }
        } catch (err: any) {
           modal.close();
           new Notice("Error polling for token: " + err.message);
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
      body: `client_id=${GDRIVE_CLIENT_ID}&refresh_token=${rt}&grant_type=refresh_token`,
      throw: false
    });

    const data = res.json;
    if (res.status !== 200 || data.error) {
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
    
    const wrapper = contentEl.createDiv();
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '20px';
    wrapper.style.alignItems = 'center';
    wrapper.style.padding = '20px 0';

    // Copy Code Box
    const codeBox = wrapper.createDiv();
    codeBox.style.display = 'flex';
    codeBox.style.flexDirection = 'column';
    codeBox.style.alignItems = 'center';
    codeBox.style.gap = '10px';

    const codeLabel = codeBox.createEl('span', { text: '1. Copy this security code:' });
    codeLabel.style.fontWeight = '600';

    const codeContainer = codeBox.createDiv();
    codeContainer.style.display = 'flex';
    codeContainer.style.gap = '10px';
    codeContainer.style.alignItems = 'center';

    const codeEl = codeContainer.createEl('div', { text: this.code });
    codeEl.style.fontSize = '2em';
    codeEl.style.fontWeight = 'bold';
    codeEl.style.letterSpacing = '2px';
    codeEl.style.padding = '10px 20px';
    codeEl.style.backgroundColor = 'var(--background-secondary)';
    codeEl.style.borderRadius = '5px';
    codeEl.style.userSelect = 'all';

    const copyBtn = codeContainer.createEl('button', { text: 'Copy' });
    copyBtn.style.padding = '10px 20px';
    copyBtn.style.height = '100%';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(this.code);
      copyBtn.innerText = 'Copied!';
      setTimeout(() => { copyBtn.innerText = 'Copy'; }, 2000);
    };

    // Open Link Box
    const linkBox = wrapper.createDiv();
    linkBox.style.display = 'flex';
    linkBox.style.flexDirection = 'column';
    linkBox.style.alignItems = 'center';
    linkBox.style.gap = '10px';

    const linkLabel = linkBox.createEl('span', { text: '2. Click here to login and paste the code:' });
    linkLabel.style.fontWeight = '600';

    const linkBtn = linkBox.createEl('a', { text: 'Open Google Login', href: this.url });
    linkBtn.addClass('mod-cta');
    linkBtn.style.padding = '10px 20px';
    linkBtn.style.borderRadius = '5px';
    linkBtn.style.textDecoration = 'none';
    linkBtn.style.color = 'var(--text-on-accent)';
    linkBtn.style.fontSize = '1.1em';

    // Status
    const statusEl = contentEl.createEl('p', { text: 'Waiting for you to authorize... (This window will close automatically)' });
    statusEl.style.marginTop = '2em';
    statusEl.style.textAlign = 'center';
    statusEl.style.color = 'var(--text-muted)';
  }

  onClose() {
    this.contentEl.empty();
  }
}
