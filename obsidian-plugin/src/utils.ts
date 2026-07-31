/**
 * Fast, non-cryptographic FNV-1a hash (32-bit).
 * Used for conflict detection — produces a short hex string from text content.
 */
export function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // keep 32-bit unsigned
  }
  return hash.toString(16).padStart(8, '0');
}
