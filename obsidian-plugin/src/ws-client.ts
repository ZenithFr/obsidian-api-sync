import {
  FileChangedPayload,
  FileDeletedPayload,
  FileRenamedPayload,
  FileModifyPayload,
  FileDeletePayload,
  FileRenamePayload,
  ConnectedPayload,
  ErrorPayload,
  InboundPayload,
} from './types';

export enum WsState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
}

const MAX_QUEUE_SIZE = 50;
const DEBOUNCE_MS = 800;
const MAX_RECONNECT_DELAY_MS = 30000;

export class ObsidianApiSyncWsClient {
  private ws: WebSocket | null = null;
  private state: WsState = WsState.DISCONNECTED;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendQueue: FileModifyPayload[] = [];
  private autoReconnect = true;

  // Stored so reconnect can use them without re-passing
  private _serverUrl = '';
  private _token = '';

  // Callbacks set by the plugin
  public onFileChanged: ((payload: FileChangedPayload) => void) | null = null;
  public onFileDeleted: ((payload: FileDeletedPayload) => void) | null = null;
  public onFileRenamed: ((payload: FileRenamedPayload) => void) | null = null;
  public onStateChange: ((state: WsState) => void) | null = null;
  public onConnected: ((clientId: string) => void) | null = null;
  public onError: ((payload: ErrorPayload) => void) | null = null;

  // ─── Public API ────────────────────────────────────────────────────────────

  connect(serverUrl: string, token: string): void {
    // Persist so reconnect logic can reuse them
    this._serverUrl = serverUrl;
    this._token = token;

    this.setState(WsState.CONNECTING);

    const wsUrl = this.buildWsUrl(serverUrl, token);

    // Close any lingering socket without triggering reconnect logic
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[ObsidianApiSync] WebSocket construction failed:', err);
      this.setState(WsState.DISCONNECTED);
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState(WsState.CONNECTED);
      this.flushQueue();
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    socket.onerror = (event: Event) => {
      console.error('[ObsidianApiSync] WebSocket error:', event);
    };

    socket.onclose = (event: CloseEvent) => {
      // Nullify ref so we don't double-close
      this.ws = null;

      // Code 4001 = authentication error — do NOT reconnect
      if (event.code === 4001) {
        console.warn('[ObsidianApiSync] Auth error (4001) — stopping reconnect.');
        this.setState(WsState.DISCONNECTED);
        if (this.onError) {
          this.onError({
            type: 'ERROR',
            code: '4001',
            message: 'Authentication failed. Check your API token.',
          });
        }
        return;
      }

      if (this.autoReconnect) {
        this.scheduleReconnect(this._serverUrl, this._token);
      } else {
        this.setState(WsState.DISCONNECTED);
      }
    };
  }

  disconnect(): void {
    // Cancel any pending reconnect or debounce timers
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      // Prevent onclose from scheduling a reconnect
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.setState(WsState.DISCONNECTED);
  }

  /**
   * Instantly sends a modify payload, or queues it if disconnected.
   */
  sendFileModify(path: string, content: string): void {
    const payload: FileModifyPayload = {
      type: 'FILE_MODIFY',
      path,
      content,
    };

    if (this.state === WsState.CONNECTED && this.ws) {
      this.rawSend(payload);
    } else {
      this.enqueue(payload);
    }
  }

  sendFileDelete(path: string): void {
    const payload: FileDeletePayload = { type: 'FILE_DELETE', path };
    if (this.state === WsState.CONNECTED && this.ws) {
      this.rawSend(payload as unknown as FileModifyPayload); // cast for rawSend
    } else {
      this.enqueue(payload as unknown as FileModifyPayload);
    }
  }

  sendFileRename(oldPath: string, newPath: string): void {
    const payload: FileRenamePayload = { type: 'FILE_RENAME', path: oldPath, new_path: newPath };
    if (this.state === WsState.CONNECTED && this.ws) {
      this.rawSend(payload as unknown as FileModifyPayload); // cast for rawSend
    } else {
      this.enqueue(payload as unknown as FileModifyPayload);
    }
  }

  flushQueue(): void {
    if (this.state !== WsState.CONNECTED || !this.ws) return;

    while (this.sendQueue.length > 0) {
      const item = this.sendQueue.shift();
      if (item) {
        this.rawSend(item);
      }
    }
  }

  getState(): WsState {
    return this.state;
  }

  setAutoReconnect(val: boolean): void {
    this.autoReconnect = val;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private scheduleReconnect(serverUrl: string, token: string): void {
    this.setState(WsState.RECONNECTING);
    this.reconnectAttempt += 1;

    const delayMs = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);

    console.log(
      `[ObsidianApiSync] Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt})…`
    );

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(serverUrl, token);
    }, delayMs);
  }

  private handleMessage(event: MessageEvent): void {
    let payload: InboundPayload;

    try {
      payload = JSON.parse(event.data as string) as InboundPayload;
    } catch (err) {
      console.error('[ObsidianApiSync] Failed to parse message:', err, event.data);
      return;
    }

    switch (payload.type) {
      case 'FILE_CHANGED':
        if (this.onFileChanged) {
          this.onFileChanged(payload);
        }
        break;

      case 'FILE_DELETED':
        if (this.onFileDeleted) {
          this.onFileDeleted(payload);
        }
        break;

      case 'FILE_RENAMED':
        if (this.onFileRenamed) {
          this.onFileRenamed(payload as FileRenamedPayload);
        }
        break;

      case 'CONNECTED': {
        const connPayload = payload as ConnectedPayload;
        if (this.onConnected) {
          this.onConnected(connPayload.client_id);
        }
        break;
      }

      case 'ERROR':
        if (this.onError) {
          this.onError(payload);
        }
        break;

      default:
        console.warn('[ObsidianApiSync] Unknown payload type:', (payload as { type: string }).type);
    }
  }

  private rawSend(payload: FileModifyPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[ObsidianApiSync] rawSend called but socket not open — queuing.');
      this.enqueue(payload);
      return;
    }

    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[ObsidianApiSync] Failed to send payload:', err);
      this.enqueue(payload);
    }
  }

  private enqueue(payload: FileModifyPayload): void {
    // Drop the oldest item if at capacity
    if (this.sendQueue.length >= MAX_QUEUE_SIZE) {
      this.sendQueue.shift();
    }
    this.sendQueue.push(payload);
  }

  private setState(next: WsState): void {
    if (this.state === next) return;
    this.state = next;
    if (this.onStateChange) {
      this.onStateChange(next);
    }
  }

  private buildWsUrl(serverUrl: string, token: string): string {
    // Normalise trailing slash
    let base = serverUrl.replace(/\/$/, '');

    // Replace http(s) scheme with ws(s)
    if (base.startsWith('https://')) {
      base = 'wss://' + base.slice('https://'.length);
    } else if (base.startsWith('http://')) {
      base = 'ws://' + base.slice('http://'.length);
    }

    return `${base}/ws/sync?token=${encodeURIComponent(token)}`;
  }
}

/** Factory function — preferred entry-point for the plugin. */
export function createWsClient(): ObsidianApiSyncWsClient {
  return new ObsidianApiSyncWsClient();
}
