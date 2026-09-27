import { secureStorage } from 'tauri-plugin-secure-storage-api';
import { isNativeApp } from './platform';

const KEY_NAME = 'hrt-local-data-key';
const RECORD_KEY_RE = /^hrt-(u[^-]+-)?(masc-)?(events|lab-results|dose-templates|quick-doses|journal|deletions)$/;
const DEVICE_HEALTH_KEY_RE = /^hrt-med-reminders$/;
const cache = new Map<string, string>();
let dataKey: CryptoKey | null = null;
let ready = false;

export const isRecordKey = (key: string): boolean => RECORD_KEY_RE.test(key) || DEVICE_HEALTH_KEY_RE.test(key);

const b64 = (bytes: Uint8Array): string => {
    let out = '';
    for (const byte of bytes) out += String.fromCharCode(byte);
    return btoa(out);
};

const unb64 = (value: string): Uint8Array => {
    const raw = atob(value);
    return Uint8Array.from(raw, char => char.charCodeAt(0));
};

async function encrypt(value: string): Promise<string> {
    if (!dataKey) throw new Error('secure store is not initialized');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, dataKey, new TextEncoder().encode(value));
    return JSON.stringify({ iv: b64(iv), data: b64(new Uint8Array(bytes)) });
}

async function decrypt(value: string): Promise<string> {
    if (!dataKey) throw new Error('secure store is not initialized');
    const envelope = JSON.parse(value) as { iv?: string; data?: string };
    if (!envelope.iv || !envelope.data) return value;
    const bytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(envelope.iv) as unknown as BufferSource },
        dataKey,
        unb64(envelope.data) as unknown as BufferSource,
    );
    return new TextDecoder().decode(bytes);
}

/** Prepare the synchronous cache before React state initializers run. */
export async function initSecureStore(): Promise<void> {
    if (!isNativeApp() || ready) { ready = true; return; }
    if (!crypto.subtle) throw new Error('Web Crypto is unavailable in the Android WebView');
    let stored = await secureStorage.getItem(KEY_NAME);
    if (!stored) {
        stored = b64(crypto.getRandomValues(new Uint8Array(32)));
        await secureStorage.setItem(KEY_NAME, stored);
    }
    dataKey = await crypto.subtle.importKey('raw', unb64(stored) as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !isRecordKey(key)) continue;
        const raw = localStorage.getItem(key);
        if (raw === null) continue;
        const plain = await decrypt(raw);
        cache.set(key, plain);
        if (plain === raw) localStorage.setItem(key, await encrypt(plain));
    }
    ready = true;
}

export function get(key: string): string | null {
    if (!isNativeApp() || !isRecordKey(key)) return localStorage.getItem(key);
    return cache.get(key) ?? null;
}

export function set(key: string, value: string): void {
    if (!isNativeApp() || !isRecordKey(key)) { localStorage.setItem(key, value); return; }
    cache.set(key, value);
    void encrypt(value).then(envelope => localStorage.setItem(key, envelope));
}

export function remove(key: string): void {
    if (!isNativeApp() || !isRecordKey(key)) { localStorage.removeItem(key); return; }
    cache.delete(key);
    localStorage.removeItem(key);
}
