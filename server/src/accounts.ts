/**
 * Accounts: identity, credentials, and the key material behind them.
 *
 * The product rule this file enforces, stated once so the rest reads clearly:
 *
 *   **Identity is proven by an account name and password, by X, or by Google.**
 *   Any of the three may create an account; a social signup starts with no
 *   password at all.
 *
 *   **Records are a separate gate.** Reading or writing one requires a *bound
 *   fallback credential* — an account name plus a password — which is what
 *   `requireBoundCtx` enforces. A social signup therefore reaches its own account
 *   page and is asked once, while the provider still works, to bind one. Losing
 *   the provider then costs a login button, not the history.
 *
 * That rule is not a policy bolted on top — it falls out of the key design. The
 * account key (DEK) is wrapped once per credential that can open it: under a
 * password-derived key and under the deployment's server key. An account with no
 * password has no password wrapper, which is exactly why binding one has to rewrap
 * the key rather than only storing a hash.
 *
 * Rules that are easy to get wrong, and why each is where it is:
 *
 *   - Failed unlocks are counted per account with a lockout, on top of the
 *     per-IP limiter in the HTTP layer. Per-IP alone is defeated by a botnet;
 *     per-account alone lets an attacker spray many accounts.
 *   - A password change rewraps the DEK and never re-encrypts a record, so it
 *     cannot half-fail and leave a corrupted history behind.
 */
import { randomUUID, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { getPool, withTransaction } from './db.ts';
import { getConfig } from './config.ts';
import { settings } from './settings.ts';
import {
  createUserKeyMaterial,
  rewrapForNewPassword,
  openSession,
  closeSession,
  closeUserSessions,
  findUserSession as findUserSessionFor,
  lookupSession,
  issueOneTimeCode,
  redeemOneTimeCode,
  readMetadata,
  createKeyMaterial,
  createPasswordlessKeyMaterial,
  unwrapWithPassword,
  unwrapWithServer,
  addServerWrapper,
  setPasswordWrapper,
  passwordEnvelopeOf,
  type EncryptionMetadata,
} from './session.ts';
import {
  buildAuthorizeUrl,
  buildGoogleAuthorizeUrl,
  codeChallengeS256,
  exchangeCode,
  exchangeGoogleCode,
  fetchProfile,
  generateCodeVerifier,
  generateState,
  isGoogleConfigured,
  isXConfigured,
  XOAuthError,
  type XProfile,
} from './oauth.ts';
import { parseBodyWeight, parsePKParams } from './domain.ts';
import type { Result } from './domain.ts';
import type { AuthContext, ContextDenial } from './types.ts';
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

export interface AccountRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string | null;
  password_set_at: Date | null;
  wrapped_dek: unknown;
  encryption_metadata: unknown;
  failed_unlocks: number;
  locked_until: Date | null;
  /** Needed for the deletion tombstone: "how long after signing up do people leave". */
  created_at: Date;
}

export interface RegistrationResult {
  userId: string;
  username: string;
  /** Issued by registration itself: there is nothing left to confirm. */
  token: string;
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
            encryption_metadata,
            failed_unlocks, locked_until,
            created_at
       FROM users WHERE ${column} = $1`,
    [value],
  );
  return rows[0] ?? null;
}

/**
 * Whether an account has finished becoming usable.
 *
 * Only a password is needed. A social signup has none, so it signs in through its
 * provider instead and is asked to bind a fallback before it can reach records.
 */
function isComplete(user: AccountRow): boolean {
  return user.password_set_at !== null;
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

/**
 * The live DEK for an account, from the deployment's own copy of it.
 *
 * Null only when the deployment has no `SERVER_DEK_KEY`, which is a misconfiguration
 * rather than a privacy setting: every account's key material carries the server
 * wrapper. Server-side only.
 */
async function serverDekFor(user: AccountRow): Promise<string | null> {
  return await unwrapWithServer(metadataFor(user), user.id, getConfig().serverDekKey);
}

// ---------------------------------------------------------------------------
// AccountService
// ---------------------------------------------------------------------------

export interface UnlockedAccount {
  userId: string;
  username: string;
  token: string;
}

export const AccountService = {
  // --- Registration -------------------------------------------------------

  /**
   * Create an account.
   *
   * Returns a usable session directly: the caller has just chosen the password,
   * so there is nothing left to prove before opening one.
   */
  async register(
    usernameRaw: unknown,
    passwordRaw: unknown,
  ): Promise<Result<RegistrationResult>> {
    const username = validateUsername(usernameRaw);
    if (!username.ok) return username;
    const password = validatePassword(passwordRaw);
    if (!password.ok) return password;

    const userId = randomUUID();
    const { metadata, dek } = await createKeyMaterial(password.value, userId, {
      serverKey: getConfig().serverDekKey,
    });
    const passwordHash = await hashPassword(password.value);

    try {
      // One transaction, so the row and the username claim are committed together.
      await withTransaction(async (client) => {
        // A username is claimed on insert and never recycled: `users.username` is
        // unique, and there is no longer a notion of an "abandoned" row to replace,
        // because a registration now completes in one step.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE username = $1 FOR UPDATE`,
          [username.value],
        );
        if (existing.rows.length > 0) {
          throw Object.assign(new Error('username is already taken'), { taken: true });
        }

        await client.query(
          `INSERT INTO users (id, username, password_hash, password_set_at, wrapped_dek,
                              encryption_metadata, failed_unlocks)
           VALUES ($1, $2, $3, now(), $4, $5, 0)`,
          [
            userId,
            username.value,
            passwordHash,
            JSON.stringify(passwordEnvelopeOf(metadata)),
            JSON.stringify(metadata),
          ],
        );
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

    // The session is opened here, with the DEK minted a few lines above, so the key
    // never has to be unwrapped again and there is no second step to hand it through.
    const token = openSession(userId, requireKey(dek, 'registration'), getConfig().sessionTtlMinutes);

    return {
      ok: true,
      value: { userId, username: username.value, token },
    };
  },

  /**
   * Sign in with a password.
   *
   * Every failure path returns the same message, and the password is verified even
   * when the account does not exist, so the endpoint cannot be used to enumerate
   * usernames.
   */
  async unlock(
    usernameRaw: unknown,
    passwordRaw: unknown,
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

    // No second check follows. Identity here is the password alone — or X, or Google,
    // on their own paths — so there is nothing else to demand.
    const metadata = metadataFor(user);
    const dek = await unwrapWithPassword(metadata, password.value, user.id);
    if (dek === null) {
      return { ok: false, error: 'account key material is unreadable; set a new password to re-key it' };
    }

    await getPool().query(`UPDATE users SET failed_unlocks = 0, locked_until = NULL WHERE id = $1`, [user.id]);

    // Every account must carry the server wrapper, so the deployment can open it
    // again without the user. An account created before this release may not; a
    // password unlock is the one moment the key is in hand to add it without asking
    // the user for anything twice.
    const serverKey = getConfig().serverDekKey;
    if (!metadata.wrappers.server && serverKey) {
      await saveMetadata(user.id, await addServerWrapper(metadata, dek, user.id, serverKey));
    }

    const token = openSession(user.id, requireKey(dek, 'unlock'), getConfig().sessionTtlMinutes);
    await this.recordAuthEvent(user.id, 'unlock');

    return {
      ok: true,
      value: { userId: user.id, username: user.username, token },
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

  /**
   * Resolve a bearer token to an auth context.
   *
   * This is the single place both the HTTP layer and the MCP layer ask "what can
   * this credential reach", so the rule cannot be enforced in one path and forgotten
   * in the other:
   *
   *   - a `ks_` unlock token carries its own key;
   *   - a `hrt_` API token proves identity, and then needs a live unlock before the
   *     server's copy of the key opens anything.
   *
   * Both halves of that second rule are worth stating, because they pull in opposite
   * directions: the token cannot create access — with no session the answer is
   * `locked`, not a key — but a live session renews on every read and the default
   * token never expires, so while the user *is* signed in, holding the token is enough
   * to keep reading for as long as they stay that way. "Reads nothing on its own" is
   * not the same claim as "harmless if leaked", and the published policy must not
   * reduce to the first.
   *
   * The live-unlock requirement was the advanced-mode rule before the mode was
   * removed. Every account now carries a server wrapper, so without it a token alone
   * would open the records — the exact opposite of what the privacy policy tells the
   * user, and a promise about who can read your data is not one to drop quietly
   * because a mode went away.
   */
  async resolveApiContext(token: string): Promise<AuthContext | ContextDenial | null> {
    if (token.startsWith('ks_')) {
      const session = lookupSession(token);
      return session ? { userId: session.userId, dek: session.dek } : null;
    }
    const userId = await this.resolveApiToken(token);
    if (!userId) return null;

    const user = await loadUser({ id: userId });
    if (!user) return null;
    if (!findUserSessionFor(userId)) return { denied: 'locked' };

    const serverDek = await serverDekFor(user);
    // No deployment key, so there is no copy of this account's key to hand over.
    // A denial rather than a failure, so an adapter can say "locked" instead of
    // reporting an authentication error the credential does not have.
    if (!serverDek) return { denied: 'locked' };
    return { userId, dek: serverDek };
  },

  async lock(token: string): Promise<void> {
    closeSession(token);
  },

  // --- Password -----------------------------------------------------------

  async changePassword(
    ctx: AuthContext,
    currentPassword: unknown,
    newPasswordRaw: unknown,
  ): Promise<Result<void>> {
    const newPassword = validatePassword(newPasswordRaw);
    if (!newPassword.ok) return newPassword;

    const user = await loadUser({ id: ctx.userId });
    if (!user) return { ok: false, error: 'account not found' };
    if (!(await verifyPassword(String(currentPassword), user.password_hash))) {
      return { ok: false, error: 'current password is incorrect' };
    }

    // Re-wrap the DEK rather than re-encrypting records: one wrapper changes, and
    // the operation cannot half-fail and leave a corrupted history behind. The server
    // wrapper, if present, is left untouched — it protects the same DEK, and the new
    // password is just another way to reach it.
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
    return { ok: true, value: undefined };
  },

  /**
   * Whether this account has bound an account name and password.
   *
   * The gate on records, not on the account. A social signup produces an account with
   * no fallback credential, so losing that provider loses the history — which is the
   * whole reason binding exists. Making it required means a new OAuth user is asked once,
   * at the moment they are provably present, instead of being trusted to do it later and
   * never doing it.
   *
   * Kept separate from `isComplete`: that one decides whether a password-based sign-in
   * may proceed, this one decides whether records may be read. Conflating them would
   * make an unbound account unable to reach the very endpoint that binds it.
   */
  async hasBoundCredentials(userId: string): Promise<boolean> {
    const user = await loadUser({ id: userId });
    return user?.password_set_at !== null && user?.password_set_at !== undefined;
  },

  // --- Agent tokens -------------------------------------------------------

  /**
   * Mint a new agent token. **Permanent by default.**
   *
   * These are long-lived credentials a user pastes into an agent's config and then
   * forgets about, so an expiry is the wrong default: it buys little (the token is
   * revocable, and a password change ends every one of them) while costing a silent
   * breakage at an arbitrary date, months after the config was written. The user
   * manages the set explicitly instead — see `listApiTokens` / `revokeApiToken`.
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
   * Returns the *user*, never a key; the key is attached by `resolveApiContext`.
   * The token is therefore a full credential for the account's records — revocable,
   * and ended by a password change — but it does not need a live unlock.
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
  }): Promise<Result<
    | { outcome: 'login'; oneTimeCode: string }
    | { outcome: 'link'; handle: string | null }
  >> {
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
        `SELECT id, user_id FROM oauth_accounts WHERE provider = 'x' AND provider_user_id = $1`,
        [profile.id],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0].user_id === pending.user_id) {
          return { ok: true, value: { outcome: 'link', handle: profile.handle } };
        }
        return { ok: false, error: 'that X account is already linked to a different account' };
      }
      await getPool().query(
        `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, handle, avatar_url)
         VALUES ($1, 'x', $2, $3, $4)`,
        [pending.user_id, profile.id, profile.handle, profile.avatarUrl],
      );
      await this.recordAuthEvent(pending.user_id, 'x_linked');
      return { ok: true, value: { outcome: 'link', handle: profile.handle } };
    }

    // --- Logging in ---
    const link = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM oauth_accounts WHERE provider = 'x' AND provider_user_id = $1`,
      [profile.id],
    );

    if (link.rows.length > 0) {
      const userId = link.rows[0].user_id;
      // The avatar is refreshed on every sign-in, not only at link time: people
      // change their picture, and X is the only source for it. `COALESCE` keeps the
      // stored one when X sends nothing this time, so a transient omission cannot
      // erase a picture that was working.
      await getPool().query(
        `UPDATE oauth_accounts
            SET handle = $1, avatar_url = COALESCE($2, avatar_url), last_login_at = now()
          WHERE provider = 'x' AND provider_user_id = $3`,
        [profile.handle, profile.avatarUrl, profile.id],
      );

      const user = await loadUser({ id: userId });
      if (!user) return { ok: false, error: 'linked account no longer exists' };

      return { ok: true, value: { outcome: 'login', oneTimeCode: issueOneTimeCode(userId) } };
    }

    // --- First time seeing this X account: create the account ---
    //
    // Usable immediately. The prompt to bind a fallback comes from
    // `/auth/login-methods` reporting `recovery_risk`, and gates *records* rather than
    // the account — see `requireBoundCtx`.
    const created = await this.createAccountFromX(profile);
    if (!created.ok) return created;
    return { ok: true, value: { outcome: 'login', oneTimeCode: issueOneTimeCode(created.value.id) } };
  },

  // --- Google OAuth -------------------------------------------------------

  /**
   * Begin a Google authorization.
   *
   * No PKCE: Google's web client authenticates with the client secret, so there is no
   * verifier to store. The row still records `provider`, because the state is the only
   * thing Google echoes back and the callback has to know which token endpoint to use.
   */
  async startGoogleAuthorization(opts: {
    purpose: 'login' | 'link';
    userId?: string;
  }): Promise<Result<{ authorizeUrl: string; state: string }>> {
    const config = getConfig().google;
    if (!isGoogleConfigured(config)) {
      return { ok: false, error: 'Google login is not configured on this instance' };
    }
    if (opts.purpose === 'link' && !opts.userId) {
      return { ok: false, error: 'linking requires a signed-in account' };
    }

    const state = generateState();
    // Doubles as the ID-token replay guard; stored in the same row as the state so the
    // two cannot drift apart.
    const nonce = generateState();
    await getPool().query(
      `INSERT INTO oauth_states (state, code_verifier, purpose, provider, user_id, expires_at)
       VALUES ($1, $2, $3, 'google', $4, now() + ($5 || ' milliseconds')::interval)`,
      [state, nonce, opts.purpose, opts.userId ?? null, String(OAUTH_STATE_TTL_MS)],
    );

    return {
      ok: true,
      value: { authorizeUrl: buildGoogleAuthorizeUrl(config, { state, nonce }), state },
    };
  },

  /**
   * Handle the Google callback.
   *
   * Simpler than X's by construction: identity comes out of the ID token, so there is no
   * profile request, and the account is usable the moment it exists. What it does
   * need is the anti-ban prompt, which the app derives from `loginOverview`
   * (`recovery_risk: true` while no password is bound).
   */
  async completeGoogleCallback(query: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<Result<{ outcome: 'login' | 'link'; oneTimeCode?: string; handle?: string | null }>> {
    if (query.error) return { ok: false, error: `Google returned: ${query.error}` };
    if (!query.code) return { ok: false, error: 'Google callback had no code' };
    if (!query.state) return { ok: false, error: 'Google callback had no state' };

    const config = getConfig().google;
    if (!isGoogleConfigured(config)) {
      return { ok: false, error: 'Google login is not configured on this instance' };
    }

    // Spend the state first, so a replayed callback cannot be redeemed twice even if
    // the exchange below fails.
    const { rows } = await getPool().query<{
      purpose: 'login' | 'link'; user_id: string | null; code_verifier: string | null; provider: string;
    }>(
      `UPDATE oauth_states
          SET consumed_at = now()
        WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING purpose, user_id, code_verifier, provider`,
      [query.state],
    );
    const pending = rows[0];
    if (!pending) return { ok: false, error: 'that sign-in link expired; try again' };
    if (pending.provider !== 'google') {
      return { ok: false, error: 'that sign-in link was started for a different provider' };
    }
    // The nonce is what makes the ID token unusable outside this flow.
    const nonce = pending.code_verifier ?? '';

    let profile;
    try {
      profile = await exchangeGoogleCode(config, { code: query.code, nonce });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Google authorization failed' };
    }

    if (pending.purpose === 'link') {
      if (!pending.user_id) return { ok: false, error: 'link authorization had no account' };
      const existing = await getPool().query<{ user_id: string }>(
        `SELECT user_id FROM oauth_accounts WHERE provider = 'google' AND provider_user_id = $1`,
        [profile.id],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0].user_id === pending.user_id) {
          return { ok: true, value: { outcome: 'link', handle: profile.handle } };
        }
        return { ok: false, error: 'that Google account is already linked to a different account' };
      }
      await getPool().query(
        `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, handle, avatar_url)
         VALUES ($1, 'google', $2, $3, $4)`,
        [pending.user_id, profile.id, profile.handle, profile.avatarUrl],
      );
      await this.recordAuthEvent(pending.user_id, 'google_linked');
      return { ok: true, value: { outcome: 'link', handle: profile.handle } };
    }

    const link = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM oauth_accounts WHERE provider = 'google' AND provider_user_id = $1`,
      [profile.id],
    );

    if (link.rows.length > 0) {
      const userId = link.rows[0].user_id;
      await getPool().query(
        `UPDATE oauth_accounts SET last_login_at = now()
          WHERE provider = 'google' AND provider_user_id = $1`,
        [profile.id],
      );
      const user = await loadUser({ id: userId });
      if (!user) return { ok: false, error: 'linked account no longer exists' };
      return { ok: true, value: { outcome: 'login', oneTimeCode: issueOneTimeCode(userId) } };
    }

    const created = await this.createAccountFromOAuth('google', profile);
    if (!created.ok) return created;
    return { ok: true, value: { outcome: 'login', oneTimeCode: issueOneTimeCode(created.value.id) } };
  },

  /** Create an account owned by an X identity, with no password yet. */
  async createAccountFromX(profile: XProfile): Promise<Result<AccountRow>> {
    return await this.createAccountFromOAuth('x', profile);
  },

  /**
   * Create an account owned by a social identity, with no password yet.
   *
   * `provider` is a parameter rather than a constant because both providers need the
   * same four steps — allocate a username, insert the user, record the link, seed
   * settings — and a second copy of them would be a second place for the unique-name
   * retry to be got wrong.
   */
  async createAccountFromOAuth(
    provider: 'x' | 'google',
    profile: { id: string; handle: string | null; displayName: string | null; avatarUrl: string | null },
  ): Promise<Result<AccountRow>> {
    const base = usernameFromHandle(profile.handle);
    // Key material is created per attempt, with the server wrapper and no password
    // wrapper. Without it an OAuth account had no DEK at all, so `serverDekFor` had
    // nothing to unwrap and sign-in could only hand back identity — which made
    // binding a fallback credential impossible, because that endpoint needs a real
    // session. That deadlock is why this exists.
    const serverKey = getConfig().serverDekKey;

    // Usernames are unique; a provider handle or address may collide with a local
    // account that already holds the name. Try the plain name, then suffixed variants.
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = attempt === 0 ? base : `${base.slice(0, 26)}_${randomBytes(2).toString('hex')}`;
      const userId = randomUUID();
      // The metadata is bound to the id it was wrapped for, so it has to be built per
      // attempt rather than hoisted out of the loop.
      const { metadata } = await createPasswordlessKeyMaterial(userId, { serverKey });
      try {
        const { rows } = await getPool().query<AccountRow>(
          `INSERT INTO users (id, username, display_name, wrapped_dek, encryption_metadata,
                              failed_unlocks)
           VALUES ($1, $2, $3, NULL, $4, 0)
           RETURNING id, username, display_name, password_hash, password_set_at, wrapped_dek,
                     failed_unlocks, locked_until`,
          [userId, candidate, profile.displayName ?? profile.handle, JSON.stringify(metadata)],
        );
        const user = rows[0];
        await getPool().query(
          `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, handle, avatar_url)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.id, provider, profile.id, profile.handle, profile.avatarUrl],
        );
        await settings.upsert(user.id, { hrtMode: 'transfem' }).catch(() => undefined);
        await this.recordAuthEvent(user.id, `${provider}_account_created`);
        return { ok: true, value: user };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') continue; // username raced
        throw error;
      }
    }
    return { ok: false, error: 'could not allocate a username; try signing in with a password instead' };
  },

  /**
   * Delete an account and everything belonging to it.
   *
   * The password authorises it, on top of the lockout budget it shares with
   * sign-in: a session alone is not enough, because this is the most destructive
   * action the service offers and the one an attacker holding a stolen session
   * would most want.
   *
   * This is a real delete, not a flag. Every table referencing `users` declares
   * `ON DELETE CASCADE`, so records, settings, API tokens and OAuth links all go
   * with the row — the only way the Privacy Policy's deletion promise can be
   * honest. `auth_events` is removed explicitly because its foreign key is
   * `ON DELETE SET NULL`, so a cascade would leave rows behind still holding IP
   * addresses, which is exactly what deletion is supposed to remove.
   *
   * What survives is one `deletion_log` row with no identifier: a reason, the
   * account's creation time, and when it was deleted.
   */
  async deleteAccount(
    ctx: AuthContext,
    passwordRaw: unknown,
    opts: { reason?: unknown } = {},
  ): Promise<Result<{ deleted: true }>> {
    const user = await loadUser({ id: ctx.userId });
    if (!user) return { ok: false, error: 'account not found' };

    // The lockout applies here too. Without it, this endpoint would be a way around
    // the sign-in lockout: an attacker locked out of `/auth/login` could keep guessing
    // the password here instead. Same budget, same window.
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return { ok: false, error: 'too many failed attempts; try again later' };
    }

    // Every failure below returns the same message, or this endpoint becomes an
    // oracle for the credential it protects.
    const generic = { ok: false as const, error: 'invalid credentials' };

    if (!(await verifyPassword(String(passwordRaw ?? ''), user.password_hash))) {
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
      // Cascades to api_tokens, oauth_accounts, oauth_states, records and
      // user_settings. `auth_events` is deleted above rather than here because its
      // foreign key is ON DELETE SET NULL — a deliberate mismatch, since the audit
      // trail is the one place a delete must not be able to erase.
      await client.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    });

    // Unlocked sessions live in process memory, so the cascade cannot reach them.
    // Without this the deleted account's key would sit in memory for up to its idle
    // timeout, and a token minted before the delete would keep working.
    closeUserSessions(ctx.userId);

    return { ok: true, value: { deleted: true } };
  },

  /**
   * Redeem the single-use code from an OAuth callback for a session.
   *
   * The callback redirects the browser back to the app with a one-time code rather
   * than a session, so a URL that leaks out of browser history is not a credential.
   * This is where that code becomes a session again. Both providers share it: the
   * work below is about *this account*, not about who proved the identity.
   *
   * A provider proves *identity*; the key comes from the server's own copy of it, so
   * every provider sign-in ends in a real session. Callers use the returned
   * `username` to pre-fill the sign-in form, and when an unlock is already live on
   * this server it is reused instead — which is what makes provider login feel like
   * one click in the common case.
   */
  async completeProviderSignIn(
    provider: 'x' | 'google',
    oneTimeCode: unknown,
  ): Promise<Result<{ userId: string; username: string; token: string }>> {
    if (typeof oneTimeCode !== 'string' || oneTimeCode.length === 0) {
      return { ok: false, error: 'code: required' };
    }
    const userId = redeemOneTimeCode(oneTimeCode);
    if (!userId) return { ok: false, error: 'this sign-in link expired or was already used' };

    const user = await loadUser({ id: userId });
    if (!user) return { ok: false, error: 'linked account no longer exists' };
    // No completeness gate: the user has just proved identity with the provider, and
    // this session is what lets them bind the fallback credential that the records
    // gate asks for. Refusing here would be a dead end.

    // A live unlock on this server (e.g. another tab, or a recent sign-in) already
    // holds the key, so no password is needed from this caller.
    const existing = findUserSessionFor(userId);
    if (existing) {
      const token = openSession(userId, existing, getConfig().sessionTtlMinutes);
      await this.recordAuthEvent(userId, `${provider}_login_session_reused`);
      return { ok: true, value: { userId, username: user.username, token } };
    }

    // The deployment's own copy of the account key opens the records, so a provider
    // round-trip is enough on its own — which is exactly what "simple, easy to
    // recover" is supposed to mean. A deployment with no key has nothing to hand
    // over, and that is a misconfiguration rather than a state the user can fix.
    const serverDek = await serverDekFor(user);
    if (!serverDek) {
      return { ok: false, error: 'account key material is unreadable; set a new password to re-key it' };
    }
    const token = openSession(userId, serverDek, getConfig().sessionTtlMinutes);
    await this.recordAuthEvent(userId, `${provider}_login_server_unlock`);
    return { ok: true, value: { userId, username: user.username, token } };
  },

  /**
   * How many *independent* ways this account can be entered.
   *
   * Used to refuse an unlink that would strand the owner. The two kinds are a
   * password and each linked provider; two links to the same provider are one way in,
   * because losing that provider loses both.
   */
  async loginMethodsFor(userId: string): Promise<{ hasPassword: boolean; providers: string[] }> {
    const user = await loadUser({ id: userId });
    const { rows } = await getPool().query<{ provider: string }>(
      `SELECT DISTINCT provider FROM oauth_accounts WHERE user_id = $1`,
      [userId],
    );
    return {
      hasPassword: Boolean(user?.password_hash),
      providers: rows.map((r) => r.provider),
    };
  },

  /**
   * Give an account a fallback: an account name plus a password.
   *
   * This is the answer to "what if the social account is banned". Signing up through
   * X or Google creates an account whose only way in is that provider, so if the
   * provider bans the user, or revokes the application's credentials outright, the
   * account becomes unreachable while its records sit intact in the database. Binding
   * a name and password before that happens is what makes the records reachable.
   *
   * The name may be the one already generated at signup (renamed here) or any unused
   * one. `scrypt` with a random salt, same as registration — see `hashPassword`.
   */
  async bindCredentials(
    ctx: AuthContext,
    usernameRaw: unknown,
    passwordRaw: unknown,
  ): Promise<Result<{ username: string }>> {
    const username = validateUsername(usernameRaw);
    if (!username.ok) return username;
    const password = validatePassword(passwordRaw);
    if (!password.ok) return password;

    const user = await loadUser({ id: ctx.userId });
    if (!user) return { ok: false, error: 'account not found' };

    // Renaming to a name another account holds must fail loudly rather than as a
    // constraint violation: the handler maps this to a 409 the form can render.
    if (username.value !== user.username) {
      const taken = await loadUser({ username: username.value });
      if (taken) return { ok: false, error: 'username_taken' };
    }

    const passwordHash = await hashPassword(password.value);

    // The password has to *unlock*, not just authenticate.
    //
    // An account created through X or Google had no password, so its key material
    // carried no password wrapper — the DEK was only reachable through the server
    // wrapper. Writing the hash alone would let the user sign in and then find every
    // record sealed against them, which is the same deadlock this endpoint exists to
    // remove, one step later. The DEK is in hand already: it is the one the session
    // that is calling this was opened with, so wrapping it needs no unwrap.
    const metadata = await setPasswordWrapper(metadataFor(user), ctx.dek, password.value, ctx.userId);
    const legacy = passwordEnvelopeOf(metadata);

    try {
      await getPool().query(
        `UPDATE users
            SET username = $2, password_hash = $3,
                password_set_at = COALESCE(password_set_at, now()),
                encryption_metadata = $4, wrapped_dek = $5,
                updated_at = now()
          WHERE id = $1`,
        [
          ctx.userId,
          username.value,
          passwordHash,
          JSON.stringify(metadata),
          legacy ? JSON.stringify(legacy) : null,
        ],
      );
    } catch (error) {
      // The unique index is the real arbiter: two requests can both pass the check
      // above and only one can commit.
      if ((error as { code?: string }).code === '23505') {
        return { ok: false, error: 'username_taken' };
      }
      throw error;
    }

    await this.recordAuthEvent(ctx.userId, 'credentials_bound');
    return { ok: true, value: { username: username.value } };
  },

  /**
   * Unlink one provider.
   *
   * Refuses when this is the last way in. The comment this replaced claimed "a usable
   * account always has a password", which is false for exactly the accounts this
   * product creates through X: an OAuth signup has no password, so unlinking would
   * have left an account nobody — including its owner — could open.
   *
   * What guards it is the rule below and the fact that a session is needed to call
   * this at all.
   */
  async unlinkProvider(ctx: AuthContext, provider: string): Promise<Result<void>> {
    if (provider !== 'x' && provider !== 'google') {
      return { ok: false, error: 'unsupported provider' };
    }

    const user = await loadUser({ id: ctx.userId });
    if (!user) return { ok: false, error: 'account not found' };

    const { hasPassword, providers } = await this.loginMethodsFor(ctx.userId);
    const others = providers.filter((p) => p !== provider);
    if (!hasPassword && others.length === 0) {
      return {
        ok: false,
        error: 'this is the only way into the account — set an account name and password first',
      };
    }

    const { rowCount } = await getPool().query(
      `DELETE FROM oauth_accounts WHERE user_id = $1 AND provider = $2`,
      [ctx.userId, provider],
    );
    await this.recordAuthEvent(ctx.userId, rowCount ? `${provider}_unlinked` : `${provider}_unlink_noop`);
    return { ok: true, value: undefined };
  },

  /** Unlink X. Kept as a named alias so existing callers and tests keep working. */
  async unlinkX(ctx: AuthContext): Promise<Result<void>> {
    return await this.unlinkProvider(ctx, 'x');
  },

  async listXLinks(userId: string): Promise<{
    handle: string | null; avatarUrl: string | null; linkedAt: string; lastLoginAt: string | null;
  }[]> {
    return await this.listOAuthLinks(userId, 'x');
  },

  /** Every linked social account, or one provider's. Newest link first. */
  async listOAuthLinks(userId: string, provider?: string): Promise<{
    provider: string; handle: string | null; avatarUrl: string | null;
    linkedAt: string; lastLoginAt: string | null;
  }[]> {
    const { rows } = await getPool().query<{
      provider: string; handle: string | null; avatar_url: string | null;
      linked_at: Date; last_login_at: Date | null;
    }>(
      `SELECT provider, handle, avatar_url, linked_at, last_login_at
         FROM oauth_accounts
        WHERE user_id = $1 AND ($2::text IS NULL OR provider = $2)
        ORDER BY linked_at DESC`,
      [userId, provider ?? null],
    );
    return rows.map((r) => ({
      provider: r.provider,
      handle: r.handle,
      avatarUrl: r.avatar_url,
      linkedAt: r.linked_at.toISOString(),
      lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
    }));
  },

  /**
   * What the account page needs to guide someone into binding a fallback.
   *
   * `recoveryRisk` is the honest headline: true means this account has exactly one way
   * in and it is a social provider, so losing that provider loses the account. The UI
   * should say so plainly rather than waiting for it to happen.
   */
  async loginOverview(userId: string): Promise<{
    username: string;
    hasPassword: boolean;
    providers: string[];
    recoveryRisk: boolean;
  }> {
    const user = await loadUser({ id: userId });
    const { hasPassword, providers } = await this.loginMethodsFor(userId);
    return {
      username: user?.username ?? '',
      hasPassword,
      providers,
      recoveryRisk: !hasPassword && providers.length > 0,
    };
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
    const update: Partial<import('./settings.ts').UserSettings> = {};

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
