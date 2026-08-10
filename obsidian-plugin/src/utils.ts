/**
 * Fast, non-cryptographic FNV-1a hash (32-bit).
 * Used for conflict detection — produces a short hex string from text content.
 */
export function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = (hash * 0x01000193) >>> 0; // keep 32-bit unsigned
  }
  return hash.toString(16).padStart(8, '0');
}

import { Notice } from 'obsidian';

interface ToastError {
  code: string;
  msg: string;
  count: number;
}

export class ToastManager {
  private static errorAggregator: Map<string, ToastError> = new Map();
  private static debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static lastInfoMessage: string = "";
  private static infoDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  static showError(code: string, originalError?: any): void {
    console.error(`[ObsidianApiSync Error] ${code}:`, originalError);
    let subCode = '';
    if (originalError?.status) {
      subCode = `(${originalError.status}) `;
    } else if (originalError?.name && originalError.name !== 'Error') {
      subCode = `(${originalError.name}) `;
    }
    
    let baseMsg = 'Unknown error';
    if (originalError instanceof Error) baseMsg = originalError.message;
    else if (typeof originalError === 'string') baseMsg = originalError;
    else if (originalError && typeof originalError === 'object' && originalError.message) baseMsg = originalError.message;
    
    const fullMsg = `${subCode}${baseMsg}`;
    
    if (!this.errorAggregator.has(code)) {
      this.errorAggregator.set(code, { code, msg: fullMsg, count: 1 });
    } else {
      const existing = this.errorAggregator.get(code)!;
      existing.count++;
      existing.msg = fullMsg; // update to latest msg
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.flushErrors(), 1000);
  }

  private static flushErrors() {
    for (const [code, err] of this.errorAggregator.entries()) {
      if (err.count > 1) {
        new Notice(`❌ [${code}] ${err.msg} (and ${err.count - 1} more similar errors)`);
      } else {
        new Notice(`❌ [${code}] ${err.msg}`);
      }
    }
    this.errorAggregator.clear();
    this.debounceTimer = null;
  }

  static showInfo(msg: string, debounceMs: number = 0) {
    if (debounceMs > 0) {
      this.lastInfoMessage = msg;
      if (this.infoDebounceTimer) {
        clearTimeout(this.infoDebounceTimer);
      }
      this.infoDebounceTimer = setTimeout(() => {
        new Notice(this.lastInfoMessage);
        this.infoDebounceTimer = null;
      }, debounceMs);
    } else {
      new Notice(msg);
    }
  }
}
