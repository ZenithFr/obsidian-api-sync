// Settings stored in Obsidian's plugin data
export interface ObsidianApiSyncSettings {
  serverUrl: string;
  apiToken: string;
  syncOnModify: boolean;
  syncDebounceMs: number;
  autoReconnect: boolean;
  reconnectIntervalMs: number;
}

export const DEFAULT_SETTINGS: ObsidianApiSyncSettings = {
  serverUrl: '',
  apiToken: '',
  syncOnModify: true,
  syncDebounceMs: 150,
  autoReconnect: true,
  reconnectIntervalMs: 3000,
};

export interface FolderCreatePayload {
  type: 'FOLDER_CREATE';
  path: string;
}

export type OutboundPayload = FileModifyPayload | FileDeletePayload | FileRenamePayload | FolderCreatePayload;

// ─── Server to Client ───────────────────────────────────────────────────────

export interface FileChangedPayload {
  type: 'FILE_CHANGED';
  path: string;
  content: string;
  source: 'ws' | 'rest';
  ts: string;
}

export interface FileDeletedPayload {
  type: 'FILE_DELETED';
  path: string;
  source: 'ws' | 'rest';
  ts: string;
}

export interface FileRenamedPayload {
  type: 'FILE_RENAMED';
  old_path: string;
  new_path: string;
  source: 'ws' | 'rest';
  ts: string;
}

export interface FolderCreatedPayload {
  type: 'FOLDER_CREATED';
  path: string;
  source: 'ws' | 'rest';
  ts: string;
}

export interface ConnectedPayload {
  type: 'CONNECTED';
  client_id: string;
}

export interface ErrorPayload {
  type: 'ERROR';
  code: string;
  message: string;
}

// ─── WebSocket Payloads ──────────────────────────────────────────────────────

export interface FileModifyPayload {
  type: 'FILE_MODIFY';
  path: string;
  content: string;
}

export interface FileDeletePayload {
  type: 'FILE_DELETE';
  path: string;
}

export interface FileRenamePayload {
  type: 'FILE_RENAME';
  new_path: string;
  path: string; // the old path
}

// Quick Import config (base64 JSON from dashboard)
export interface QuickImportConfig {
  server: string;
  token: string;
}

export type InboundPayload =
  | FileChangedPayload
  | FileDeletedPayload
  | FileRenamedPayload
  | ConnectedPayload
  | ErrorPayload;
