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

/**
 * Open one stored value: the plaintext when there was no encryption, the plaintext
 * inside the envelope otherwise, and a throw when it *is* an envelope this device
 * cannot open.
 *
 * The old version went straight to `JSON.parse`, which threw on any legacy plaintext
 * that was not JSON shaped — a session token (`ks_…`), an enum value like `mipd`,
 * a bare number. `hydrateRecords` caught the throw and treated the value as
 * unreadable, so upgrading signed the user out and left the plaintext in
 * localStorage, contradicting the "everything but the five boot keys is encrypted"
 * promise. Only a `{iv,data}` pair is an envelope; anything else is plaintext by
 * definition.
 */
async function decrypt(value: string): Promise<string> {
    if (!dataKey) throw new Error('secure store is not initialized');
    let envelope: unknown;
    try {
        envelope = JSON.parse(value);
    } catch {
        return value;
    }
    if (!envelope || typeof envelope !== 'object') return value;
    const { iv, data } = envelope as { iv?: unknown; data?: unknown };
    if (typeof iv !== 'string' || typeof data !== 'string' || !iv || !data) return value;
    const bytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(iv) as unknown as BufferSource },
        dataKey,
        unb64(data) as unknown as BufferSource,
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
/** Whether a stored string is this store's ciphertext envelope. */
function isEnvelope(value: string): boolean {
    try {
        const parsed = JSON.parse(value) as { iv?: unknown; data?: unknown } | null;
        return Boolean(parsed && typeof parsed === 'object'
            && typeof (parsed as { iv?: unknown }).iv === 'string'
            && typeof (parsed as { data?: unknown }).data === 'string');
    } catch {
        return false;
    }
}

async function hydrateRecords(): Promise<void> {
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !isProtectedKey(key)) continue;
        const rawValue = localStorage.getItem(key);
        if (rawValue === null) continue;
        let plain: string;
        try {
            plain = await decrypt(rawValue);
        } catch {
            // Ciphertext from a key this device no longer holds (a reset, a restored
            // backup, a regenerated K). It cannot be read, but one unreadable value
            // must not stop the app from starting; the owner treats it as absent.
            // Record keys are namespaced per account, so this does not silently mix
            // two accounts' data.
            continue;
        }
        cache.set(key, plain);
        // Rewrite anything that is not this device's envelope yet. Testing
        // `plain === raw` was what broke the non-JSON case: it only matched when
        // decrypt returned its input, which the old `JSON.parse` threw before
        // reaching. The test is on the stored form now, so a bare token or a JSON
        // array is rewritten exactly like JSON-shaped plaintext.
        if (!isEnvelope(rawValue)) {
            localStorage.setItem(key, await encrypt(plain));
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
 * Forget every value this device stored for the signed-in account.
 *
 * The web build keeps records in localStorage by design (offline use, and the next
 * sign-in on the same browser is expected to find them). That design has a cost on a
 * shared browser: anyone who opens DevTools reads the previous user's history. So
 * "sign out" keeps them — the default — and "sign out and clear this device" calls
 * this.
 *
 * What goes: every account-namespaced key (`hrt-u…`), the medication plan, the share
 * keys that can re-seal a live link, the push token and the pending-unregister
 * record, and the legacy free-text reminder list. What stays: the five boot keys
 * (theme, language, lock flag) — clearing them would reset the device's appearance
 * for no privacy gain — plus the reminder bookkeeping explained below.
 */
export async function clearAccountData(): Promise<void> {
  // Land any ciphertext still on the microtask queue first: `set` writes
  // asynchronously, and a write that resolved after this loop would put a key back
  // that the user just asked to delete.
  await flushSecureStore();
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || BOOT_KEYS.has(key)) continue;
    // The plan itself is `hrt-med-plan` / `hrt-med-plan-at` (signed out) or
    // `hrt-u<id>-med-plan…` (already covered by the prefix). Its *bookkeeping* —
    // notification ids, the "reminders off" switch, migration flags, the dedup
    // ledger — deliberately survives: it carries no health data, and dropping the id
    // list would leave already-scheduled rings uncancellable.
    const isPlanData = key === 'hrt-med-plan'
      || key === 'hrt-med-plan-at'
      || key === 'hrt-med-plan-cleared-at';
    if (
      key.startsWith('hrt-u')
      || isPlanData
      || key.startsWith('hrt-share-key-')
      || key.startsWith('avatar-cache-v1:')
      || key === 'hrt-med-reminders'
      || key === 'hrt-fcm-token'
      || key === 'hrt-push-unregister-pending'
      || key === 'hrt_core_token'
      || key === 'hrt_core_user'
    ) {
      doomed.push(key);
    }
  }
  for (const key of doomed) {
    cache.delete(key);
    localStorage.removeItem(key);
  }
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