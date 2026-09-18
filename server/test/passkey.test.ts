/**
 * Passkeys: the key path and the step-up gate.
 *
 * A real WebAuthn ceremony needs a virtual authenticator, which this suite has no
 * harness for, and the parts of the flow that could really be wrong are not the
 * ceremony — `@simplewebauthn/server` verifies signatures, and that is its tested job.
 * What is *ours*, and what these tests cover, is:
 *
 *   1. **The PRF→KEK path.** A passkey's PRF output has to wrap and unwrap the same DEK
 *      the password wraps. If this is broken the credential looks registered and can
 *      never open anything, which is the failure mode with no error message.
 *   2. **One DEK, many passkeys.** Adding a second authenticator must not orphan the
 *      first — that is what the wrappers *map* exists for.
 *   3. **The step-up gate.** An advanced account with a passkey must refuse a durable
 *      token unless a passkey-proven unlock is live. This is the requirement's whole
 *      point, and it is the one thing here that is a security property rather than a
 *      behaviour.
 *   4. **The salt agrees across the boundary.** The browser and server each hold a
 *      copy of the PRF salt; if they drift, every passkey silently stops working and
 *      no test of either side alone would notice.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { setConfigForTesting, loadConfig } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';
import { registerAccount, signIn } from './helpers.ts';
import { getPool } from '../src/db.ts';
import {
  readMetadata,
  createKeyMaterial,
  addPasskeyWrapper,
  unwrapWithPasskey,
  removePasskeyWrapper,
  unwrapWithPassword,
  PRF_SALT,
  openSession,
  markSessionPasskeyVerified,
  hasPasskeyVerification,
  closeUserSessions,
} from '../src/session.ts';
import { MAX_PASSKEYS_PER_ACCOUNT, __clearChallengesForTest } from '../src/webauthn.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

before(async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    turnstile: null,
    webauthn: {
      rpId: 'hrt.test',
      rpName: 'Kira Tracker',
      origins: ['https://hrt.test', 'https://api.hrt.test'],
    },
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-passkey', port: 55448, database: 'hrt_passkey' });
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

/** A stand-in for a PRF output: 32 bytes of "authenticator output". */
function fakePrf(seed: string): string {
  return Buffer.alloc(32, seed).toString('base64');
}

/**
 * A registration response whose only real content is the challenge.
 *
 * The server reads `challenge` out of `clientDataJSON` before it verifies anything, which
 * is what lets these tests drive the challenge storage directly: the attestation is
 * deliberately garbage, so reaching "could not be verified" proves the challenge was
 * accepted, and reaching "expired or was already used" proves it was not.
 */
function fakeRegistration(challenge: string) {
  return {
    id: 'not-a-credential',
    rawId: 'not-a-credential',
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge }),
      ).toString('base64url'),
      attestationObject: 'AAAA',
    },
  };
}

// --- the key path -----------------------------------------------------------

test('a passkey PRF output wraps and unwraps the same DEK the password does', async () => {
  const { metadata, dek } = await createKeyMaterial('a-password-123456', 'user-1', {});
  const next = await addPasskeyWrapper(metadata, dek, 'cred-abc', fakePrf('a'));

  assert.equal(await unwrapWithPasskey(next, 'cred-abc', fakePrf('a')), dek, 'the same DEK comes back');
  assert.equal(
    await unwrapWithPassword(next, 'a-password-123456', 'user-1'),
    dek,
    'and the password wrapper still opens it too — one DEK, two ways in',
  );
  assert.ok(next.wrappers.passkeys?.['cred-abc'], 'the wrapper is stored under the credential id');
  assert.equal(next.wrappers.passkeys!['cred-abc'].kdf, 'webauthn-prf-hkdf-sha256');
});

test('a wrong PRF output cannot open the wrapper', async () => {
  const { metadata, dek } = await createKeyMaterial('a-password-123456', 'user-2', {});
  const next = await addPasskeyWrapper(metadata, dek, 'cred-abc', fakePrf('a'));
  assert.equal(await unwrapWithPasskey(next, 'cred-abc', fakePrf('b')), null, 'a different output fails');
  assert.equal(await unwrapWithPasskey(next, 'other-credential', fakePrf('a')), null, 'a different id fails');
});

test('adding a second passkey does not orphan the first', async () => {
  const { metadata, dek } = await createKeyMaterial('a-password-123456', 'user-3', {});
  const one = await addPasskeyWrapper(metadata, dek, 'cred-1', fakePrf('1'));
  const two = await addPasskeyWrapper(one, dek, 'cred-2', fakePrf('2'));

  assert.equal(await unwrapWithPasskey(two, 'cred-1', fakePrf('1')), dek, 'the first still opens it');
  assert.equal(await unwrapWithPasskey(two, 'cred-2', fakePrf('2')), dek, 'and so does the second');
});

test('removing a passkey drops only its wrapper', async () => {
  const { metadata, dek } = await createKeyMaterial('a-password-123456', 'user-4', {});
  const one = await addPasskeyWrapper(metadata, dek, 'cred-1', fakePrf('1'));
  const two = await addPasskeyWrapper(one, dek, 'cred-2', fakePrf('2'));
  const stripped = removePasskeyWrapper(two, 'cred-1');

  assert.equal(await unwrapWithPasskey(stripped, 'cred-1', fakePrf('1')), null, 'the removed one is gone');
  assert.equal(await unwrapWithPasskey(stripped, 'cred-2', fakePrf('2')), dek, 'the other is untouched');
  assert.equal(
    await unwrapWithPassword(stripped, 'a-password-123456', 'user-4'),
    dek,
    'and the password is unaffected',
  );
});

// --- the salt must agree across the browser/server boundary -----------------

test('the PRF salt is identical in the server and the browser client', () => {
  const client = readFileSync(new URL('../../src/utils/passkeys.ts', import.meta.url), 'utf8');
  const match = /const PRF_SALT = '([^']+)'/.exec(client);
  assert.ok(match, 'the client declares a PRF salt');
  assert.equal(
    match![1],
    PRF_SALT,
    'they must match byte for byte, or every passkey silently stops opening the data key',
  );
});

// --- the step-up gate -------------------------------------------------------

test('an advanced account with a passkey refuses a durable token until a passkey unlock', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'advanced' });

  // Give the account a passkey credential. The ceremony itself is not what is under
  // test here — the resolver's reaction to a *registered* passkey is, and a row in the
  // table is exactly what it reads.
  await getPool().query(
    `INSERT INTO webauthn_credentials (credential_id, user_id, public_key, sign_count)
     VALUES ($1, $2, $3, 0)`,
    ['test-credential-id', account.userId, Buffer.from([1, 2, 3])],
  );

  // Mint a durable token while the account is unlocked.
  const minted = await call(base, '/api/tokens', json({ name: 'agent' }, account.token));
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const apiToken: string = minted.body.token;

  // Drop every live unlock. Advanced mode means the token alone reaches nothing, and
  // with a passkey registered the reason is now specifically a step-up.
  closeUserSessions(account.userId);

  const stepUpRequired = await call(base, '/api/medications', auth(apiToken));
  assert.equal(stepUpRequired.status, 401, 'a durable token alone is not enough here');

  // The MCP layer reports the *specific* reason, which is what an agent relays.
  const { AccountService } = await import('../src/accounts.ts');
  const denied = await AccountService.resolveApiContext(apiToken);
  assert.ok(denied && 'denied' in denied, 'the resolver reports a denial object');
  assert.equal(denied!.denied, 'step_up', 'and names the step-up, not the generic lock');

  // Once a passkey-proven unlock is live, the same token works.
  const session = openSession(account.userId, 'z'.repeat(43), 30, { passkeyVerified: true });
  assert.ok(session, 'a passkey-verified session opens');
  const allowed = await AccountService.resolveApiContext(apiToken);
  assert.ok(allowed && !('denied' in allowed), 'and the token now resolves to a context');
});

test('a passkey-proven session satisfies the step-up; a password session alone does not', () => {
  const userId = 'user-stepup';
  const dek = 'a'.repeat(43);

  // A plain unlock (as a password sign-in produces).
  const plain = openSession(userId, dek, 30);
  assert.equal(findHasPasskey(userId), false, 'a password session is not a passkey step-up');

  // Upgrade that same session in place — what the step-up does.
  assert.equal(markSessionPasskeyVerified(plain), true, 'the live session is found and marked');
  assert.equal(findHasPasskey(userId), true, 'and now counts as a passkey-proven unlock');

  // A fresh, unrelated account is unaffected.
  assert.equal(findHasPasskey('someone-else'), false, 'the proof is scoped to the account');

  closeUserSessions(userId);
  assert.equal(findHasPasskey(userId), false, 'logging out clears it');
});

test('marking an unknown token reports failure rather than inventing a session', () => {
  assert.equal(markSessionPasskeyVerified('ks_not-a-real-token'), false);
});

test('a session opened by a passkey is passkey-verified from the start', () => {
  const token = openSession('user-pk', 'b'.repeat(43), 30, { passkeyVerified: true });
  assert.equal(findHasPasskey('user-pk'), true);

  // A password session for the same account is *not* what satisfies it on its own —
  // verified by a second account whose session lacks the flag.
  openSession('user-pw', 'c'.repeat(43), 30);
  assert.equal(findHasPasskey('user-pw'), false);
  void token;
});

// --- config derivation ------------------------------------------------------

test('the RP ID is derived from the API origin and suffixes every origin', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
    API_ORIGIN: 'https://api.kiramyao.com',
    DATABASE_URL: 'postgres://x/y',
    TOTP_ENC_KEY: 'a'.repeat(40),
    SERVER_DEK_KEY: 'b'.repeat(40),
  });
  assert.equal(config.webauthn?.rpId, 'kiramyao.com', 'the registrable domain, not a host');
  assert.deepEqual(config.webauthn?.origins, ['https://hrt.kiramyao.com', 'https://api.kiramyao.com']);
});

test('an RP ID that does not suffix the host is refused at boot', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
        API_ORIGIN: 'https://api.kiramyao.com',
        DATABASE_URL: 'postgres://x/y',
        TOTP_ENC_KEY: 'a'.repeat(40),
        SERVER_DEK_KEY: 'b'.repeat(40),
        WEBAUTHN_RP_ID: 'example.com',
      }),
    /must be a suffix/,
    'a credential scoped to a foreign domain could never be used, so it fails loudly',
  );
});

test('passkeys can be switched off entirely', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
    API_ORIGIN: 'https://api.kiramyao.com',
    DATABASE_URL: 'postgres://x/y',
    TOTP_ENC_KEY: 'a'.repeat(40),
    SERVER_DEK_KEY: 'b'.repeat(40),
    WEBAUTHN_ENABLED: 'false',
  });
  assert.equal(config.webauthn, null);
});

// --- HTTP surface -----------------------------------------------------------

test('the passkey routes require configuration and report it cleanly', async () => {
  const account = await registerAccount(base);
  const listed = await call(base, '/auth/passkeys', auth(account.token));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.passkeys, [], 'a new account has none');

  // Registration needs the password, so a bare session call is refused.
  const noPassword = await call(base, '/auth/passkeys/register/start', json({}, account.token));
  assert.equal(noPassword.status, 400, 'the password is required to add a credential');

  const wrongPassword = await call(
    base,
    '/auth/passkeys/register/start',
    json({ current_password: 'wrong-password-x' }, account.token),
  );
  assert.equal(wrongPassword.status, 400);
  assert.match(String(wrongPassword.body.error), /password/i);

  // The correct password yields real creation options.
  const started = await call(
    base,
    '/auth/passkeys/register/start',
    json({ current_password: account.password }, account.token),
  );
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok(started.body.options?.challenge, 'a challenge is issued');
  assert.equal(started.body.options?.rp?.id, 'hrt.test', 'scoped to the RP ID');
  assert.equal(started.body.options?.authenticatorSelection?.residentKey, 'required', 'discoverable');
  assert.equal(
    started.body.options?.authenticatorSelection?.userVerification,
    'required',
    'UV is what the step-up depends on',
  );
  assert.ok(started.body.options?.extensions?.prf, 'PRF is requested — it is the key material');
});

test('passkey sign-in starts without a username, which is the discoverable flow', async () => {
  const started = await call(base, '/auth/passkeys/authenticate/start', json({}));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok(started.body.options?.challenge);
  assert.equal(started.body.options?.allowCredentials, undefined, 'no allow-list means discoverable');
  assert.equal(started.body.options?.userVerification, 'required');
});

test('finishing a sign-in without PRF output is refused rather than silently downgraded', async () => {
  const account = await registerAccount(base, { privacyMode: 'advanced' });
  const started = await call(base, '/auth/passkeys/authenticate/start', json({}));
  const response = {
    id: 'not-a-credential',
    rawId: 'not-a-credential',
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: { clientDataJSON: '', authenticatorData: '', signature: '', userHandle: null },
  };

  const noPrf = await call(base, '/auth/passkeys/authenticate/finish', json({ response }));
  assert.equal(noPrf.status, 401);
  assert.match(String(noPrf.body.error), /PRF/);
  void started;
  void account;
});

test('removing a passkey that is not on the account is refused', async () => {
  const account = await registerAccount(base);
  const removed = await call(base, '/auth/passkeys', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ id: 'someone-elses-credential' }),
  });
  assert.equal(removed.status, 400);
  assert.match(String(removed.body.error), /not on this account/);
});

test('a signed-in account can still sign in with its password after registering a passkey', async () => {
  // The regression that would matter most: adding a credential must not make the
  // password path stop working.
  resetRateLimits();
  const account = await registerAccount(base);
  await getPool().query(
    `INSERT INTO webauthn_credentials (credential_id, user_id, public_key, sign_count)
     VALUES ($1, $2, $3, 0)`,
    ['regression-cred', account.userId, Buffer.from([9, 9, 9])],
  );

  const again = await signIn(base, account, 1);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(again.body.token, 'the password path is untouched');
});

// --- the challenge store ----------------------------------------------------

test('a challenge is a row another instance could read, and spending it deletes it', async () => {
  resetRateLimits();
  await __clearChallengesForTest();
  const account = await registerAccount(base, { privacyMode: 'advanced' });

  const started = await call(
    base,
    '/auth/passkeys/register/start',
    json({ current_password: account.password }, account.token),
  );
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const challenge: string = started.body.options.challenge;

  const stored = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM webauthn_challenges WHERE challenge = $1`,
    [challenge],
  );
  assert.equal(stored.rowCount, 1, 'the challenge is in the table, not in this process');
  assert.equal(stored.rows[0].user_id, account.userId, 'and is scoped to the account');

  const spent = await call(
    base,
    '/auth/passkeys/register/finish',
    json({ response: fakeRegistration(challenge), prf_output: fakePrf('z') }, account.token),
  );
  assert.equal(spent.status, 400, JSON.stringify(spent.body));
  assert.match(String(spent.body.error), /could not be verified/, 'the challenge was accepted');

  const after = await getPool().query(`SELECT 1 FROM webauthn_challenges WHERE challenge = $1`, [
    challenge,
  ]);
  assert.equal(after.rowCount, 0, 'single use: consuming it removes the row');

  // Replaying the same value is refused, which is the property the row exists for.
  const replay = await call(
    base,
    '/auth/passkeys/register/finish',
    json({ response: fakeRegistration(challenge), prf_output: fakePrf('z') }, account.token),
  );
  assert.equal(replay.status, 400);
  assert.match(String(replay.body.error), /expired or was already used/);
});

test('one account cannot spend a challenge minted for another', async () => {
  resetRateLimits();
  await __clearChallengesForTest();
  const alice = await registerAccount(base, { privacyMode: 'advanced' });
  const bob = await registerAccount(base, { privacyMode: 'advanced' });

  const started = await call(
    base,
    '/auth/passkeys/register/start',
    json({ current_password: alice.password }, alice.token),
  );
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const challenge: string = started.body.options.challenge;
  const body = json({ response: fakeRegistration(challenge), prf_output: fakePrf('y') });

  // The scope check is the difference between "the row is there" and "the row is yours":
  // without it, a credential registered to Bob could answer Alice's ceremony.
  const stolen = await call(base, '/auth/passkeys/register/finish', { ...body, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` } });
  assert.equal(stolen.status, 400, JSON.stringify(stolen.body));
  assert.match(String(stolen.body.error), /expired or was already used/, 'Bob is refused');

  // Alice gets past that check and fails on the bogus attestation instead, which is how
  // this test knows the refusal above was the scope check and not a missing row.
  const hers = await call(
    base,
    '/auth/passkeys/register/finish',
    json({ response: fakeRegistration(challenge), prf_output: fakePrf('y') }, alice.token),
  );
  assert.equal(hers.status, 400);
  assert.match(String(hers.body.error), /could not be verified/);
});

// --- the ceiling ------------------------------------------------------------

test('an account stops at the passkey ceiling, and the list reports it', async () => {
  resetRateLimits();
  const account = await registerAccount(base, { privacyMode: 'advanced' });
  const insert = (id: string) =>
    getPool().query(
      `INSERT INTO webauthn_credentials (credential_id, user_id, public_key, sign_count)
       VALUES ($1, $2, $3, 0)`,
      [id, account.userId, Buffer.from([1, 2, 3])],
    );
  const start = () =>
    call(
      base,
      '/auth/passkeys/register/start',
      json({ current_password: account.password }, account.token),
    );

  for (let i = 0; i < MAX_PASSKEYS_PER_ACCOUNT - 1; i++) await insert(`cap-cred-${i}`);
  const room = await start();
  assert.equal(room.status, 200, 'one below the ceiling still gets options');

  await insert('cap-cred-last');
  const full = await start();
  assert.equal(full.status, 400, 'the ceiling is enforced');
  assert.match(String(full.body.error), new RegExp(`maximum of ${MAX_PASSKEYS_PER_ACCOUNT} passkeys`));

  // Refused before any challenge was minted, so no system prompt was wasted on it.
  const left = await getPool().query(
    `SELECT 1 FROM webauthn_challenges WHERE user_id = $1`,
    [account.userId],
  );
  assert.equal(left.rowCount, 1, 'only the accepted attempt minted a challenge');

  const listed = await call(base, '/auth/passkeys', auth(account.token));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.max, MAX_PASSKEYS_PER_ACCOUNT, 'the ceiling travels with the list');
  assert.equal(listed.body.passkeys.length, MAX_PASSKEYS_PER_ACCOUNT);
});

// --- the step-up freshness window -------------------------------------------

test('a passkey proof stops counting once it is older than the window', async () => {
  const userId = 'user-window';
  openSession(userId, 'a'.repeat(43), 30, { passkeyVerified: true });
  assert.equal(hasPasskeyVerification(userId), true, 'a live proof counts');
  assert.equal(hasPasskeyVerification(userId, 60 * 60 * 1000), true, 'an hour of slack still allows it');

  // The window is what makes "someone is here now" different from "a passkey was used at
  // some point in this session", which is the property advanced mode rests on.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(hasPasskeyVerification(userId, 1), false, 'a millisecond of slack does not');

  closeUserSessions(userId);
  assert.equal(hasPasskeyVerification(userId, 60 * 60 * 1000), false, 'nothing survives logout');
});

/** Small local alias so the session assertions read clearly. */
function findHasPasskey(userId: string): boolean {
  return hasPasskeyVerification(userId);
}
