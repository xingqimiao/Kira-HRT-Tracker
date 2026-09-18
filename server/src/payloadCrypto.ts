/**
 * Record payload encryption, server-side.
 *
 * ── What this is, and what it is not ──────────────────────────────────────────
 *
 * This is **encryption at rest with a server-held key**, not end-to-end encryption.
 * The server can decrypt every record it stores, because it is the server that
 * decrypts them on read. That is the deliberate architecture: a cloud-hosted product
 * where the operator holds the key, so the operator can also help when something goes
 * wrong. Nobody should read `ENCRYPTION_KEY` and conclude the operator cannot see the
 * data — the honest claim is "a stolen database dump is useless without this key", and
 * that is the claim this module delivers.
 *
 * ── Why the payload is one blob ──────────────────────────────────────────────
 *
 * Addressing (which user, when) stays in plaintext columns so the database can index
 * and paginate. Everything a person typed — medication names, doses, lab values,
 * free-text notes — goes into one JSON blob and is encrypted whole. Per-field
 * encryption would leak the shape of every record (which fields exist, how many), and
 * buys nothing here because the same process holds the key either way.
 *
 * ── Format ───────────────────────────────────────────────────────────────────
 *
 * `"iv:tag:ciphertext"`, each part base64. AES-256-GCM, so the ciphertext carries an
 * authentication tag: a modified value fails to decrypt rather than producing a
 * plausible-looking dose. For medication history that distinction matters — refusing
 * to read is far better than confidently reading the wrong number.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-GCM's standard nonce length. 96 bits is the size GCM is specified around. */
const IV_BYTES = 12;

/** AES-256: the key must be exactly this long. */
const KEY_BYTES = 32;

/** GCM's authentication tag. */
const TAG_BYTES = 16;

/**
 * The master key, from the environment.
 *
 * Accepts base64 or hex, because both are things people paste into a `.env`. A wrong
 * length is rejected here rather than at the first request: a 16-byte value would
 * otherwise fail per write, or be silently stretched into something that looks like it
 * works, and either way the failure would surface as "records won't save" long after
 * deployment.
 *
 * Called at startup, not per request — see `requireEncryptionKey`.
 */
export function keyFromEnv(raw: string | undefined): Buffer {
    if (!raw || raw.trim() === '') {
        throw new Error('ENCRYPTION_KEY is required (32 bytes, base64 or hex)');
    }

    const value = raw.trim();
    const isHex = /^[0-9a-fA-F]{64}$/.test(value);
    const key = Buffer.from(value, isHex ? 'hex' : 'base64');

    if (key.length !== KEY_BYTES) {
        throw new Error(
            `ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. `
            + 'Generate one with: openssl rand -base64 32',
        );
    }
    return key;
}

/** Serialise a record for storage. Stable enough that the same input seals twice. */
function serialise(payload: unknown): Buffer {
    return Buffer.from(JSON.stringify(payload), 'utf8');
}

/**
 * Seal one record's payload.
 *
 * A fresh random IV per call, never derived and never reused: reusing a nonce under
 * one key breaks GCM's confidentiality *and* its authentication, and it would also
 * make two identical records visibly identical in the column.
 */
export function encryptPayload(payload: unknown, key: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(serialise(payload)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Open one record's payload.
 *
 * Throws if the tag does not verify or the key is wrong. Callers must treat a throw as
 * "this row is unreadable", not as "this row is empty" — the two need different
 * answers, and only one of them is safe to show a user.
 */
export function decryptPayload(sealed: string, key: Buffer): unknown {
    if (typeof sealed !== 'string') {
        throw new Error('sealed payload must be a string');
    }

    const parts = sealed.split(':');
    if (parts.length !== 3) {
        throw new Error('sealed payload must have the form iv:tag:ciphertext');
    }

    const [ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');

    if (iv.length !== IV_BYTES) {
        throw new Error(`sealed payload has a ${iv.length}-byte IV, expected ${IV_BYTES}`);
    }
    if (tag.length !== TAG_BYTES) {
        throw new Error(`sealed payload has a ${tag.length}-byte tag, expected ${TAG_BYTES}`);
    }
    if (ciphertext.length === 0) {
        throw new Error('sealed payload has an empty ciphertext');
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

/**
 * Whether a string looks like a sealed payload, without attempting to open it.
 *
 * Lengths are checked, not just the three-part shape: a truncated or hand-edited value
 * should be reported as malformed by whatever is diagnosing the row, rather than being
 * handed to `decryptPayload` and surfacing as a generic authentication failure.
 */
export function isEncryptedPayload(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const parts = value.split(':');
    if (parts.length !== 3) return false;
    return Buffer.from(parts[0], 'base64').length === IV_BYTES
        && Buffer.from(parts[1], 'base64').length === TAG_BYTES
        && Buffer.from(parts[2], 'base64').length > 0;
}
