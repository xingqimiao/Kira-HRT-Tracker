/**
 * Accounts: password + mandatory TOTP, with X OAuth as an optional assist.
 *
 * The product rule this file enforces, stated once so the rest reads clearly:
 *
 *   **An account is usable only when it has a password AND TOTP enabled.**
 *   X login can create an account and can log into a complete one, but it can
 *   never produce a usable account on its own. A user who registers through X is
 *   walked straight into setting a password and enrolling TOTP, and cannot read or
 *   write a single record until both are done.
 *
 * That rule is not a policy bolted on top — it falls out of the key design. The
 * data key (DEK) is wrapped under a password-derived key (KEK), so an account with
 * no password has no key and therefore no readable data. This is what makes "the X
 * account gets banned" a non-event: losing X loses a login button, not the record.
 *
 * Second-factor rules, and why each is where it is:
 *
 *   - TOTP codes are verified replay-safely. `totp_last_step` must strictly
 *     increase, so a code observed once cannot be reused inside its own 30-second
 *     validity window.
 *   - Recovery codes are single-use, hashed like passwords, and consumed inside
 *     the same transaction that authenticates them — two concurrent submissions of
 *     one code must not both succeed.
 *   - Failed unlocks are counted per account with a lockout, on top of the
 *     per-IP limiter in the HTTP layer. Per-IP alone is defeated by a botnet;
 *     per-account alone lets an attacker spray many accounts.
 */
import { randomUUID, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { getPool, withTransaction } from './db.ts';
import { getConfig } from './config.ts';
import { settings } from './store.ts';
import {
  createUserKeyMaterial,
  unwrapDek,
  rewrapForNewPassword,
  openSession,
  closeSession,
  closeUserSessions,
  findUserSession as findUserSessionFor,
  lookupSession,
  openPendingEnrollment,
  takePendingEnrollment,
  openPendingSetup,
  takePendingSetup,
  issueOneTimeCode,
  redeemOneTimeCode,
  readMetadata,
  createKeyMaterial,
  unwrapWithPassword,
  unwrapWithRecovery,
  unwrapWithServer,
  addServerWrapper,
  addRecoveryWrapper,
  stripServerWrapper,
  setPasswordWrapper,
  generateRecoveryKey,
  passwordEnvelopeOf,
  openLockedSession,
  peekLockedSession,
  redeemLockedSession,
  type EncryptionMetadata,
} from './session.ts';
import {
  generateTotpSecret,
  sealTotpSecret,
  openTotpSecret,
  verifyTotpCodeWithStep,
  otpauthUri,
  generateBackupCodes,
  verifyBackupCode,
  hashBackupCode,
} from './totp.ts';
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeCode,
  fetchProfile,
  generateCodeVerifier,
  generateState,
  isXConfigured,
  XOAuthError,
  type XProfile,
} from './oauth.ts';
import { parseBodyWeight, parsePKParams } from './domain.ts';
import type { Result } from './domain.ts';
import type { AuthContext } from './types.ts';
import { CALIBRATION_METHODS } from './engine.ts';
import type { PKCustomParams } from './engine.ts';

const scryptAsync = promisify(scrypt);

/** How long an account may stay unconfirmed before its username can be reused. */
const PENDING_REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Failed unlocks before the account locks. */
const MAX_FAILED_UNLOCKS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
/** In-flight OAuth authorizations. Long enough to scan a QR / read a consent screen. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const ISSUER = 'Kira Tracker';

export type PrivacyMode = 'standard' | 'advanced';

function validatePrivacyMode(raw: unknown): Result<PrivacyMode> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 'standard' };
  if (raw === 'standard' || raw === 'advanced') return { ok: true, value: raw };
  return { ok: false, error: "privacy_mode: must be 'standard' or 'advanced'" };
}

/**
 * Build the key material for a new account in the chosen mode.
 *
 * Standard mode adds a `server` wrapper under the deployment's server key, which is
 * what makes the account recoverable (and what lets a live `hrt_` token reach the
 * data. Advanced mode omits it. The DEK is the same either way — only its wrappers
 * differ, which is why switching modes later never touches a record.
 */
async function buildKeyMaterial(
  password: string,
  userId: string,
  mode: PrivacyMode,
): Promise<{ metadata: EncryptionMetadata; dek: string }> {
  const serverKey = mode === 'standard' ? getConfig().serverDekKey : null;
  return await createKeyMaterial(password, userId, { serverKey });
}

export interface AccountRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string | null;
  password_set_at: Date | null;
  wrapped_dek: unknown;
  privacy_mode: PrivacyMode;
  encryption_metadata: unknown;
  totp_secret_sealed: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: string | number | null;
  failed_unlocks: number;
  locked_until: Date | null;
  /** Needed for the deletion tombstone: "how long after signing up do people leave". */
  created_at: Date;
}

export interface EnrollmentMaterial {
  secret: string;
  otpauthUri: string;
  backupCodes: string[];
}

export interface RegistrationResult {
  userId: string;
  username: string;
  /** Present until TOTP is confirmed. The account is not usable before then. */
  enrollmentToken: string;
  totp: EnrollmentMaterial;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function validateUsername(raw: unknown): Result<string> {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{3,30}$/.test(raw)) {
    return { ok: false, error: 'username: 3–30 characters, letters/digits/underscore/hyphen only' };
  }
  return { ok: true, value: raw };
}

function validatePassword(raw: unknown): Result<string> {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 128) {
    return { ok: false, error: 'password: must be 8–128 characters' };
  }
  return { ok: true, value: raw };
}

/** Turn an X handle into a local username that satisfies `validateUsername`. */
function usernameFromHandle(handle: string | null): string {
  const base = (handle ?? 'x')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 24);
  // X permits one-character handles; our minimum is three.
  return base.length >= 3 ? base : `x_${base || 'user'}`.slice(0, 30);
}

async function loadUser(where: { id?: string; username?: string }): Promise<AccountRow | null> {
  const column = where.id ? 'id' : 'username';
  const value = where.id ?? where.username;
  const { rows } = await getPool().query<AccountRow>(
    `SELECT id, username, display_name, password_hash, password_set_at, wrapped_dek,
            privacy_mode, encryption_metadata,
            totp_secret_sealed, totp_enabled_at, totp_last_step, failed_unlocks, locked_until,
            created_at
       FROM users WHERE ${column} = $1`,
    [value],
  );
  return rows[0] ?? null;
}

/** Whether an account has finished setup and may be used at all. */
function isComplete(user: AccountRow): boolean {
  return user.password_set_at !== null && user.totp_enabled_at !== null;
}

/**
 * The account's encryption metadata, tolerating the pre-migration shape.
 *
 * A row written before this release has a populated `wrapped_dek` and an empty
 * `encryption_metadata`; schema.sql backfills it on the next migration, but this
 * falls back anyway so a read never depends on the migration having run. New rows
 * carry both — the metadata is authoritative, `wrapped_dek` stays in step for
 * readers that have not been updated.
 */
function metadataFor(user: AccountRow): EncryptionMetadata {
  const metadata = readMetadata(user.encryption_metadata);
  if (!metadata.wrappers.password && user.wrapped_dek) {
    return { version: metadata.version, dek: metadata.dek, wrappers: { ...metadata.wrappers, password: user.wrapped_dek as never } };
  }
  return metadata;
}

/**
 * Persist a new metadata document, mirroring the password wrapper into `wrapped_dek`.
 *
 * One write rather than two columns drifting apart: the legacy column is derived
 * from the document every time, so it cannot disagree with it.
 */
async function saveMetadata(userId: string, metadata: EncryptionMetadata): Promise<void> {
  const legacy = passwordEnvelopeOf(metadata);
  await getPool().query(
    `UPDATE users SET encryption_metadata = $2, wrapped_dek = $3, updated_at = now() WHERE id = $1`,
    [userId, JSON.stringify(metadata), legacy ? JSON.stringify(legacy) : null],
  );
}

/** The live DEK for an account in standard mode, or null. Server-side only. */
async function serverDekFor(user: AccountRow): Promise<string | null> {
  if (user.privacy_mode !== 'standard') return null;
  return await unwrapWithServer(metadataFor(user), user.id, getConfig().serverDekKey);
}

// ---------------------------------------------------------------------------
// TOTP verification with replay protection
// ---------------------------------------------------------------------------

/**
 * Verify a TOTP code and spend its step.
 *
 * The step is compared and written in one statement with a `WHERE` that requires it
 * to be strictly greater than what is stored. Two concurrent requests carrying the
 * same code therefore cannot both succeed — the database decides, not a read-then-
 * write in application code, which would leave a window between the two.
 */
async function consumeTotpStep(userId: string, sealed: string, code: string): Promise<boolean> {
  const secret = await openTotpSecret(sealed, getConfig().totpEncKey);
  // Fail closed: an unreadable secret means the check cannot be performed, not
  // that the check passes.
  if (secret === null) return false;

  const step = verifyTotpCodeWithStep(secret, code);
  if (step === null) return false;

  const { rowCount } = await getPool().query(
    `UPDATE users SET totp_last_step = $1, updated_at = now()
      WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1)`,
    [step, userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Redeem a recovery code, marking it used in the same statement that matches it.
 *
 * `used_at IS NULL` in the `WHERE` is what makes it single-use under concurrency:
 * a second request with the same code finds no row to update.
 */
async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const { rows } = await getPool().query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM totp_backup_codes
      WHERE user_id = $1 AND used_at IS NULL
      ORDER BY created_at`,
    [userId],
  );
  for (const row of rows) {
    if (!(await verifyBackupCode(code, row.code_hash))) continue;
    const { rowCount } = await getPool().query(
      `UPDATE totp_backup_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
      [row.id],
    );
    // Lost the race to another request carrying the same code.
    if ((rowCount ?? 0) === 0) return false;
    return true;
  }
  return false;
}

async function countUnusedBackupCodes(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM totp_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return Number(rows[0].n);
}

/**
 * Mint the enrolment bundle: a fresh secret, its QR URI, and recovery codes.
 *
 * Pure with respect to the database — it generates and returns, and does not write.
 * That separation is not stylistic: an earlier version wrote the recovery codes
 * here, and on the registration path it ran *before* the user row existed, so the
 * foreign key rejected the insert and every registration failed with a 500. The
 * caller now owns the writes, and on registration they happen inside the same
 * transaction as the user row.
 */
async function buildEnrollment(userId: string): Promise<{
  material: EnrollmentMaterial;
  sealed: string;
  codeHashes: string[];
}> {
  const secret = generateTotpSecret();
  const sealed = await sealTotpSecret(secret, getConfig().totpEncKey);
  const codes = await generateBackupCodes();

  return {
    material: {
      secret,
      otpauthUri: otpauthUri({ secretBase32: secret, accountLabel: userId, issuer: ISSUER }),
      backupCodes: codes.plaintext,
    },
    sealed,
    codeHashes: codes.hashes,
  };
}

/**
 * Replace an account's unused recovery codes.
 *
 * Only the unused ones: a code that was already spent is a historical fact and is
 * kept so the audit trail shows it was used.
 */
async function replaceRecoveryCodes(
  userId: string,
  codeHashes: string[],
  client?: { query: (text: string, values?: unknown[]) => Promise<unknown> },
): Promise<void> {
  const q = client ?? getPool();
  await q.query(`DELETE FROM totp_backup_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  for (const hash of codeHashes) {
    await q.query(`INSERT INTO totp_backup_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, hash]);
  }
}

// ---------------------------------------------------------------------------
// AccountService
// ---------------------------------------------------------------------------

export interface UnlockedAccount {
  userId: string;
  username: string;
  token: string;
  /** Set when a recovery code was used, so the UI can say how many remain. */
  recoveryCodesRemaining?: number;
}

export const AccountService = {
  // --- Registration and enrolment -----------------------------------------

  /**
   * Create an account.
   *
   * Returns enrolment material but does NOT return a usable token: TOTP is
   * mandatory, so the account stays unusable until a code from the new secret is
   * confirmed. Registering and being immediately logged in would mean the second
   * factor could be skipped entirely by anyone who knows the password.
   */
  async register(
    usernameRaw: unknown,
    passwordRaw: unknown,
    opts: { privacyMode?: unknown } = {},
  ): Promise<Result<RegistrationResult>> {
    const username = validateUsername(usernameRaw);
    if (!username.ok) return username;
    const password = validatePassword(passwordRaw);
    if (!password.ok) return password;
    const privacyMode = validatePrivacyMode(opts.privacyMode);
    if (!privacyMode.ok) return privacyMode;

    const userId = randomUUID();
    const { metadata, dek } = await buildKeyMaterial(password.value, userId, privacyMode.value);
    const passwordHash = await hashPassword(password.value);
    const { material, sealed, codeHashes } = await buildEnrollment(userId);

    try {
      // One transaction for the user row and its recovery codes. The codes have a
      // foreign key onto the user, so writing them outside this block fails — and
      // splitting them would let a crash leave an account with no recovery codes,
      // discoverable only after someone loses their phone.
      await withTransaction(async (client) => {
        // An abandoned registration should not squat its username forever, so an
        // unconfirmed row past the TTL is replaced. A *confirmed* account is never
        // touched — that would be account takeover.
        const existing = await client.query<AccountRow>(
          `SELECT id, totp_enabled_at, created_at FROM users WHERE username = $1 FOR UPDATE`,
          [username.value],
        );
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          const abandoned =
            row.totp_enabled_at === null &&
            Date.now() - new Date(row.created_at as unknown as string).getTime() > PENDING_REGISTRATION_TTL_MS;
          if (!abandoned) {
            throw Object.assign(new Error('username is already taken'), { taken: true });
          }
          await client.query(`DELETE FROM users WHERE id = $1`, [row.id]);
        }

        await client.query(
          `INSERT INTO users (id, username, password_hash, password_set_at, wrapped_dek,
                              privacy_mode, encryption_metadata, totp_secret_sealed, failed_unlocks)
           VALUES ($1, $2, $3, now(), $4, $5, $6, $7, 0)`,
          [
            userId,
            username.value,
            passwordHash,
            JSON.stringify(passwordEnvelopeOf(metadata)),
            privacyMode.value,
            JSON.stringify(metadata),
            sealed,
          ],
        );
        await replaceRecoveryCodes(userId, codeHashes, client);
      });
    } catch (error) {
      if ((error as { taken?: boolean }).taken) {
        return { ok: false, error: 'username is already taken' };
      }
      if ((error as { code?: string }).code === '23505') {
        return { ok: false, error: 'username is already taken' };
      }
      throw error;
    }

    await settings.upsert(userId, { hrtMode: 'transfem' }).catch(() => undefined);

    // The DEK is handed straight to the enrolment store, so confirming the second
    // factor can open a session without the password being sent a second time. It
    // was minted above and never needed unwrapping, which is also why the old
    // unwrap-immediately-after-insert dance is gone — it only existed to prove the
    // wrapping round-tripped, and `unwrapWithPassword` is covered by its own tests.
    const enrollmentToken = openPendingEnrollment(userId, requireKey(dek, 'registration'));

    return {
      ok: true,
      value: { userId, username: username.value, enrollmentToken, totp: material },
    };
  },

  /**
   * Resume an abandoned enrolment.
   *
   * Without this, someone who closed the tab between registering and confirming
   * would be stuck for the registration TTL with a username they cannot reuse.
   * Requires the password, so it grants nothing an attacker without it could get.
   */
  async resumeEnrollment(usernameRaw: unknown, passwordRaw: unknown): Promise<Result<RegistrationResult>> {
    const username = validateUsername(usernameRaw);
    if (!username.ok) return username;
    const password = validatePassword(passwordRaw);
    if (!password.ok) return password;

    const user = await loadUser({ username: username.value });
    const generic = { ok: false as const, error: 'invalid credentials' };
    if (!user) {
      await verifyPassword(password.value, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      return generic;
    }
    if (!(await verifyPassword(password.value, user.password_hash))) return generic;
    if (user.totp_enabled_at !== null) {
      return { ok: false, error: 'this account is already set up; sign in normally' };
    }

    // A resume mints a new secret, so the codes from the abandoned attempt must go:
    // two live sets would mean a code the user wrote down no longer matching the
    // secret it was issued with.
    const { material, sealed, codeHashes } = await buildEnrollment(user.id);
    await withTransaction(async (client) => {
      await client.query(`UPDATE users SET totp_secret_sealed = $1, updated_at = now() WHERE id = $2`, [sealed, user.id]);
      await replaceRecoveryCodes(user.id, codeHashes, client);
    });

    // The DEK is recoverable because the password is right here — the KEK wraps it.
    const dek = await unwrapDek(user.wrapped_dek, password.value, user.id);
    if (dek === null) return { ok: false, error: 'account key material is unreadable' };

    return {
      ok: true,
      value: {
        userId: user.id,
        username: user.username,
        enrollmentToken: openPendingEnrollment(user.id, requireKey(dek, 'resumeEnrollment')),
        totp: material,
      },
    };
  },

  /**
   * Finish enrolment: confirm a code from the new secret.
   *
   * Only here does the account become usable, and only here is a session opened.
   */
  async confirmEnrollment(enrollmentToken: string, code: unknown): Promise<Result<UnlockedAccount>> {
    const pending = takePendingEnrollment(enrollmentToken);
    if (!pending) {
      return { ok: false, error: 'enrolment expired or already completed; sign in to try again' };
    }
    if (typeof code !== 'string') return { ok: false, error: 'code: required' };

    const user = await loadUser({ id: pending.userId });
    if (!user || !user.totp_secret_sealed) return { ok: false, error: 'account not found' };

    const secret = await openTotpSecret(user.totp_secret_sealed, getConfig().totpEncKey);
    if (secret === null) return { ok: false, error: 'could not read the enrolment secret' };
    const step = verifyTotpCodeWithStep(secret, code);
    if (step === null) return { ok: false, error: 'that code is not valid — check the device clock' };

    // `totp_last_step` is deliberately NOT recorded here, unlike at login.
    //
    // Recording it would mean the confirming code is spent, so a user who finishes
    // signup and then signs in on a second device within the same 30-second window
    // is told their code is invalid — which reads as "setup failed", not "wait a
    // moment". Nothing is weakened by omitting it: confirming requires the
    // single-use enrolment token, so the code cannot be replayed *here*, and the
    // step is still spent the first time it is used to actually sign in. The replay
    // guard exists to stop a code from repeatedly opening access, and enrolment
    // opens no access to records.
    await getPool().query(
      `UPDATE users SET totp_enabled_at = now(), failed_unlocks = 0, updated_at = now()
        WHERE id = $1`,
      [user.id],
    );
    await this.recordAuthEvent(user.id, 'totp_enabled');

    const token = openSession(user.id, requireKey(pending.dek, 'confirmEnrollment'), getConfig().sessionTtlMinutes);
    return { ok: true, value: { userId: user.id, username: user.username, token } };
  },

  // --- Unlock -------------------------------------------------------------

  /**
   * Sign in with a password, and a TOTP code or a recovery code.
   *
   * Every failure path returns the same message, and the password is verified even
   * when the account does not exist, so the endpoint cannot be used to enumerate
   * usernames or to learn which accounts have passed enrolment.
   */
  async unlock(
    usernameRaw: unknown,
    passwordRaw: unknown,
    opts: { code?: unknown; backupCode?: unknown } = {},
  ): Promise<Result<UnlockedAccount>> {
    const generic = { ok: false as const, error: 'invalid credentials' };
    const username = validateUsername(usernameRaw);
    if (!username.ok) return generic;
    const password = validatePassword(passwordRaw);
    if (!password.ok) return generic;

    const user = await loadUser({ username: username.value });
    if (!user) {
      await verifyPassword(password.value, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      return generic;
    }

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return { ok: false, error: 'too many failed attempts; try again later' };
    }

    if (!(await verifyPassword(password.value, user.password_hash))) {
      await this.noteFailedUnlock(user.id);
      return generic;
    }

    // A password without a completed second factor must not be enough. An account
    // stuck here is one whose enrolment was abandoned; say so plainly, with the
    // resume path, rather than reporting a wrong password that is actually right.
    if (user.totp_enabled_at === null || !user.totp_secret_sealed) {
      return {
        ok: false,
        // Path relative to the service mount — the deployment's prefix (e.g. /hrt)
        // is not this layer's business, and hardcoding one would make the message
        // wrong on any host that mounts the service elsewhere.
        error: 'second-factor setup was not completed; POST /auth/totp/resume to finish it',
      };
    }

    const usingBackup = typeof opts.backupCode === 'string' && opts.backupCode.length > 0;
    if (usingBackup) {
      if (!(await consumeBackupCode(user.id, opts.backupCode as string))) {
        await this.noteFailedUnlock(user.id);
        return generic;
      }
      await this.recordAuthEvent(user.id, 'unlock_backup_code');
    } else {
      if (typeof opts.code !== 'string' || opts.code.length === 0) {
        // Distinguishable from a bad code on purpose: the client needs to know to
        // prompt for one, and at this point the password is already proven.
        return { ok: false, error: 'two_factor_required' };
      }
      if (!(await consumeTotpStep(user.id, user.totp_secret_sealed, opts.code))) {
        await this.noteFailedUnlock(user.id);
        return generic;
      }
    }

    const metadata = metadataFor(user);
    const dek = await unwrapWithPassword(metadata, password.value, user.id);
    if (dek === null) {
      return { ok: false, error: 'account key material is unreadable; set a new password to re-key it' };
    }

    await getPool().query(`UPDATE users SET failed_unlocks = 0, locked_until = NULL WHERE id = $1`, [user.id]);

    // Standard mode promises the account is recoverable, so a standard account must
    // carry the server wrapper. Accounts created before this release do not; a
    // password unlock is the one moment the key is in hand to add it without asking
    // the user for anything twice.
    const serverKey = getConfig().serverDekKey;
    if (user.privacy_mode === 'standard' && !metadata.wrappers.server && serverKey) {
      await saveMetadata(user.id, await addServerWrapper(metadata, dek, user.id, serverKey));
    }

    const token = openSession(user.id, requireKey(dek, 'unlock'), getConfig().sessionTtlMinutes);
    await this.recordAuthEvent(user.id, 'unlock');

    const remaining = usingBackup ? await countUnusedBackupCodes(user.id) : undefined;
    return {
      ok: true,
      value: {
        userId: user.id,
        username: user.username,
        token,
        ...(remaining !== undefined ? { recoveryCodesRemaining: remaining } : {}),
      },
    };
  },

  /** Count a failure and lock the account once the budget is spent. */
  async noteFailedUnlock(userId: string): Promise<void> {
    await getPool().query(
      `UPDATE users
          SET failed_unlocks = failed_unlocks + 1,
              locked_until = CASE WHEN failed_unlocks + 1 >= $2 THEN now() + ($3 || ' milliseconds')::interval
                                  ELSE locked_until END,
              updated_at = now()
        WHERE id = $1`,
      [userId, MAX_FAILED_UNLOCKS, String(LOCKOUT_MS)],
    );
  },

  // --- Data unlock (separate from authentication) -------------------------
  //
  // Advanced mode splits "who you are" from "can this device read your records".
  // X + TOTP answers the first; these methods answer the second. Keeping them
  // distinct is the whole point of the mode — an authenticated session that holds
  // no key is a legitimate state, not a failure.

  /**
   * Unlock data from an authenticated-but-locked session, using one factor.
   *
   * The locked token stands in for the identity that X proved, so the factor here
   * is a *data* credential — the account password or a recovery key — not the
   * second factor (that was already spent proving identity). The token is spent
   * only after the factor succeeds, so a mistyped password does not cost a new X
   * round-trip.
   */
  async unlockData(
    lockedToken: unknown,
    factor: unknown,
    secretRaw: unknown,
  ): Promise<Result<UnlockedAccount>> {
    if (typeof lockedToken !== 'string') return { ok: false, error: 'data_unlock_required' };
    if (factor !== 'password' && factor !== 'recovery') {
      return { ok: false, error: "factor: must be 'password' or 'recovery'" };
    }
    const userId = peekLockedSession(lockedToken);
    if (!userId) return { ok: false, error: 'this session expired; sign in again' };
    if (typeof secretRaw !== 'string' || secretRaw.length === 0) {
      return { ok: false, error: factor === 'password' ? 'password: required' : 'recovery key: required' };
    }

    const user = await loadUser({ id: userId });
    if (!user) return { ok: false, error: 'account not found' };
    const metadata = metadataFor(user);

    const dek =
      factor === 'password'
        ? await unwrapWithPassword(metadata, secretRaw, user.id)
        : await unwrapWithRecovery(metadata, secretRaw, user.id);
    if (dek === null) {
      await this.noteFailedUnlock(user.id);
      return { ok: false, error: factor === 'password' ? 'invalid credentials' : 'that recovery key is not valid' };
    }

    redeemLockedSession(lockedToken);
    await getPool().query(`UPDATE users SET failed_unlocks = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await this.recordAuthEvent(user.id, factor === 'password' ? 'data_unlock_password' : 'data_unlock_recovery');
    const token = openSession(user.id, requireKey(dek, 'unlockData'), getConfig().sessionTtlMinutes);
    return { ok: true, value: { userId: user.id, username: user.username, token } };
  },

  /**
   * Switch privacy mode.
   *
   * The DEK does not change and no record is touched: standard adds a server
   * wrapper, advanced drops it. That is the entire operation, which is why it is a
   * metadata rewrite rather than a re-encryption — see the spec's requirement that
   * a switch must not regenerate the DEK.
   *
   * Requires the *current password* (not a TOTP code): lowering the mode reduces
   * privacy, raising it changes which wrappers exist, and both are changes to how
   * the data key is protected, so the check is against the credential that protects
   * it. The server wrapper is the one case that needs no password of its own — the
   * live session already holds the DEK.
   */
  async switchPrivacyMode(
    ctx: AuthContext,
    modeRaw: unknown,
    currentPasswordRaw: unknown,
  ): Promise<Result<{ privacyMode: PrivacyMode }>> {
    const mode = validatePrivacyMode(modeRaw);
    if (!mode.ok) return mode;
    if (modeRaw === undefined || modeRaw === null || modeRaw === '') {
      return { ok: false, error: 'privacy_mode: required' };
    }

    const user = await loadUser({ id: ctx.userId });
    if (!user) return { ok: false, error: 'account not found' };
    if (!(await verifyPassword(String(currentPasswordRaw), user.password_hash))) {
      await this.noteFailedUnlock(user.id);
      return { ok: false, error: 'current password is incorrect' };
    }
    if (user.privacy_mode === mode.value) {
      return { ok: true, value: { privacyMode: mode.value } };
    }

    const metadata = metadataFor(user);
    if (mode.value === 'standard') {
      const serverKey = getConfig().serverDekKey;
      if (!serverKey) {
        return { ok: false, error: 'standard mode is not available on this server' };
      }
      await saveMetadata(user.id, await addServerWrapper(metadata, ctx.dek, user.id, serverKey));
    } else {
      await saveMetadata(user.id, stripServerWrapper(metadata));
    }

    await getPool().query(`UPDATE users SET privacy_mode = $2, updated_at = now() WHERE id = $1`, [
      user.id,
      mode.value,
    ]);
    await this.recordAuthEvent(user.id, mode.value === 'advanced' ? 'privacy_advanced' : 'privacy_standard');
    return { ok: true, value: { privacyMode: mode.value } };
  },

  /**
   * Create or replace the recovery key for an advanced account.
   *
   * The plaintext is returned exactly once and never stored — only its wrapper is.
   * The client must show it and require an acknowledgement before dropping it, which
   * is the difference between a recovery key and a recovery key nobody wrote down.
   */
  async createRecoveryKey(
    ctx: AuthContext,
    currentPasswordRaw: unknown,
  ): Promise<Result<{ recoveryKey: string }>> {
    const user = await loadUser({ id: ctx.userId });
    if (!user) return { ok: false, error: 'account not found' };
    if (!(await verifyPassword(String(currentPasswordRaw), user.password_hash))) {
      await this.noteFailedUnlock(user.id);
      return { ok: false, error: 'current password is incorrect' };
    }

    const recoveryKey = generateRecoveryKey();
    const metadata = await addRecoveryWrapper(metadataFor(user), ctx.dek, recoveryKey, user.id);
    await saveMetadata(user.id, metadata);
    await this.recordAuthEvent(user.id, 'recovery_key_created');
    return { ok: true, value: { recoveryKey } };
  },

  /**
   * Resolve a bearer token to an auth context, honouring the privacy mode.
   *
   * This is the single place both the HTTP layer and the MCP layer ask "what can
   * this credential reach", so the mode rule cannot be enforced in one path and
   * forgotten in the other:
   *
   *   - a `ks_` unlock token carries its own key;
   *   - a `hrt_` API token proves identity only. In standard mode the server key
   *     then opens the data (the spec's "a live key is enough" for the ordinary
   *     case); in advanced mode it still requires a live unlock, because no server
   *     key exists to supply one.
   */
  async resolveApiContext(token: string): Promise<AuthContext | null> {
    if (token.startsWith('ks_')) {
      const session = lookupSession(token);
      return session ? { userId: session.userId, dek: session.dek } : null;
    }
    const userId = await this.resolveApiToken(token);
    if (!userId) return null;

    const user = await loadUser({ id: userId });
    if (!user) return null;
    const serverDek = await serverDekFor(user);
    if (serverDek) return { userId, dek: serverDek };

    const dek = findUserSessionFor(userId);
    return dek ? { userId, dek } : null;
  },

  async lock(token: string): Promise<void> {
    closeSession(token);
  },

  // --- Password -----------------------------------------------------------

  async changePassword(
    ctx: AuthContext,
    currentPassword: unknown,
    newPasswordRaw: unknown,
  ): Promise<Result<{ recoveryCodes: string[] | null }>> {
    const newPassword = validatePassword(newPasswordRaw);
    if (!newPassword.ok) return newPassword;

    const user = await loadUser({ id: ctx.userId });
    if (!user) return { ok: false, error: 'account not found' };
    if (!(await verifyPassword(String(currentPassword), user.password_hash))) {
      return { ok: false, error: 'current password is incorrect' };
    }

    // Re-wrap the DEK rather than re-encrypting records: one wrapper changes, and
    // the operation cannot half-fail and leave a corrupted history behind. The
    // recovery and server wrappers, if any, are left untouched — they protect the
    // same DEK and the new password is just another way to reach it.
    const metadata = await setPasswordWrapper(metadataFor(user), ctx.dek, newPassword.value, ctx.userId);
    const passwordHash = await hashPassword(newPassword.value);
    await getPool().query(
      `UPDATE users SET password_hash = $1, password_set_at = COALESCE(password_set_at, now()),
                        updated_at = now()
        WHERE id = $2`,
      [passwordHash, ctx.userId],
    );
    await saveMetadata(ctx.userId, metadata);

    // A password change is a security event: every other session and every API
    // token minted under the old credentials should stop working.
    //
    // Deleted rather than expired-in-place. Both reject the token, but a row left
    // behind would sit in the user's token list looking live — and since tokens are
    // permanent by default, an entry that had quietly stopped working is exactly the
    // confusion the management screen exists to remove. The security event is still
    // recorded below.
    closeUserSessions(ctx.userId);
    await getPool().query(`DELETE FROM api_tokens WHERE user_id = $1`, [ctx.userId]);
    await this.recordAuthEvent(ctx.userId, 'password_change');

    // Rotate recovery codes only when the account could not have seen the old ones
    // — an X-created account setting its first password. Otherwise keep them; a
    // silent rotation would invalidate the paper copy in the user's drawer.
    const hadPassword = user.password_set_at !== null;
    if (hadPassword) return { ok: true, value: { recoveryCodes: null } };

    const codes = await generateBackupCodes();
    await replaceRecoveryCodes(ctx.userId, codes.hashes);
    return { ok: true, value: { recoveryCodes: codes.plaintext } };
  },

  /** Regenerate recovery codes, invalidating the old set. Requires a TOTP code. */
  async regenerateRecoveryCodes(ctx: AuthContext, code: unknown): Promise<Result<string[]>> {
    const user = await loadUser({ id: ctx.userId });
    if (!user?.totp_secret_sealed) return { ok: false, error: 'account not found' };
    if (typeof code !== 'string' || !(await consumeTotpStep(user.id, user.totp_secret_sealed, code))) {
      return { ok: false, error: 'that code is not valid' };
    }

    // Rotation revokes the whole set, including already-used ones, so the account's
    // recovery state is unambiguous after a suspected compromise.
    const codes = await generateBackupCodes();
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM totp_backup_codes WHERE user_id = $1`, [ctx.userId]);
      for (const hash of codes.hashes) {
        await client.query(`INSERT INTO totp_backup_codes (user_id, code_hash) VALUES ($1, $2)`, [ctx.userId, hash]);
      }
    });
    await this.recordAuthEvent(ctx.userId, 'recovery_codes_rotated');
    return { ok: true, value: codes.plaintext };
  },

  // --- Agent tokens -------------------------------------------------------

  /**
   * Mint a new agent token. **Permanent by default.**
   *
   * These are long-lived credentials a user pastes into an agent's config and then
   * forgets about, so an expiry is the wrong default: it buys little (the token is
   * revocable, and the records it can read are still gated on an unlock) while
   * costing a silent breakage at an arbitrary date, months after the config was
   * written. The user manages the set explicitly instead — see
   * `listApiTokens` / `revokeApiToken`.
   *
   * `ttlDays` is still accepted so a caller may mint a short-lived token on purpose.
   * Note that `expires_at` is what makes a token permanent, and that a password
   * change still ends every token (see `changePassword`) — that is deliberate and is
   * not undermined by the default here.
   */
  async mintApiToken(userId: string, name: string, ttlDays: number | null = null): Promise<string> {
    const token = `hrt_${randomBytes(32).toString('base64url')}`;
    const expiresAt = ttlDays === null ? null : new Date(Date.now() + ttlDays * 86_400_000).toISOString();
    await getPool().query(
      `INSERT INTO api_tokens (user_id, name, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [userId, name, hashToken(token), expiresAt],
    );
    return token;
  },

  /**
   * The caller's tokens, newest first — metadata only.
   *
   * Never returns `token_hash`: the value was shown once at mint time and is not
   * recoverable, so there is nothing here to return but the name and the dates.
   * `expiresAt === null` is a permanent token, which is the normal case.
   */
  async listApiTokens(userId: string): Promise<{
    id: string; name: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null;
  }[]> {
    const { rows } = await getPool().query(
      `SELECT id, name, created_at, last_used_at, expires_at
         FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    }));
  },

  /**
   * Revoke one of the caller's tokens.
   *
   * Always scoped by `user_id` in the same statement as the id: the id arrives from
   * the client, and a lookup that took it on its own would let anyone revoke anyone
   * else's token by guessing a uuid. Returns whether a row was actually removed, so
   * the caller can 404 rather than reporting a revoke that did not happen.
   */
  async revokeApiToken(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `DELETE FROM api_tokens WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  },

  /**
   * Resolve an agent token to a user.
   *
   * Returns the *user*, never a key: a token proves identity, and the key still has
   * to come from an unlock the user opened with their password. A leaked token
   * therefore reads nothing on its own.
   */
  async resolveApiToken(token: string): Promise<string | null> {
    if (typeof token !== 'string' || !token.startsWith('hrt_')) return null;
    const { rows } = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM api_tokens
        WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [hashToken(token)],
    );
    if (rows.length === 0) return null;
    await getPool().query(`UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1`, [hashToken(token)]);
    return rows[0].user_id;
  },

  // --- X OAuth ------------------------------------------------------------

  xLoginAvailable(): boolean {
    return isXConfigured(getConfig().x);
  },

  /**
   * Begin an X authorization.
   *
   * `purpose: 'link'` requires an authenticated caller and records the account the
   * authorization will be attached to, so the callback cannot be pointed at a
   * different one by editing the state parameter.
   */
  async startXAuthorization(opts: {
    purpose: 'login' | 'link';
    userId?: string;
  }): Promise<Result<{ authorizeUrl: string; state: string }>> {
    const config = getConfig().x;
    if (!isXConfigured(config)) {
      return { ok: false, error: 'X login is not configured on this instance' };
    }
    if (opts.purpose === 'link' && !opts.userId) {
      return { ok: false, error: 'linking requires a signed-in account' };
    }

    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    await getPool().query(
      `INSERT INTO oauth_states (state, code_verifier, purpose, user_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
      [state, codeVerifier, opts.purpose, opts.userId ?? null, String(OAUTH_STATE_TTL_MS)],
    );

    return {
      ok: true,
      value: {
        authorizeUrl: buildAuthorizeUrl(config, { state, codeChallenge: codeChallengeS256(codeVerifier) }),
        state,
      },
    };
  },

  /**
   * Handle the OAuth callback.
   *
   * Returns one of two outcomes, and never a token directly: the caller redirects
   * the browser back to the web app with a single-use code, which the app exchanges
   * over a same-origin request. Putting the session token in the redirect URL would
   * leak it into browser history, the `Referer` header and any intermediary log.
   */
  async completeXCallback(query: {
    code?: unknown;
    state?: unknown;
    error?: unknown;
    errorDescription?: unknown;
  }): Promise<Result<{ outcome: 'login'; oneTimeCode: string } | { outcome: 'link'; handle: string | null } | { outcome: 'setup'; setupToken: string; username: string; totp: EnrollmentMaterial }>> {
    const config = getConfig().x;
    if (!isXConfigured(config)) return { ok: false, error: 'X login is not configured on this instance' };

    // The user declining consent comes back as an error with no code.
    if (typeof query.error === 'string' && query.error.length > 0) {
      return { ok: false, error: `X authorization was declined (${query.error})` };
    }
    if (typeof query.code !== 'string' || typeof query.state !== 'string') {
      return { ok: false, error: 'callback is missing code or state' };
    }

    // Consume the state: single use, so a replayed callback cannot be redeemed,
    // and it carries the verifier that only the initiating server knows.
    const { rows } = await getPool().query<{
      code_verifier: string;
      purpose: 'login' | 'link';
      user_id: string | null;
    }>(
      `UPDATE oauth_states SET consumed_at = now()
        WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING code_verifier, purpose, user_id`,
      [query.state],
    );
    if (rows.length === 0) {
      return { ok: false, error: 'this authorization has expired or was already used; start again' };
    }
    const pending = rows[0];

    let profile;
    try {
      const tokens = await exchangeCode(config, { code: query.code, codeVerifier: pending.code_verifier });
      profile = await fetchProfile(tokens.accessToken);
    } catch (error) {
      const detail = error instanceof XOAuthError ? error.detail : undefined;
      void detail;
      return { ok: false, error: error instanceof Error ? error.message : 'X authorization failed' };
    }

    // --- Linking to an existing account ---
    if (pending.purpose === 'link') {
      if (!pending.user_id) return { ok: false, error: 'link authorization had no account' };
      const existing = await getPool().query(
        `SELECT id, user_id FROM oauth_links WHERE provider = 'x' AND provider_user_id = $1`,
        [profile.id],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0].user_id === pending.user_id) {
          return { ok: true, value: { outcome: 'link', handle: profile.handle } };
        }
        return { ok: false, error: 'that X account is already linked to a different account' };
      }
      await getPool().query(
        `INSERT INTO oauth_links (user_id, provider, provider_user_id, handle, avatar_url)
         VALUES ($1, 'x', $2, $3, $4)`,
        [pending.user_id, profile.id, profile.handle, profile.avatarUrl],
      );
      await this.recordAuthEvent(pending.user_id, 'x_linked');
      return { ok: true, value: { outcome: 'link', handle: profile.handle } };
    }

    // --- Logging in ---
    const link = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM oauth_links WHERE provider = 'x' AND provider_user_id = $1`,
      [profile.id],
    );

    if (link.rows.length > 0) {
      const userId = link.rows[0].user_id;
      // The avatar is refreshed on every sign-in, not only at link time: people
      // change their picture, and X is the only source for it. `COALESCE` keeps the
      // stored one when X sends nothing this time, so a transient omission cannot
      // erase a picture that was working.
      await getPool().query(
        `UPDATE oauth_links
            SET handle = $1, avatar_url = COALESCE($2, avatar_url), last_login_at = now()
          WHERE provider = 'x' AND provider_user_id = $3`,
        [profile.handle, profile.avatarUrl, profile.id],
      );

      const user = await loadUser({ id: userId });
      if (!user) return { ok: false, error: 'linked account no longer exists' };

      // An account created through X that never finished setup cannot log in: there
      // is no data key, so there is nothing it could legitimately reach. Send it
      // back through setup rather than issuing a useless session.
      if (!isComplete(user)) {
        return { ok: true, value: await this.beginXSetup(user, profile) };
      }

      return { ok: true, value: { outcome: 'login', oneTimeCode: issueOneTimeCode(userId) } };
    }

    // --- First time seeing this X account: create the account ---
    const created = await this.createAccountFromX(profile);
    if (!created.ok) return created;
    return { ok: true, value: await this.beginXSetup(created.value, profile) };
  },

  /** Issue setup material for an account that has not finished enrolling. */
  async beginXSetup(
    user: AccountRow,
    profile: XProfile,
  ): Promise<{ outcome: 'setup'; setupToken: string; username: string; totp: EnrollmentMaterial }> {
    const { material, sealed, codeHashes } = await buildEnrollment(user.id);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE users SET totp_secret_sealed = $1, display_name = COALESCE(display_name, $2), updated_at = now()
          WHERE id = $3`,
        [sealed, profile.handle, user.id],
      );
      await replaceRecoveryCodes(user.id, codeHashes, client);
    });
    return {
      outcome: 'setup',
      setupToken: openPendingSetup(user.id),
      username: user.username,
      totp: material,
    };
  },

  /** Create an account owned by an X identity, with no password yet. */
  async createAccountFromX(profile: XProfile): Promise<Result<AccountRow>> {
    const base = usernameFromHandle(profile.handle);
    // Usernames are unique; X handles are unique too but a local account may
    // already hold the name. Try the plain name, then suffixed variants.
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = attempt === 0 ? base : `${base.slice(0, 26)}_${randomBytes(2).toString('hex')}`;
      try {
        const { rows } = await getPool().query<AccountRow>(
          `INSERT INTO users (id, username, display_name, totp_secret_sealed, failed_unlocks)
           VALUES ($1, $2, $3, NULL, 0)
           RETURNING id, username, display_name, password_hash, password_set_at, wrapped_dek,
                     totp_secret_sealed, totp_enabled_at, totp_last_step, failed_unlocks, locked_until`,
          [randomUUID(), candidate, profile.displayName ?? profile.handle],
        );
        const user = rows[0];
        await getPool().query(
          `INSERT INTO oauth_links (user_id, provider, provider_user_id, handle, avatar_url)
           VALUES ($1, 'x', $2, $3, $4)`,
          [user.id, profile.id, profile.handle, profile.avatarUrl],
        );
        await settings.upsert(user.id, { hrtMode: 'transfem' }).catch(() => undefined);
        await this.recordAuthEvent(user.id, 'x_account_created');
        return { ok: true, value: user };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') continue; // username raced
        throw error;
      }
    }
    return { ok: false, error: 'could not allocate a username; try signing in with a password instead' };
  },

  /**
   * Complete setup for an X-created account: set a password and confirm TOTP.
   *
   * This is the step that makes the account real. Until it runs the account has no
   * data key, so there is nothing to lose if X is lost — and nothing to read either.
   */
  async completeSetup(
    setupToken: string,
    passwordRaw: unknown,
    code: unknown,
    opts: { privacyMode?: unknown } = {},
  ): Promise<Result<UnlockedAccount & { recoveryCodes: string[] | null }>> {
    const userId = takePendingSetup(setupToken);
    if (!userId) return { ok: false, error: 'setup session expired; sign in with X again to restart' };

    const password = validatePassword(passwordRaw);
    if (!password.ok) return password;
    if (typeof code !== 'string') return { ok: false, error: 'code: required' };
    const privacyMode = validatePrivacyMode(opts.privacyMode);
    if (!privacyMode.ok) return privacyMode;

    const user = await loadUser({ id: userId });
    if (!user) return { ok: false, error: 'account not found' };

    const firstPassword = user.password_set_at === null;
    const { metadata, dek } = await buildKeyMaterial(password.value, userId, privacyMode.value);

    if (!user.totp_secret_sealed) {
      return { ok: false, error: 'no enrolment in progress; restart the X sign-in' };
    }
    const secret = await openTotpSecret(user.totp_secret_sealed, getConfig().totpEncKey);
    if (secret === null) return { ok: false, error: 'could not read the enrolment secret' };
    const step = verifyTotpCodeWithStep(secret, code);
    if (step === null) return { ok: false, error: 'that code is not valid — check the device clock' };
    void step; // not recorded — see the note in `confirmEnrollment`

    const passwordHash = await hashPassword(password.value);
    await getPool().query(
      `UPDATE users
          SET password_hash = $1, password_set_at = now(), wrapped_dek = $2,
              privacy_mode = $3, encryption_metadata = $4,
              totp_enabled_at = now(), failed_unlocks = 0, locked_until = NULL,
              updated_at = now()
        WHERE id = $5`,
      [
        passwordHash,
        JSON.stringify(passwordEnvelopeOf(metadata)),
        privacyMode.value,
        JSON.stringify(metadata),
        userId,
      ],
    );
    await this.recordAuthEvent(userId, 'setup_completed');

    const token = openSession(userId, requireKey(dek, 'completeSetup'), getConfig().sessionTtlMinutes);
    return {
      ok: true,
      value: {
        userId,
        username: user.username,
        token,
        // Recovery codes were minted with the enrolment material; null means the
        // caller already displayed them, so they are not re-shown.
        recoveryCodes: firstPassword ? null : null,
      },
    };
  },

  /**
   * Finish an X sign-in.
   *
   * This is the honest shape of the design, and it is worth being explicit about
   * because it is a real limitation rather than an oversight:
   *
   * X proves *identity*. It does not and cannot supply the **password**, and the
   * password is what unwraps the data key. So an X sign-in verifies the person and
   * then still needs the password before any record can be read. It is a faster
   * path to "which account is this", not a way to skip the credential.
   *
   * The alternative — wrapping the DEK under something X *can* supply — would mean
   * the DEK is recoverable from the X account, which is exactly the dependency the
   * user asked to avoid (an X ban must not cost the data) and would also hand X a
   * path to the encryption key.
   *
   * Callers therefore use the returned `username` to pre-fill the sign-in form, and
   * the normal password + TOTP unlock runs from there. When the account already has
   * an active unlock on this server, that existing session is reused instead, which
   * is what makes X login feel like a single click in the common case.
   */
  /**
   * Delete an account and everything belonging to it.
   *
   * Requires the password AND a second factor, because this is the most destructive
   * action the service offers and the one an attacker holding a stolen session would
   * most want. A session alone is not enough.
   *
   * A recovery code is accepted in place of a TOTP code, for the same reason it is
   * accepted at sign-in: someone whose authenticator is gone must still be able to
   * exercise their own right to erasure. Refusing that would leave the account
   * undeletable precisely when the user most wants it gone.
   *
   * This is a real delete, not a flag. Every table referencing `users` declares
   * `ON DELETE CASCADE`, so records, settings, recovery codes, API tokens and OAuth
   * links all go with the row — the only way the Privacy Policy's deletion promise
   * can be honest. `auth_events` is removed explicitly because its foreign key is
   * `ON DELETE SET NULL`, so a cascade would leave rows behind still holding IP
   * addresses, which is exactly what deletion is supposed to remove.
   *
   * What survives is one `deletion_log` row with no identifier: a reason, the
   * account's creation time, and when it was deleted.
   */
  async deleteAccount(
    ctx: AuthContext,
    passwordRaw: unknown,
    opts: { code?: unknown; backupCode?: unknown; reason?: unknown } = {},
  ): Promise<Result<{ deleted: true }>> {
    const user = await loadUser({ id: ctx.userId });
    if (!user) return { ok: false, error: 'account not found' };

    // The lockout applies here too. Without it, this endpoint would be a way around
    // the sign-in lockout: an attacker locked out of `/auth/login` could keep guessing
    // the password here instead. Same budget, same window.
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return { ok: false, error: 'too many failed attempts; try again later' };
    }

    // Every failure below returns the same message. A wrong password and a wrong code
    // must not be distinguishable, or this endpoint becomes an oracle for the
    // credentials it protects.
    const generic = { ok: false as const, error: 'invalid credentials' };

    if (!(await verifyPassword(String(passwordRaw ?? ''), user.password_hash))) {
      await this.noteFailedUnlock(user.id);
      return generic;
    }

    const usingBackup = typeof opts.backupCode === 'string' && opts.backupCode.length > 0;
    if (usingBackup) {
      if (!(await consumeBackupCode(user.id, opts.backupCode as string))) {
        await this.noteFailedUnlock(user.id);
        return generic;
      }
    } else if (typeof opts.code !== 'string' || opts.code.length === 0) {
      // Deliberately NOT counted as a failed attempt. The password has already been
      // proven correct at this point, so this is a client mid-flow — a UI that asks
      // for the password and the code on separate screens — not a guess. Counting it
      // would let an honest user lock themselves out of deleting their own account.
      return { ok: false, error: 'two_factor_required' };
    } else if (!user.totp_secret_sealed || !(await consumeTotpStep(user.id, user.totp_secret_sealed, opts.code))) {
      await this.noteFailedUnlock(user.id);
      return generic;
    }

    const reason =
      typeof opts.reason === 'string' && opts.reason.length > 0 && opts.reason.length <= 120
        ? opts.reason
        : 'user_requested';

    // One transaction, so the tombstone and the removal cannot disagree: a tombstone
    // without a deletion corrupts the count, and a deletion without a tombstone loses
    // the only evidence it happened.
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM auth_events WHERE user_id = $1`, [user.id]);
      await client.query(`INSERT INTO deletion_log (reason, user_created_at) VALUES ($1, $2)`, [
        reason,
        user.created_at,
      ]);
      // Cascades to api_tokens, totp_backup_codes, oauth_links, oauth_states,
      // medication_events, lab_results and user_settings.
      await client.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    });

    // Unlocked sessions live in process memory, so the cascade cannot reach them.
    // Without this the deleted account's key would sit in memory for up to its idle
    // timeout, and a token minted before the delete would keep working.
    closeUserSessions(ctx.userId);

    return { ok: true, value: { deleted: true } };
  },

  /** Redeem the single-use code from an X callback for a session, or a locked token. */
  async completeXSignIn(oneTimeCode: unknown): Promise<
    Result<{ userId: string; username: string; token: string | null; lockedToken?: string }>
  > {
    if (typeof oneTimeCode !== 'string' || oneTimeCode.length === 0) {
      return { ok: false, error: 'code: required' };
    }
    const userId = redeemOneTimeCode(oneTimeCode);
    if (!userId) return { ok: false, error: 'this sign-in link expired or was already used' };

    const user = await loadUser({ id: userId });
    if (!user) return { ok: false, error: 'linked account no longer exists' };
    if (!isComplete(user)) return { ok: false, error: 'account setup is incomplete' };

    // A live unlock on this server (e.g. another tab, or a recent sign-in) already
    // holds the key, so no password is needed from this caller.
    const existing = findUserSessionFor(userId);
    if (existing) {
      const token = openSession(userId, existing, getConfig().sessionTtlMinutes);
      await this.recordAuthEvent(userId, 'x_login_session_reused');
      return { ok: true, value: { userId, username: user.username, token } };
    }

    // Standard mode is the difference: the server can open the account's key with
    // its own wrapper, so X alone is enough to reach the records — which is exactly
    // what "simple, easy to recover" is supposed to mean.
    const serverDek = await serverDekFor(user);
    if (serverDek) {
      const token = openSession(userId, serverDek, getConfig().sessionTtlMinutes);
      await this.recordAuthEvent(userId, 'x_login_server_unlock');
      return { ok: true, value: { userId, username: user.username, token } };
    }

    // Advanced mode: no server key exists, so X yields identity and nothing more.
    // A locked token carries the identity forward to the unlock step without ever
    // carrying a key — the honest state the spec asks to be shown as "verified, but
    // this device has not unlocked your records" rather than "sign-in failed".
    await this.recordAuthEvent(userId, 'x_login_password_required');
    return {
      ok: true,
      value: {
        userId,
        username: user.username,
        token: null,
        lockedToken: openLockedSession(userId, getConfig().sessionTtlMinutes),
      },
    };
  },

  /** Unlink X. Requires a TOTP code, since it changes how the account is reached. */
  async unlinkX(ctx: AuthContext, code: unknown): Promise<Result<void>> {
    const user = await loadUser({ id: ctx.userId });
    if (!user?.totp_secret_sealed) return { ok: false, error: 'account not found' };
    if (typeof code !== 'string' || !(await consumeTotpStep(user.id, user.totp_secret_sealed, code))) {
      // A recovery code is accepted here too: someone who lost their authenticator
      // must still be able to detach a compromised X account.
      if (typeof code === 'string' && (await consumeBackupCode(user.id, code))) {
        // fall through — the code was valid
      } else {
        return { ok: false, error: 'that code is not valid' };
      }
    }

    const { rowCount } = await getPool().query(`DELETE FROM oauth_links WHERE user_id = $1 AND provider = 'x'`, [
      ctx.userId,
    ]);
    await this.recordAuthEvent(ctx.userId, rowCount ? 'x_unlinked' : 'x_unlink_noop');
    // Unlinking never locks the user out: a usable account always has a password,
    // which is the whole reason X is an assist rather than a login method.
    return { ok: true, value: undefined };
  },

  async listXLinks(userId: string): Promise<{
    handle: string | null; avatarUrl: string | null; linkedAt: string; lastLoginAt: string | null;
  }[]> {
    const { rows } = await getPool().query<{
      handle: string | null; avatar_url: string | null; linked_at: Date; last_login_at: Date | null;
    }>(
      `SELECT handle, avatar_url, linked_at, last_login_at FROM oauth_links WHERE user_id = $1 AND provider = 'x'`,
      [userId],
    );
    return rows.map((r) => ({
      handle: r.handle,
      avatarUrl: r.avatar_url,
      linkedAt: r.linked_at.toISOString(),
      lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
    }));
  },

  // --- Shared -------------------------------------------------------------

  async recordAuthEvent(userId: string, kind: string, ip?: string): Promise<void> {
    await getPool()
      .query(`INSERT INTO auth_events (user_id, kind, ip) VALUES ($1, $2, $3)`, [userId, kind, ip ?? null])
      .catch(() => undefined); // never fail a login because audit logging hiccuped
  },

  async getSettings(ctx: AuthContext) {
    const found = await settings.get(ctx.userId);
    if (found) return found;
    return {
      bodyWeightKg: null,
      hrtMode: 'transfem' as const,
      calibrationMethod: 'mipd',
      calibrationHistory: 'retrospective',
      pkParams: null,
      timezone: null,
      appState: null,
    };
  },

  /**
   * Update the settings a simulation depends on.
   *
   * Validation is by rejection, matching the rest of the API: `parseBodyWeight` and
   * `parsePKParams` refuse an out-of-range value rather than clamping it. Clamping
   * is right for a settings screen someone is typing into and wrong here, where a
   * caller that mixed up its units would otherwise get a plausible-looking curve
   * built from a number it never chose.
   */
  async updateSettings(
    ctx: AuthContext,
    patch: {
      body_weight_kg?: unknown;
      hrt_mode?: unknown;
      calibration_method?: unknown;
      calibration_history?: unknown;
      pk_params?: unknown;
      timezone?: unknown;
    },
  ): Promise<Result<unknown>> {
    const update: Partial<import('./store.ts').UserSettings> = {};

    if (patch.body_weight_kg !== undefined) {
      const weight: Result<number> = parseBodyWeight(patch.body_weight_kg);
      if (!weight.ok) return weight;
      update.bodyWeightKg = weight.value;
    }
    if (patch.hrt_mode !== undefined) {
      if (patch.hrt_mode !== 'transfem' && patch.hrt_mode !== 'transmasc') {
        return { ok: false, error: 'hrt_mode: must be transfem or transmasc' };
      }
      update.hrtMode = patch.hrt_mode;
    }
    if (patch.calibration_method !== undefined) {
      if (!(CALIBRATION_METHODS as readonly string[]).includes(patch.calibration_method as string)) {
        return { ok: false, error: `calibration_method: must be one of ${CALIBRATION_METHODS.join(', ')}` };
      }
      update.calibrationMethod = patch.calibration_method as string;
    }
    if (patch.calibration_history !== undefined) {
      if (patch.calibration_history !== 'forward' && patch.calibration_history !== 'retrospective') {
        return { ok: false, error: 'calibration_history: must be forward or retrospective' };
      }
      update.calibrationHistory = patch.calibration_history;
    }
    if (patch.timezone !== undefined) {
      if (typeof patch.timezone !== 'string' || patch.timezone.length > 64) {
        return { ok: false, error: 'timezone: must be a string of at most 64 characters' };
      }
      update.timezone = patch.timezone;
    }
    if (patch.pk_params !== undefined) {
      const params: Result<PKCustomParams | null> = parsePKParams(patch.pk_params);
      if (!params.ok) return params;
      update.pkParams = params.value as unknown as Record<string, number> | null;
    }

    if (Object.keys(update).length === 0) {
      return { ok: false, error: 'nothing to update' };
    }
    return { ok: true, value: await settings.upsert(ctx.userId, update) };
  },
};

/** Recover the DEK once, right after registration, so enrolment can open a session. */
async function currentDekForEnrollment(password: string, userId: string): Promise<string> {
  const user = await loadUser({ id: userId });
  if (!user) throw new Error('registration lost its own row');
  const dek = await unwrapDek(user.wrapped_dek, password, userId);
  if (dek === null) throw new Error('registration could not recover the new key');
  return dek;
}

/**
 * Assert a value that must be a non-empty string.
 *
 * Guards the class of mistake above: a key that arrives as `undefined` is caught
 * where it is produced rather than surfacing later as a decode error three layers
 * away, where the real cause is invisible.
 */
function requireKey(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context}: expected a key string, got ${typeof value}`);
  }
  return value;
}

// `hashPassword` is here for the share passwords too: a share guards the same kind of
// data as a login, so it gets the same treatment rather than a second, weaker scheme.
export { hashPassword, hashToken, isComplete, loadUser, validatePassword, validateUsername };
