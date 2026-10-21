import { secureStorage } from 'tauri-plugin-secure-storage-api';
import { isNativeApp } from './platform';

const KEY_NAME = 'hrt-local-data-key';

/**
 * The five boot keys (app lock plan §8.4). They are the only values that stay
 * plaintext on Android, because they must be readable before the record key
 * exists: the theme and accent before the first paint, the language and vial
 * mode before the unlock screen, and `app-lock` to decide whether that screen
 * is needed at all.
 *
 * Everything else is encrypted. `app-onboarded` deliberately is not here — the
 * onboarding gate runs inside App, which only mounts after init.
 */
export const BOOT_KEYS: ReadonlySet<string> = new Set([
    'app-theme',
    'app-key-color',
    'hrt-lang',
    'hrt-mode',
    'app-lock',
]);

const isProtectedKey = (key: string): boolean => isNativeApp() && !BOOT_KEYS.has(key);

const cache = new Map<string, string>();
let dataKey: CryptoKey | null = null;
let ready = false;
const pendingWrites = new Set<Promise<unknown>>();

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

/**
 * Decrypt every protected value into the synchronous cache, and rewrite anything
 * still stored as plaintext.
 *
 * This is also the upgrade path for a device coming from a build where only the
 * record keys were encrypted: `isProtectedKey` is now "everything that is not a
 * boot key", so tokens, plans, reminders and settings are picked up and rewritten
 * here on the first launch, without a separate migration script.
 */
async function hydrateRecords(): Promise<void> {
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !isProtectedKey(key)) continue;
        const raw = localStorage.getItem(key);
        if (raw === null) continue;
        try {
            const plain = await decrypt(raw);
            cache.set(key, plain);
            if (plain === raw) localStorage.setItem(key, await encrypt(plain));
        } catch {
            // Ciphertext from a key this device no longer holds (a reset, a restored
            // backup, a regenerated K). It cannot be read, but one unreadable
            // settings value must not stop the app from starting; the owner will
            // treat it as absent. Record keys are namespaced per account, so this
            // does not silently mix two accounts' data.
        }
    }
}

/** Prepare the synchronous cache before React state initializers run. */
export async function initSecureStore(): Promise<void> {
    if (!isNativeApp() || ready) { ready = true; return; }
    if (!crypto.subtle) throw new Error('Web Crypto is unavailable in the Android WebView');
    let stored = await secureStorage.getItem(KEY_NAME);
    // A transient read failure right after an update must not be mistaken for a
    // fresh install: generating a key here would encrypt the plaintext values
    // under a key that is gone on the next launch.
    for (let attempt = 0; !stored && attempt < 3; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
        stored = await secureStorage.getItem(KEY_NAME);
    }
    if (!stored) {
        let encryptedDataExists = false;
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key && isProtectedKey(key) && localStorage.getItem(key) !== null) {
                encryptedDataExists = true;
                break;
            }
        }
        if (encryptedDataExists) {
            throw new Error('secure store key is missing while encrypted data exists');
        }
    }
    if (!stored) {
        const generated = b64(crypto.getRandomValues(new Uint8Array(32)));
        await secureStorage.setItem(KEY_NAME, generated);
        // Read it back before using it. A generated key that does not survive the
        // write turns every value encrypted under it into unreadable ciphertext on
        // the next launch, when the original key reappears — the upgrade report of
        // 2026-10-21 traced a lost sign-in token to exactly that window.
        const check = await secureStorage.getItem(KEY_NAME);
        if (check !== generated) {
            throw new Error('secure store key was not persisted');
        }
        stored = generated;
    }
    dataKey = await crypto.subtle.importKey('raw', unb64(stored) as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    await hydrateRecords();
    ready = true;
}

/**
 * The app-lock path: the record key arrived from the native Keystore after a
 * successful biometric prompt. Same K as before the lock was enabled — only the
 * wrapper around it changed — so every existing record opens unchanged.
 *
 * The old plugin entry is removed here rather than at enable time only: a crash
 * between "flag written" and "entry deleted" would otherwise leave a
 * no-authentication copy of K in the app sandbox, which is exactly the bypass
 * the lock exists to close.
 */
export async function initSecureStoreWithKey(storedBase64: string): Promise<void> {
    if (ready) return;
    if (!isNativeApp()) { ready = true; return; }
    if (!crypto.subtle) throw new Error('Web Crypto is unavailable in the Android WebView');
    dataKey = await crypto.subtle.importKey('raw', unb64(storedBase64) as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    await hydrateRecords();
    try {
        await secureStorage.removeItem(KEY_NAME);
    } catch {
        // Best-effort: the lock still works; this only removes the old bypass copy.
    }
    ready = true;
}

export const isSecureStoreReady = (): boolean => ready;

/** The raw K, for the enable flow: native needs it to wrap it under the Keystore key. */
export const readDataKeyBase64 = (): Promise<string | null> => secureStorage.getItem(KEY_NAME);

/** Used when the lock is turned off: restore the entry the plugin reads on boot. */
export const writeDataKeyBase64 = (value: string): Promise<void> => secureStorage.setItem(KEY_NAME, value);

export const removeDataKeyBase64 = (): Promise<void> => secureStorage.removeItem(KEY_NAME);

export function get(key: string): string | null {
    if (!isProtectedKey(key)) return localStorage.getItem(key);
    return cache.get(key) ?? null;
}

export function set(key: string, value: string): void {
    if (!isProtectedKey(key)) { localStorage.setItem(key, value); return; }
    cache.set(key, value);
    const write = encrypt(value)
        .then(envelope => { localStorage.setItem(key, envelope); })
        .catch(error => { console.error('[secure-store] write failed', key, error); });
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
}

export function remove(key: string): void {
    if (!isProtectedKey(key)) { localStorage.removeItem(key); return; }
    cache.delete(key);
    localStorage.removeItem(key);
}

/**
 * Wait for the asynchronous ciphertext writes to land.
 *
 * `set` returns before the record is on disk (the AES-GCM encrypt is async, the
 * read is synchronous). That is fine for a dose edit, but not for the session
 * token: killing the app in the window right after sign-in would sign the user
 * out on the next launch. Sign-in awaits this.
 */
export async function flushSecureStore(): Promise<void> {
    if (pendingWrites.size === 0) return;
    await Promise.allSettled([...pendingWrites]);
}
