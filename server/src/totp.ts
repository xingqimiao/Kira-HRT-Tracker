/**
 * TOTP second factor, and the recovery codes beside it.
 *
 * RFC 6238 over SHA-1 with a 30-second step and 6 digits — the combination every
 * authenticator app defaults to. Implemented on `node:crypto` rather than pulled
 * from npm: the algorithm is twenty lines (HMAC, then a dynamic truncation), and
 * a second factor is exactly the wrong place to add a dependency whose transitive
 * tree nobody re-reads.
 *
 * Two properties this file is responsible for, and neither is optional:
 *
 *   - **Secrets are encrypted at rest.** A leaked database dump that carries TOTP
 *     secrets in the clear removes the second factor for every account at once,
 *     silently — everyone still has 2FA "enabled". Secrets are sealed under a key
 *     from the environment, so a dump alone is not enough to mint codes.
 *   - **Verification is constant-time and rate-limited by the caller.** Comparison
 *     goes through `timingSafeEqual`, and each account may only try a handful of
 *     codes per window. Without that limit a six-digit code is 10^6 guesses
 *     against a 30-second window, which is minutes of work, not years.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** Accept the neighbouring steps: real clocks drift, and the phone is not the server's clock. */
const WINDOW_STEPS = 1;

// ---------------------------------------------------------------------------
// Base32 (RFC 4648) — what authenticator apps accept as a secret
// ---------------------------------------------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = B32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Secret encryption at rest
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte key from the configured secret.
 *
 * A fixed salt is acceptable here where it would not be for a password: the input
 * is a high-entropy machine secret, not a human-chosen one, so there is no
 * dictionary to attack and nothing for a per-record salt to defend against.
 */
async function encKey(rawKey: string): Promise<Buffer> {
  return (await scryptAsync(rawKey, 'hrt-totp-secret-v1', 32)) as Buffer;
}

/** Seal a TOTP secret into a self-describing envelope: `v1.<iv>.<ciphertext>`. */
export async function sealTotpSecret(secret: string, rawKey: string): Promise<string> {
  const key = await encKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${Buffer.concat([sealed, tag]).toString('base64url')}`;
}

/**
 * Open a sealed secret.
 *
 * Returns null on anything unreadable — a wrong key, a truncated field, a value
 * written by a future version. Callers must treat null as "cannot verify this
 * user's codes" and fail closed, never as "no secret, so skip the check".
 */
export async function openTotpSecret(sealed: string, rawKey: string): Promise<string | null> {
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const key = await encKey(rawKey);
    const iv = Buffer.from(parts[1], 'base64url');
    const body = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || body.length <= 16) return null;
    const tag = body.subarray(body.length - 16);
    const ciphertext = body.subarray(0, body.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM tag mismatch is the expected path for a wrong key or a tampered value.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Code generation and verification
// ---------------------------------------------------------------------------

/** A fresh 20-byte secret (160 bits, the RFC 4226 recommendation). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Uint8Array, counter: number): string {
  const buffer = Buffer.alloc(8);
  // Counter is written big-endian across two 32-bit halves; JS bitwise ops are
  // 32-bit, so the high word must be built by division rather than a shift.
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', secret).update(buffer).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks the
  // 4-byte window, and its top bit is masked so the value stays positive.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code for a given moment. Exported for tests and for server-side clock checks. */
export function totpCodeAt(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * Verify a submitted code, allowing one step of drift either side.
 *
 * Constant-time per candidate step. The comparison is length-guarded first
 * because `timingSafeEqual` throws on a length mismatch, which would otherwise
 * turn a short code into a 500 rather than a rejection.
 */
export function verifyTotpCodeWithStep(
  secretBase32: string,
  submitted: string,
  atMs: number = Date.now(),
): number | null {
  const cleaned = submitted.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return null;

  let secret: Uint8Array;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }
  if (secret.length === 0) return null;

  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  const given = Buffer.from(cleaned, 'utf8');
  let matchedStep: number | null = null;
  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset++) {
    const step = counter + offset;
    const candidate = Buffer.from(hotp(secret, step), 'utf8');
    if (candidate.length === given.length && timingSafeEqual(candidate, given)) {
      // No early return: the loop's duration must not reveal which step matched.
      // The *highest* matching step is kept, so an older code cannot slip through
      // a replay check that compares against a lower recorded step.
      if (matchedStep === null || step > matchedStep) matchedStep = step;
    }
  }
  return matchedStep;
}

/** Convenience boolean form. See `verifyTotpCodeWithStep` for the replay-safe variant. */
export function verifyTotpCode(secretBase32: string, submitted: string, atMs: number = Date.now()): boolean {
  return verifyTotpCodeWithStep(secretBase32, submitted, atMs) !== null;
}

/** The `otpauth://` URI an authenticator app scans. */
export function otpauthUri(params: {
  secretBase32: string;
  accountLabel: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountLabel}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * How many recovery codes an account gets.
 *
 * Single-use, so this is also the number of times someone can lose their phone
 * before they are locked out — ten is the conventional figure and matches what
 * the app's UI already implies (it showed a list of codes).
 */
export const BACKUP_CODE_COUNT = 10;

/** `XXXXX-XXXXX` from a 30-bit alphabet — 50 bits of entropy, unambiguous characters. */
function generateBackupCode(): string {
  // Excludes I, O, 0 and 1: these get read aloud and typed by hand, and those four
  // are the pairs people transcribe wrongly.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += alphabet[bytes[i] % alphabet.length];
    if (i === 4) code += '-';
  }
  return code;
}

export interface GeneratedBackupCodes {
  /** Shown to the user exactly once. Never stored in this form. */
  plaintext: string[];
  /** What is persisted — one entry per code. */
  hashes: string[];
}

/**
 * Mint recovery codes.
 *
 * Hashed with scrypt, the same treatment as a password, because a recovery code is
 * a password: it is long-lived, single-use, and bypasses the second factor. Storing
 * them reversibly would make a database dump equivalent to holding ten spare keys.
 */
export async function generateBackupCodes(): Promise<GeneratedBackupCodes> {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = generateBackupCode();
    plaintext.push(code);
    hashes.push(await hashBackupCode(code));
  }
  return { plaintext, hashes };
}

export async function hashBackupCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  // Normalised before hashing so a user typing `abcd-efghi` in either case works,
  // and the hyphen is optional — both are things people get wrong under stress.
  const normalised = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const derived = (await scryptAsync(normalised, salt, 32)) as Buffer;
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyBackupCode(code: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const normalised = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const derived = (await scryptAsync(normalised, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export { DIGITS, PERIOD_SECONDS };
