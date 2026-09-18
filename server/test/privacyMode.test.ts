/**
 * The two privacy modes.
 *
 * The spec's acceptance line is short: standard is simple and recoverable, advanced
 * keeps the server out of the data key, X + TOTP is identity in both, and a switch
 * never re-encrypts a record. Each of those is one test below, plus the security
 * regression the spec asks for explicitly — that nothing turns X + TOTP into a DEK.
 *
 * The test that carries the most weight is "a switch leaves the ciphertext byte for
 * byte". It is the difference between a rewrap and a rewrite, and it is the thing the
 * spec said to stop and report rather than fake.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';
import { registerAccount, signIn } from './helpers.ts';
import { getPool } from '../src/db.ts';
import { readMetadata, unwrapWithServer, unwrapWithPassword, generateRecoveryKey } from '../src/session.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

const SERVER_DEK_KEY = 'test-server-dek-key-0123456789abcdef';

before(async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    serverDekKey: SERVER_DEK_KEY,
    turnstile: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-privacy', port: 55446, database: 'hrt_privacy' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

const json = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function metadataFor(userId: string) {
  const { rows } = await getPool().query<{ privacy_mode: string; encryption_metadata: unknown }>(
    `SELECT privacy_mode, encryption_metadata FROM users WHERE id = $1`,
    [userId],
  );
  return { mode: rows[0].privacy_mode, metadata: readMetadata(rows[0].encryption_metadata) };
}

test('standard mode stores a server wrapper, and the server can open the key', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'standard' });
  const { mode, metadata } = await metadataFor(account.userId);

  assert.equal(mode, 'standard');
  assert.ok(metadata.wrappers.password, 'a password wrapper always exists');
  assert.ok(metadata.wrappers.server, 'standard mode adds the server wrapper');
  assert.equal(metadata.version, 2, 'the document is versioned explicitly');
  assert.equal(metadata.wrappers.server.scheme, 'server-hmac-sha256-v1');

  const dek = await unwrapWithServer(metadata, account.userId, SERVER_DEK_KEY);
  assert.ok(dek, 'the server key opens it, which is the whole point of the mode');
  // And the password still opens the same key — one DEK, two wrappers.
  const viaPassword = await unwrapWithPassword(metadata, account.password, account.userId);
  assert.equal(viaPassword, dek, 'both wrappers protect one DEK');
});

test('advanced mode stores no server wrapper at all', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'advanced' });
  const { mode, metadata } = await metadataFor(account.userId);

  assert.equal(mode, 'advanced');
  assert.ok(metadata.wrappers.password);
  assert.equal(metadata.wrappers.server, undefined, 'no server wrapper exists to open');
  assert.equal(
    await unwrapWithServer(metadata, account.userId, SERVER_DEK_KEY),
    null,
    'the server cannot unwrap what is not there',
  );
});

test('a default registration is standard, and unwraps the pre-migration way', async () => {
  resetRateLimits();
  const account = await registerAccount(base);
  const { mode, metadata } = await metadataFor(account.userId);
  assert.equal(mode, 'standard');
  assert.ok(metadata.wrappers.server);

  // The legacy column stays in step, so a reader that predates this release still works.
  const { rows } = await getPool().query<{ wrapped_dek: unknown }>(
    `SELECT wrapped_dek FROM users WHERE id = $1`,
    [account.userId],
  );
  assert.ok(rows[0].wrapped_dek, 'wrapped_dek mirrors the password wrapper');
  const legacy = rows[0].wrapped_dek as { data: string };
  assert.equal(legacy.data, metadata.wrappers.password!.data, 'byte-identical to the wrapper');
});

test('a switch rewraps the DEK and leaves every record ciphertext untouched', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'standard' });

  const created = await call(
    base,
    '/api/medications',
    json(
      {
        route: 'injection',
        ester: 'EV',
        dose_mg: 6,
        at: new Date().toISOString(),
        extras: {},
        id: `bytecheck-${Date.now()}`,
      },
      account.token,
    ),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;

  const readPayload = async () => {
    const { rows } = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM medication_events WHERE id = $1`,
      [id],
    );
    return JSON.stringify(rows[0].payload);
  };

  const before = await readPayload();

  // standard -> advanced
  const up = await call(
    base,
    '/auth/privacy-mode',
    json({ privacy_mode: 'advanced', current_password: account.password }, account.token),
  );
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await metadataFor(account.userId)).metadata.wrappers.server, undefined, 'the server wrapper is gone');
  assert.equal(await readPayload(), before, 'standard -> advanced does not touch the record');

  // advanced -> standard
  const down = await call(
    base,
    '/auth/privacy-mode',
    json({ privacy_mode: 'standard', current_password: account.password }, account.token),
  );
  assert.equal(down.status, 200, JSON.stringify(down.body));
  assert.ok((await metadataFor(account.userId)).metadata.wrappers.server, 'the server wrapper is back');
  assert.equal(await readPayload(), before, 'advanced -> standard does not either');

  // And the account still reads its records after both switches.
  const back = await call(base, '/api/medications', auth(account.token));
  assert.equal(back.status, 200);
});

test('a mode switch needs the current password', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'standard' });
  const wrong = await call(
    base,
    '/auth/privacy-mode',
    json({ privacy_mode: 'advanced', current_password: 'not-the-password' }, account.token),
  );
  assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
  assert.match(String(wrong.body.error), /password/i);
  assert.equal((await metadataFor(account.userId)).mode, 'standard', 'the mode did not change');
});

test('X sign-in in standard mode reaches the records; in advanced it does not', async () => {
  resetRateLimits();

  // Standard: the server key is enough, so a locked-out session is not needed.
  const standard = await registerAccount(base, { privacyMode: 'standard' });
  const standardUser = await getUser(standard.username);
  const standardToken = await xSignInRedeem(standardUser);
  assert.ok(standardToken, 'standard mode hands back a real session');
  const okRead = await call(base, '/api/medications', auth(standardToken!));
  assert.equal(okRead.status, 200, 'and it reads records');

  // Advanced: X proves identity, and the key still needs the password.
  const advanced = await registerAccount(base, { privacyMode: 'advanced' });
  const advancedUser = await getUser(advanced.username);
  const redeemed = await xSignInExchange(advancedUser);
  assert.equal(redeemed.token, null, 'X alone yields no session in advanced mode');
  assert.ok(redeemed.locked_token, 'instead it yields a locked token');
  assert.ok(redeemed.locked_token.startsWith('lu_'), 'with the locked-token shape');
});

test('a locked session unlocks with the password, and rejects a wrong one', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'advanced' });
  const user = await getUser(account.username);
  const redeemed = await xSignInExchange(user);
  const lockedToken = redeemed.locked_token;

  const wrong = await call(base, '/auth/unlock', json({ locked_token: lockedToken, factor: 'password', password: 'nope-nope-nope' }));
  assert.equal(wrong.status, 401, JSON.stringify(wrong.body));

  // The token survives a failed attempt: a mistyped password must not cost a new X trip.
  const right = await call(
    base,
    '/auth/unlock',
    json({ locked_token: lockedToken, factor: 'password', password: account.password }),
  );
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.ok(right.body.token, 'a real session comes back');
  const meds = await call(base, '/api/medications', auth(right.body.token));
  assert.equal(meds.status, 200, 'and it works');
});

test('a recovery key unlocks an advanced account, and a wrong one does not', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'advanced' });

  const created = await call(base, '/auth/recovery-key', json({ current_password: account.password }, account.token));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const recoveryKey: string = created.body.recovery_key;
  assert.ok(recoveryKey && recoveryKey.includes('-'), 'a grouped, high-entropy key');

  // The server stores only a wrapper, never the key.
  const { metadata } = await metadataFor(account.userId);
  assert.ok(metadata.wrappers.recovery, 'a recovery wrapper exists');
  assert.ok(!JSON.stringify(metadata).includes(recoveryKey), 'the key itself is nowhere in storage');

  const wrong = await call(base, '/auth/unlock', json({ locked_token: await lockedFor(account), factor: 'recovery', recovery_key: generateRecoveryKey() }));
  assert.equal(wrong.status, 401, 'a random key is refused');

  const right = await call(
    base,
    '/auth/unlock',
    json({ locked_token: await lockedFor(account), factor: 'recovery', recovery_key: recoveryKey }),
  );
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.ok(right.body.token);
});

test('a durable token reaches records in standard mode but not advanced', async () => {
  resetRateLimits();

  for (const mode of ['standard', 'advanced'] as const) {
    const account = await registerAccount(base, { privacyMode: mode });
    const minted = await call(base, '/api/tokens', json({ name: `agent-${mode}` }, account.token));
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const apiToken: string = minted.body.token;

    // Sign out, dropping the live unlock.
    await call(base, '/auth/logout', json({}, account.token));

    const read = await call(base, '/api/medications', auth(apiToken));
    if (mode === 'standard') {
      assert.equal(read.status, 200, 'standard: the server key is enough for a live token');
    } else {
      assert.equal(read.status, 401, 'advanced: no server key exists, so the token alone reads nothing');
    }
  }
});

test('X + TOTP never yields the DEK, and neither does the TOTP secret', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'advanced' });

  // The TOTP secret is on the server (sealed), so it plainly cannot be the key: the
  // DEK is random and independent. Asserted structurally — the wrapper set has no
  // member keyed by the secret, and the secret is not stored in the metadata.
  const { metadata } = await metadataFor(account.userId);
  assert.ok(!JSON.stringify(metadata).includes(account.secret), 'the TOTP secret is not key material');

  // And a full password + TOTP sign-in does open data — that is the user's own
  // credential working — but completing X + TOTP alone (no password) never does.
  const signInResult = await signIn(base, account);
  assert.equal(signInResult.status, 200, 'password + TOTP is the user unlocking their own data');

  const fresh = await registerAccount(base, { privacyMode: 'advanced' });
  const user = await getUser(fresh.username);
  const redeemed = await xSignInExchange(user);
  assert.equal(redeemed.token, null, 'X + TOTP alone is identity, not access');
});

// --- helpers the X flow needs, since there is no live X in this suite ----------

async function getUser(username: string) {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [username]);
  return rows[0].id;
}

/** Mint a locked session directly, for tests that need one without an X round-trip. */
async function lockedFor(account: { userId: string }): Promise<string> {
  const { openLockedSession } = await import('../src/session.ts');
  return openLockedSession(account.userId, 30);
}

/**
 * The standard-mode X path: an account with a server wrapper signs in from X alone.
 *
 * Driven through `completeXSignIn` rather than a stubbed HTTP callback, because what
 * is under test is the key decision inside it, not the OAuth plumbing (covered in
 * `accounts.test.ts`).
 *
 * Every live unlock is dropped first. Registration opens one, and an X sign-in that
 * found it would correctly reuse it — a different behaviour, and not the one these
 * tests are about. Dropping them is what makes this look like a fresh device.
 */
async function xSignInRedeem(userId: string): Promise<string | null> {
  const { AccountService } = await import('../src/accounts.ts');
  const { issueOneTimeCode, closeUserSessions } = await import('../src/session.ts');
  closeUserSessions(userId);
  const code = issueOneTimeCode(userId);
  const result = await AccountService.completeXSignIn(code);
  assert.ok(result.ok, JSON.stringify(result));
  return result.ok ? result.value.token : null;
}

async function xSignInExchange(userId: string): Promise<{ token: string | null; locked_token?: string }> {
  const { AccountService } = await import('../src/accounts.ts');
  const { issueOneTimeCode, closeUserSessions } = await import('../src/session.ts');
  closeUserSessions(userId);
  const code = issueOneTimeCode(userId);
  const result = await AccountService.completeXSignIn(code);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return { token: null };
  return { token: result.value.token, locked_token: result.value.lockedToken };
}
