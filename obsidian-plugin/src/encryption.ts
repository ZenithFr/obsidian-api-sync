export const MAGIC_HEADER = 'E2EE_V1|';
export const MAGIC_HEADER_BYTES = new TextEncoder().encode(MAGIC_HEADER);
export const TEXT_MAGIC_PREFIX = 'E2EE_V1:';

/**
 * Derives an AES-GCM key from a password using PBKDF2.
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypts an ArrayBuffer using AES-GCM and a password.
 * Prepends the raw binary magic header.
 */
export async function encryptBinary(buffer: ArrayBuffer, password: string): Promise<ArrayBuffer> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const key = await deriveKey(password, salt);
    
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        buffer
    );

    const outBuffer = new Uint8Array(MAGIC_HEADER_BYTES.length + salt.length + iv.length + ciphertext.byteLength);
    
    outBuffer.set(MAGIC_HEADER_BYTES, 0);
    outBuffer.set(salt, MAGIC_HEADER_BYTES.length);
    outBuffer.set(iv, MAGIC_HEADER_BYTES.length + salt.length);
    outBuffer.set(new Uint8Array(ciphertext), MAGIC_HEADER_BYTES.length + salt.length + iv.length);
    
    return outBuffer.buffer;
}

/**
 * Decrypts an E2EE ArrayBuffer using AES-GCM and a password.
 * Expects the raw binary magic header.
 */
export async function decryptBinary(buffer: ArrayBuffer, password: string): Promise<ArrayBuffer> {
    const data = new Uint8Array(buffer);
    
    if (!isEncryptedBinary(buffer)) {
        throw new Error('Data is not E2EE encrypted or magic header is missing');
    }

    let offset = MAGIC_HEADER_BYTES.length;
    
    const salt = data.slice(offset, offset + 16);
    offset += 16;
    
    const iv = data.slice(offset, offset + 12);
    offset += 12;
    
    const ciphertext = data.slice(offset);
    
    const key = await deriveKey(password, salt);
    
    return await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        ciphertext
    );
}

/**
 * Encrypts a text string into the format `E2EE_V1:<base64>`
 */
export async function encryptText(text: string, password: string): Promise<string> {
    const rawBuffer = new TextEncoder().encode(text).buffer;
    const encryptedBuffer = await encryptBinary(rawBuffer, password);
    const base64Str = arrayBufferToBase64(encryptedBuffer);
    return TEXT_MAGIC_PREFIX + base64Str;
}

/**
 * Decrypts a text string from the format `E2EE_V1:<base64>`
 */
export async function decryptText(encryptedText: string, password: string): Promise<string> {
    if (!isEncryptedText(encryptedText)) {
        throw new Error('Text does not have E2EE prefix');
    }
    const base64Str = encryptedText.substring(TEXT_MAGIC_PREFIX.length);
    const encryptedBuffer = base64ToArrayBuffer(base64Str);
    const decryptedBuffer = await decryptBinary(encryptedBuffer, password);
    return new TextDecoder().decode(decryptedBuffer);
}

export function isEncryptedBinary(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < MAGIC_HEADER_BYTES.length) return false;
    const data = new Uint8Array(buffer, 0, MAGIC_HEADER_BYTES.length);
    for (let i = 0; i < MAGIC_HEADER_BYTES.length; i++) {
        if (data[i] !== MAGIC_HEADER_BYTES[i]) return false;
    }
    return true;
}

export function isEncryptedText(text: string): boolean {
    return text.startsWith(TEXT_MAGIC_PREFIX);
}

// Helpers for base64 conversion (since this is independent of the Obsidian plugin context)
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}
