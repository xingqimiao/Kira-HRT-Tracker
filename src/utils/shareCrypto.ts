/**
 * Share-link payload encryption, in the browser.
 *
 * ── What this buys, and what it does not ─────────────────────────────────────
 *
 * A share is meant to be readable by whoever holds the link, so this is not an
 * access control. What it removes is the *server's* copy: the snapshot is sealed
 * here with a key that is generated here, the server stores an opaque envelope, and
 * the key travels only in the URL fragment (`#k=…`), which browsers never send in a
 * request. The database, its backups and any proxy log hold ciphertext.
 *
 * It is not a promise that nobody can read a share. The link *is* the key: whoever
 * receives the URL can open it, and forwarding the URL forwards that ability — the
 * same bearer property a plain share link always had. It also cannot be the server's
 * job any more to check that a snapshot contains no lab results (that check is
 * `assertShareable`, and it can only run on plaintext); the app builds the snapshot
 * from doses and the curve alone, and that is now the only guarantee.
 *
 * ── Why AES-GCM, and why the format looks like this ──────────────────────────
 *
 * AES-256-GCM is what the Web Crypto API and the rest of this app already use, and
 * its authentication tag means a tampered or truncated envelope fails to open rather
 * than producing a plausible-looking dose. The ciphertext Web Crypto returns already
 * ends with the tag, so this format is `iv` and `ct` — deliberately *not* the
 * server's `iv:tag:ct` string, which would need the tag split out and would invite
 * reusing that parser across the two layers.
 *
 * Base64**url** throughout, because the key is pasted into a URL.
 */

/** The envelope the server stores and hands back. Opaque to it by design. */
export interface SealedSnapshot {
    v: 1;
    alg: 'AES-256-GCM';
    /** Base64url, 12 bytes. */
    iv: string;
    /** Base64url ciphertext with the 16-byte GCM tag appended. */
    ct: string;
}

const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
/** The fragment parameter the key travels in. */
const HASH_PARAM = 'k=';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toB64Url = (bytes: Uint8Array): string => {
    let raw = '';
    for (const byte of bytes) raw += String.fromCharCode(byte);
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64Url = (value: string): Uint8Array => {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
};

/** A fresh 32-byte key, base64url. */
export function createShareKey(): string {
    return toB64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** Whether a value is one of our envelopes, without attempting to open it. */
export function isSealedSnapshot(value: unknown): value is SealedSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Partial<SealedSnapshot>;
    if (candidate.v !== 1 || candidate.alg !== 'AES-256-GCM') return false;
    if (typeof candidate.iv !== 'string' || typeof candidate.ct !== 'string') return false;
    try {
        return fromB64Url(candidate.iv).length === IV_BYTES
            && fromB64Url(candidate.ct).length > TAG_BYTES;
    } catch {
        return false;
    }
}

async function importKey(key: string): Promise<CryptoKey> {
    const raw = fromB64Url(key);
    if (raw.length !== KEY_BYTES) throw new Error('share key must be 32 bytes');
    return await crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
    ]);
}

/** Seal one snapshot. A fresh random IV per call — never derived, never reused. */
export async function sealShareSnapshot(snapshot: unknown, key: string): Promise<SealedSnapshot> {
    const cryptoKey = await importKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const bytes = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        cryptoKey,
        encoder.encode(JSON.stringify(snapshot)),
    );
    return {
        v: 1,
        alg: 'AES-256-GCM',
        iv: toB64Url(iv),
        ct: toB64Url(new Uint8Array(bytes)),
    };
}

/**
 * Open a sealed snapshot.
 *
 * Throws on anything unexpected — a wrong key, a truncated envelope, a tampered
 * ciphertext. Callers must treat that as "this link cannot be opened", never as an
 * empty snapshot: showing an empty chart would look like the sharer's history was
 * deleted.
 */
export async function openShareSnapshot(sealed: SealedSnapshot, key: string): Promise<unknown> {
    if (!isSealedSnapshot(sealed)) throw new Error('sealed snapshot is malformed');
    const cryptoKey = await importKey(key);
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64Url(sealed.iv) as unknown as BufferSource },
        cryptoKey,
        fromB64Url(sealed.ct) as unknown as BufferSource,
    );
    return JSON.parse(decoder.decode(plain));
}

/** The key carried by a URL fragment, or null when there is none. */
export function shareKeyFromHash(hash: string): string | null {
    const fragment = hash.replace(/^#/, '');
    if (!fragment) return null;
    for (const part of fragment.split('&')) {
        if (!part.startsWith(HASH_PARAM)) continue;
        const value = part.slice(HASH_PARAM.length);
        // 32 random bytes are 43 base64url characters. Anything else is a paste error,
        // and failing here is better than failing after a decrypt attempt.
        return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
    return null;
}

/** A share URL with its key appended, replacing any fragment already there. */
export function withShareKey(url: string, key: string): string {
    const base = url.split('#')[0];
    return `${base}#${HASH_PARAM}${key}`;
}
