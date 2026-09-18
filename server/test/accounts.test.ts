/**
 * Accounts: mandatory TOTP, recovery codes, and X as an assist.
 *
 * The rules under test are the ones the user asked for, stated as behaviour:
 *
 *   1. Registration does NOT produce a usable session. TOTP is mandatory, so an
 *      account becomes usable only when a code from its new secret is confirmed.
 *   2. Sign-in requires a password AND a TOTP code (or a single-use recovery code).
 *   3. A TOTP code cannot be replayed inside its own validity window.
 *   4. X login verifies identity but cannot produce a working session on its own,
 *      because the data key is wrapped under the password.
 *   5. An X-created account has no key and no records until a password is set and
 *      TOTP enrolled — so losing X costs a login button, never the data.
 *
 * X's HTTP endpoints are stubbed rather than called: these tests must not depend on
 * the network, a real X app, or rate limits, and the thing being tested is this
 * server's handling of the responses, not X's availability.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { totpCodeAt, generateTotpSecret, base32Encode } from '../src/totp.ts';
import { setConfigForTesting } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';
import { closeUserSessions } from '../src/session.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

const PUBLIC_ORIGIN = 'https://hrt.test';
const API_ORIGIN = 'https://api.hrt.test';
const X_CLIENT_ID = 'test-client-id';
const X_CLIENT_SECRET = 'test-client-secret';
const X_REDIRECT_URI = `${API_ORIGIN}/auth/x/callback`;

before(async () => {
  // Configuration is installed before the database so that any module reading it at
  // import time sees a valid value.
  setConfigForTesting({
    publicOrigin: PUBLIC_ORIGIN,
    apiOrigin: API_ORIGIN,
    basePath: '',
    apiBaseUrl: API_ORIGIN,
    port: 0,
    databaseUrl: '',
    // Deterministic and long enough for the seal.
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    turnstile: null,
    x: { clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET, redirectUri: X_REDIRECT_URI },
    sessionTtlMinutes: 30,
    // Generous, so one test's attempts never consume another's budget. The limits
    // themselves are exercised by their own test below.
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  });

  pg = await bootPostgres({ dir: './.pgdata-accounts', port: 55440, database: 'hrt_accounts' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const auth = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

/** Resolve a username to its id, for tests that need to manipulate sessions directly. */
async function userIdFor(username: string): Promise<string> {
  const { getPool } = await import('../src/db.ts');
  const { rows } = await getPool().query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
  assert.ok(rows[0], `no such user: ${username}`);
  return rows[0].id;
}

/** Register and complete enrolment, returning a usable session. */
async function createAccount(): Promise<{ username: string; password: string; secret: string; token: string; backupCodes: string[] }> {
  const username = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = 'a-good-password-1';
  const reg = await call(base, '/auth/register', json({ username, password }));
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const secret: string = reg.body.totp.secret;
  const backupCodes: string[] = reg.body.totp.backup_codes;

  const confirm = await call(
    base,
    '/auth/totp/confirm',
    json({ enrollment_token: reg.body.enrollment_token, code: totpCodeAt(secret) }),
  );
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  return { username, password, secret, token: confirm.body.token, backupCodes };
}

// ---------------------------------------------------------------------------
// Registration and mandatory enrolment
// ---------------------------------------------------------------------------

test('registration returns enrolment material but NO session', async () => {
  resetRateLimits();
  const username = `r${Date.now().toString(36)}`;
  const reg = await call(base, '/auth/register', json({ username, password: 'a-good-password-1' }));

  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  // The account is deliberately unusable: TOTP is mandatory, so handing back a
  // session here would let anyone who knows a password skip the second factor.
  assert.equal(reg.body.token, undefined, 'registration must not issue a session token');
  assert.ok(reg.body.enrollment_token, 'an enrolment token is returned instead');
  assert.ok(reg.body.totp.secret, 'the TOTP secret is returned for the QR code');
  assert.ok(reg.body.totp.otpauth_uri.startsWith('otpauth://totp/'), 'a scannable URI is returned');
  assert.equal(reg.body.totp.backup_codes.length, 10, 'recovery codes are issued');
});

test('the account is unusable until TOTP is confirmed', async () => {
  const username = `p${Date.now().toString(36)}`;
  const password = 'a-good-password-1';
  const reg = await call(base, '/auth/register', json({ username, password }));
  const secret: string = reg.body.totp.secret;

  // A correct password and a correct code still fail: the account is not enrolled
  // yet, so there is no completed second factor to check against.
  const early = await call(base, '/auth/login', json({ username, password, code: totpCodeAt(secret) }));
  assert.equal(early.status, 401);
  assert.match(early.body.error, /setup was not completed/i, `got: ${early.body.error}`);

  // Confirming makes it usable.
  const confirm = await call(
    base,
    '/auth/totp/confirm',
    json({ enrollment_token: reg.body.enrollment_token, code: totpCodeAt(secret) }),
  );
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  const after = await call(base, '/auth/login', json({ username, password, code: totpCodeAt(secret) }));
  assert.equal(after.status, 200, 'the account works once enrolled');
});

test('confirming with a wrong code does not enrol the account', async () => {
  const username = `w${Date.now().toString(36)}`;
  const reg = await call(base, '/auth/register', json({ username, password: 'a-good-password-1' }));

  const bad = await call(
    base,
    '/auth/totp/confirm',
    json({ enrollment_token: reg.body.enrollment_token, code: '000000' }),
  );
  assert.equal(bad.status, 400);

  // An enrolment token is single-use, so the failed attempt consumed it — the
  // client must resume rather than reuse it.
  const retry = await call(
    base,
    '/auth/totp/confirm',
    json({ enrollment_token: reg.body.enrollment_token, code: totpCodeAt(reg.body.totp.secret) }),
  );
  assert.equal(retry.status, 400, 'a spent enrolment token cannot be replayed');
  assert.match(retry.body.error, /expired or already completed/i, `got: ${retry.body.error}`);
});

test('an abandoned registration can be resumed with the password', async () => {
  const username = `a${Date.now().toString(36)}`;
  const password = 'a-good-password-1';
  await call(base, '/auth/register', json({ username, password }));
  // The new secret supersedes the old one, which is why the fresh material must be
  // used rather than what registration returned.
  const resumed = await call(base, '/auth/totp/resume', json({ username, password }));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.ok(resumed.body.enrollment_token, 'resume issues a new enrolment token');

  const confirm = await call(
    base,
    '/auth/totp/confirm',
    json({ enrollment_token: resumed.body.enrollment_token, code: totpCodeAt(resumed.body.totp.secret) }),
  );
  assert.equal(confirm.status, 200);
  const login = await call(base, '/auth/login', json({ username, password, code: totpCodeAt(resumed.body.totp.secret) }));
  assert.equal(login.status, 200, 'the resumed account works');
});

// ---------------------------------------------------------------------------
// Sign-in: both factors required
// ---------------------------------------------------------------------------

test('a password alone is refused, and the client is told a code is needed', async () => {
  const account = await createAccount();
  const onlyPassword = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password }),
  );
  assert.equal(onlyPassword.status, 401);
  // Distinguishable on purpose: the password is already proven at this point, so the
  // client can prompt for a code without that revealing anything exploitable.
  assert.equal(onlyPassword.body.error, 'two_factor_required');
});

test('a wrong or missing code fails, and a bad password is indistinguishable from a bad code', async () => {
  const account = await createAccount();

  const wrongCode = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password, code: '000000' }),
  );
  assert.equal(wrongCode.status, 401);
  assert.equal(wrongCode.body.error, 'invalid credentials', 'a wrong code must not be distinguishable');

  const wrongPassword = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: 'not-the-password', code: totpCodeAt(account.secret) }),
  );
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error, 'invalid credentials');

  const noSuchUser = await call(
    base,
    '/auth/login',
    json({ username: 'nosuchuser_xyz', password: 'whatever-password', code: '123456' }),
  );
  assert.equal(noSuchUser.body.error, 'invalid credentials', 'unknown accounts look the same');
});

test('a TOTP code cannot be replayed', async () => {
  const account = await createAccount();
  const code = totpCodeAt(account.secret);

  const first = await call(base, '/auth/login', json({ username: account.username, password: account.password, code }));
  assert.equal(first.status, 200, 'the first use succeeds');

  // The same code inside its 30-second window must not work twice. Without the
  // step bookkeeping, an observed code would be reusable for its whole validity.
  const replay = await call(base, '/auth/login', json({ username: account.username, password: account.password, code }));
  assert.equal(replay.status, 401, 'the same code must not work twice');
  assert.equal(replay.body.error, 'invalid credentials');
});

test('repeated failures lock the account', async () => {
  const account = await createAccount();
  // Raised limits keep the per-IP limiter out of the way so this exercises the
  // per-account lockout. Both exist because they stop different attacks; this test
  // is about the per-account one.
  let last: { status: number; body: { error: string } } = { status: 0, body: { error: '' } };
  for (let i = 0; i < 6; i++) {
    last = await call(
      base,
      '/auth/login',
      json({ username: account.username, password: 'wrong-password-here', code: '000000' }),
    );
  }
  assert.equal(last.status, 401);
  assert.match(last.body.error, /too many failed attempts/i, `got: ${last.body.error}`);

  // Even the correct credentials are refused while the lockout stands — that is the
  // point of a lockout rather than a hard failure on the attacker's request.
  const correct = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password, code: totpCodeAt(account.secret) }),
  );
  assert.equal(correct.status, 401);
  assert.match(correct.body.error, /too many failed attempts/i);
});

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

test('a recovery code signs in and is then spent', async () => {
  const account = await createAccount();
  const code = account.backupCodes[0];

  const used = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password, backup_code: code }),
  );
  assert.equal(used.status, 200, JSON.stringify(used.body));
  assert.equal(used.body.recovery_codes_remaining, 9, 'the remaining count is reported');

  const again = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password, backup_code: code }),
  );
  assert.equal(again.status, 401, 'a recovery code is single use');
});

test('a wrong recovery code is refused, and the password is still required', async () => {
  const account = await createAccount();

  const wrongCode = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password, backup_code: 'WRONG-WRONG' }),
  );
  assert.equal(wrongCode.status, 401, 'a bad recovery code fails');

  // The recovery code replaces the TOTP factor, not the password.
  const wrongPassword = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: 'nope-not-it', backup_code: account.backupCodes[0] }),
  );
  assert.equal(wrongPassword.status, 401, 'a recovery code must not bypass the password');
});

test('recovery codes can be rotated with a TOTP code, invalidating the old set', async () => {
  const account = await createAccount();
  const rotated = await call(
    base,
    '/auth/recovery-codes/regenerate',
    json({ code: totpCodeAt(account.secret) }, account.token),
  );
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal(rotated.body.recovery_codes.length, 10);

  const oldCode = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password, backup_code: account.backupCodes[0] }),
  );
  assert.equal(oldCode.status, 401, 'the old codes stop working');

  const newCode = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password, backup_code: rotated.body.recovery_codes[0] }),
  );
  assert.equal(newCode.status, 200, 'the new codes work');
});

// ---------------------------------------------------------------------------
// Password change
// ---------------------------------------------------------------------------

test('changing the password re-keys access without touching records', async () => {
  const account = await createAccount();
  await call(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });
  await call(
    base,
    '/api/medications',
    json({ route: 'injection', ester: 'EV', dose_mg: 5, at: new Date().toISOString() }, account.token),
  );

  const newPassword = 'a-different-password-2';
  const changed = await call(
    base,
    '/auth/password',
    json({ current_password: account.password, new_password: newPassword }, account.token),
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  // The old password must stop working.
  const oldLogin = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password, code: totpCodeAt(account.secret) }),
  );
  assert.equal(oldLogin.status, 401, 'the old password is refused');

  // The new one works, and the records written before the change are still readable:
  // the password re-wraps the data key rather than re-encrypting anything.
  const newLogin = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: newPassword, code: totpCodeAt(account.secret) }),
  );
  assert.equal(newLogin.status, 200, JSON.stringify(newLogin.body));
  const meds = await call(base, '/api/medications', auth(newLogin.body.token));
  assert.equal(meds.body.length, 1, 'records survive a password change');
  assert.equal(meds.body[0].dose_mg, 5, 'and decrypt correctly');
});

// ---------------------------------------------------------------------------
// X OAuth — with X's endpoints stubbed
// ---------------------------------------------------------------------------

/**
 * Stub X's token and profile endpoints.
 *
 * Returns a function that restores the real `fetch`. Only the two X hosts are
 * intercepted, so the calls to our own server still go through.
 */
function stubX(opts: {
  userId: string;
  handle: string;
  name?: string;
  tokenOk?: boolean;
}): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url.startsWith('https://api.twitter.com/2/oauth2/token')) {
      if (opts.tokenOk === false) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // The form body must carry the verifier and the same redirect we sent.
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (!body.get('code_verifier')) {
        return new Response(JSON.stringify({ error: 'code_verifier missing' }), { status: 400 });
      }
      if (body.get('redirect_uri') !== X_REDIRECT_URI) {
        return new Response(JSON.stringify({ error: 'redirect mismatch' }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: 'x-access-token', expires_in: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.startsWith('https://api.twitter.com/2/users/me')) {
      return new Response(
        JSON.stringify({ data: { id: opts.userId, username: opts.handle, name: opts.name ?? opts.handle } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return original(input as RequestInfo, init);
  }) as typeof fetch;

  return { restore: () => { globalThis.fetch = original; }, calls };
}

/** Run the full X flow up to and including the callback, returning the redirect. */
async function runXCallback(startQuery = ''): Promise<{ start: any; location: string | null; status: number }> {
  const start = await call(base, `/auth/x/start${startQuery}`);
  const authorize = new URL(start.body.authorize_url);
  const state = authorize.searchParams.get('state');
  assert.ok(state, 'the authorize URL carries a state');

  const res = await fetch(`${base}/auth/x/callback?code=stub-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
  });
  return { start, location: res.headers.get('location'), status: res.status };
}

test('the authorize URL is a correct PKCE authorization request', async () => {
  const started = await call(base, '/auth/x/start');
  assert.equal(started.status, 200, JSON.stringify(started.body));

  const url = new URL(started.body.authorize_url);
  assert.equal(url.origin + url.pathname, 'https://twitter.com/i/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), X_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), X_REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // `tweet.read` looks like scope creep next to a login that only needs an identity,
  // but it is load-bearing: /2/users/me answers 403 without it, so the flow completes
  // at X and only then fails at the profile fetch. The comment service next door hit
  // the same wall and documents it. Pinned here so it is not "tidied away" later.
  assert.equal(url.searchParams.get('scope'), 'users.read tweet.read', 'tweet.read is required or /users/me 403s');
  assert.ok(url.searchParams.get('state'), 'state is present');
  // 43 chars of base64url is a 32-byte verifier — the PKCE requirement.
  assert.ok(url.searchParams.get('code_challenge'), 'the challenge is present');
  assert.ok(!started.body.authorize_url.includes('client_secret'), 'the secret must never reach the browser');
});

test('a first-time X sign-in creates an account that cannot be used until set up', async () => {
  const x = stubX({ userId: `900${Date.now()}`, handle: 'stubuser' });
  try {
    const { location, status } = await runXCallback();
    assert.equal(status, 302, 'the callback redirects rather than returning a body');
    assert.ok(location, 'a redirect location is set');

    const landed = new URL(location!);
    // Must land on the WEB app, not the API host.
    assert.equal(landed.origin, PUBLIC_ORIGIN, 'the browser is sent to the web app');
    assert.ok(landed.pathname.includes('setup'), `expected the setup flow, got ${landed.pathname}`);
    const setupToken = landed.searchParams.get('setup_token');
    assert.ok(setupToken, 'a setup token is handed over');

    // Critically: no session token in the URL. URLs leak into history and referrers.
    assert.equal(landed.searchParams.get('token'), null, 'no session token in a redirect URL');
    assert.equal(landed.searchParams.get('code'), null, 'no one-time code either, at this stage');

    // The account exists but has no password yet, so it is unusable.
    const account = await import('../src/accounts.ts');
    const user = await account.loadUser({ username: 'stubuser' });
    assert.ok(user, 'the account was created');
    assert.equal(user!.password_set_at, null, 'no password set yet');
    assert.equal(user!.wrapped_dek, null, 'and therefore no data key — nothing to lose if X is lost');
  } finally {
    x.restore();
  }
});

test('completing X setup sets a password and enrols TOTP, making the account real', async () => {
  const x = stubX({ userId: `901${Date.now()}`, handle: 'setupper' });
  try {
    const { location } = await runXCallback();
    const landed = new URL(location!);
    const setupToken = landed.searchParams.get('setup_token')!;
    const secret = landed.searchParams.get('secret');
    assert.ok(secret, 'the setup redirect carries the enrolment secret');

    // Set a password and confirm TOTP in one step — this is what makes the account
    // survivable without X.
    const done = await call(
      base,
      '/auth/x/setup',
      json({ setup_token: setupToken, password: 'a-brand-new-password-9', code: totpCodeAt(secret!) }),
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.token, 'setup yields a working session');
    assert.equal(done.body.username, 'setupper');

    // The account is now fully usable with password + TOTP, with no X involvement.
    const login = await call(
      base,
      '/auth/login',
      json({ username: 'setupper', password: 'a-brand-new-password-9', code: totpCodeAt(secret!) }),
    );
    assert.equal(login.status, 200, 'the account works without X');
  } finally {
    x.restore();
  }
});

test('a second X sign-in for a known account returns a one-time code, not a token', async () => {
  const x = stubX({ userId: `902${Date.now()}`, handle: 'returner' });
  try {
    // Advanced mode, because that is the mode in which "X alone cannot unlock the
    // records" is still true — standard mode deliberately returns a session here
    // (see the privacy-mode suite). What this test pins is the URL safety: the
    // callback hands over a one-time code, never a session token.
    const first = await runXCallback();
    const setupToken = new URL(first.location!).searchParams.get('setup_token')!;
    const secret = new URL(first.location!).searchParams.get('secret')!;
    await call(
      base,
      '/auth/x/setup',
      json({
        setup_token: setupToken,
        password: 'a-returning-password-9',
        code: totpCodeAt(secret),
        privacy_mode: 'advanced',
      }),
    );

    // Clear every live unlock for this account, so this second sign-in represents a
    // fresh device. Doing it per-session would not be enough: `completeSetup` opened
    // one and it is still live, so the X sign-in would correctly reuse it — a
    // different behaviour, tested separately below.
    closeUserSessions(await userIdFor('returner'));

    // Second sign-in: the account is known and complete.
    const second = await runXCallback();
    const landed = new URL(second.location!);
    assert.equal(landed.origin, PUBLIC_ORIGIN);
    const oneTimeCode = landed.searchParams.get('code');
    assert.ok(oneTimeCode, 'a one-time code is handed to the web app');
    assert.ok(oneTimeCode!.startsWith('otc_'), `unexpected code shape: ${oneTimeCode}`);
    assert.equal(landed.searchParams.get('token'), null, 'still no session token in a URL');

    // Redeeming it reports the identity but no session: in advanced mode the data key
    // exists only under the user's own credentials. A locked token comes instead, to
    // carry the verified identity to the unlock step.
    const exchanged = await call(base, '/auth/x/exchange', json({ code: oneTimeCode }));
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    assert.equal(exchanged.body.username, 'returner');
    assert.equal(exchanged.body.token, null, 'X alone cannot unlock the records');
    assert.ok(exchanged.body.locked_token, 'a locked token carries the identity forward');
    assert.ok(exchanged.body.locked_token.startsWith('lu_'), 'with the locked-token shape');

    // And the one-time code is spent.
    const reused = await call(base, '/auth/x/exchange', json({ code: oneTimeCode }));
    assert.equal(reused.status, 400, 'a one-time code is single use');
  } finally {
    x.restore();
  }
});

test('X login reuses an existing unlock when the account is already unlocked', async () => {
  const x = stubX({ userId: `903${Date.now()}`, handle: 'already' });
  try {
    const first = await runXCallback();
    const setupToken = new URL(first.location!).searchParams.get('setup_token')!;
    const secret = new URL(first.location!).searchParams.get('secret')!;
    const done = await call(
      base,
      '/auth/x/setup',
      json({ setup_token: setupToken, password: 'an-already-password-9', code: totpCodeAt(secret) }),
    );
    assert.ok(done.body.token, 'setup produced a session');

    // With that session still live, an X sign-in can hand back a token directly —
    // which is what makes X login feel like one click in the common case.
    const second = await runXCallback();
    const oneTimeCode = new URL(second.location!).searchParams.get('code')!;
    const exchanged = await call(base, '/auth/x/exchange', json({ code: oneTimeCode }));
    assert.equal(exchanged.status, 200);
    assert.ok(exchanged.body.token, 'a live unlock is reused');
    const meds = await call(base, '/api/medications', auth(exchanged.body.token));
    assert.equal(meds.status, 200, 'and the session works');
  } finally {
    x.restore();
  }
});

test('an unlinkable state is refused, and an X error is surfaced', async () => {
  // state that was never issued
  const forged = await fetch(`${base}/auth/x/callback?code=abc&state=forged-state`, { redirect: 'manual' });
  assert.equal(forged.status, 302);
  const landed = new URL(forged.headers.get('location')!);
  assert.ok(landed.searchParams.get('error'), 'a forged state is reported as an error');
  assert.equal(landed.origin, PUBLIC_ORIGIN);

  // X reporting a failure (the user declined, or the code was already used)
  const x = stubX({ userId: '999', handle: 'declined', tokenOk: false });
  try {
    const start = await call(base, '/auth/x/start');
    const state = new URL(start.body.authorize_url).searchParams.get('state')!;
    const failed = await fetch(`${base}/auth/x/callback?code=stub&state=${state}`, { redirect: 'manual' });
    const failedLanding = new URL(failed.headers.get('location')!);
    assert.ok(failedLanding.searchParams.get('error'), 'an exchange failure is reported');
  } finally {
    x.restore();
  }
});

test('linking, rebinding and unlinking X on an existing account', async () => {
  const account = await createAccount();
  const userId = `904${Date.now()}`;
  const x = stubX({ userId, handle: 'linked_one' });
  try {
    // Link, authenticated.
    const start = await call(base, '/auth/x/start?purpose=link', auth(account.token));
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const state = new URL(start.body.authorize_url).searchParams.get('state')!;
    const linked = await fetch(`${base}/auth/x/callback?code=stub&state=${state}`, { redirect: 'manual' });
    const linkedLanding = new URL(linked.headers.get('location')!);
    assert.equal(linkedLanding.searchParams.get('linked'), '1');

    const links = await call(base, '/auth/x/links', auth(account.token));
    assert.equal(links.body.links.length, 1, 'the link is recorded');
    assert.equal(links.body.links[0].handle, 'linked_one');

    // The whole field set, and camelCase specifically. Only `handle` was asserted
    // before, so `avatarUrl` / `linkedAt` / `lastLoginAt` went unread by the client —
    // which reads camelCase, matching this — while the rows it actually received were
    // indexed by their snake_case column names. The symptom was an account page with a
    // generic glyph and "Invalid Date", and nothing here failed.
    const link = links.body.links[0];
    for (const field of ['avatarUrl', 'linkedAt', 'lastLoginAt']) {
      assert.ok(field in link, `/auth/x/links must serialise ${field} in camelCase`);
      assert.ok(
        !(`${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}` in link),
        `and must not also send the snake_case column name for ${field}`,
      );
    }
    assert.ok(
      Number.isFinite(Date.parse(link.linkedAt)),
      `linkedAt must be a parseable timestamp, got ${JSON.stringify(link.linkedAt)}`,
    );

    // Unlink requires a second-factor code, so a stolen session cannot detach a
    // compromised X account's audit trail.
    const badUnlink = await call(base, '/auth/x/unlink', json({ code: '000000' }, account.token));
    assert.equal(badUnlink.status, 400, 'a wrong code cannot unlink');

    const goodUnlink = await call(
      base,
      '/auth/x/unlink',
      json({ code: totpCodeAt(account.secret) }, account.token),
    );
    assert.equal(goodUnlink.status, 200, JSON.stringify(goodUnlink.body));
    const after = await call(base, '/auth/x/links', auth(account.token));
    assert.equal(after.body.links.length, 0, 'the link is gone');

    // Crucially, unlinking does not lock the user out: a usable account always has a
    // password, which is the whole point of X being an assist.
    //
    // The next step is used rather than the same code, because unlinking spends its
    // step — replay protection applies to any code that authorises a change, not
    // just to sign-in. That is the intended behaviour, and a real authenticator
    // advances on its own.
    const stillWorks = await call(
      base,
      '/auth/login',
      json({
        username: account.username,
        password: account.password,
        code: totpCodeAt(account.secret, Date.now() + 30_000),
      }),
    );
    assert.equal(stillWorks.status, 200, 'the account is fully usable after unlinking X');
  } finally {
    x.restore();
  }
});

test('an X account already linked elsewhere cannot be linked again', async () => {
  const first = await createAccount();
  const second = await createAccount();
  const sharedXId = `905${Date.now()}`;
  const x = stubX({ userId: sharedXId, handle: 'shared_handle' });
  try {
    const startA = await call(base, '/auth/x/start?purpose=link', auth(first.token));
    const stateA = new URL(startA.body.authorize_url).searchParams.get('state')!;
    await fetch(`${base}/auth/x/callback?code=stub&state=${stateA}`, { redirect: 'manual' });

    const startB = await call(base, '/auth/x/start?purpose=link', auth(second.token));
    const stateB = new URL(startB.body.authorize_url).searchParams.get('state')!;
    const resB = await fetch(`${base}/auth/x/callback?code=stub&state=${stateB}`, { redirect: 'manual' });
    const landingB = new URL(resB.headers.get('location')!);
    assert.match(landingB.searchParams.get('error') ?? '', /already linked/i, 'one X account, one account');

    const linksB = await call(base, '/auth/x/links', auth(second.token));
    assert.equal(linksB.body.links.length, 0, 'the second account gained no link');
  } finally {
    x.restore();
  }
});

test('linking requires authentication', async () => {
  const anon = await call(base, '/auth/x/start?purpose=link');
  assert.equal(anon.status, 401, 'an unauthenticated link request is refused');
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

test('CORS allows exactly the configured web origin and nothing else', async () => {
  const allowed = await fetch(`${base}/health`, { headers: { Origin: PUBLIC_ORIGIN } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), PUBLIC_ORIGIN);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

  for (const hostile of ['https://evil.test', 'https://hrt.test.evil.test', 'http://hrt.test', 'null']) {
    const denied = await fetch(`${base}/health`, { headers: { Origin: hostile } });
    assert.equal(
      denied.headers.get('access-control-allow-origin'),
      null,
      `${hostile} must not be allowed`,
    );
  }

  // A preflight from an unknown origin is refused outright.
  const preflight = await fetch(`${base}/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.status, 403, 'an unknown origin fails the preflight');

  const goodPreflight = await fetch(`${base}/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: PUBLIC_ORIGIN, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(goodPreflight.status, 204);
  assert.ok(goodPreflight.headers.get('access-control-allow-headers')?.includes('Authorization'));
});

test('security headers are present on API responses', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=/);
});

test('the per-IP limiter refuses a burst of sign-in attempts', async () => {
  // A separate window with a tiny budget, so the limiter itself is exercised
  // rather than assumed.
  setConfigForTesting({
    publicOrigin: PUBLIC_ORIGIN,
    apiOrigin: API_ORIGIN,
    basePath: '',
    apiBaseUrl: API_ORIGIN,
    port: 0,
    databaseUrl: '',
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    turnstile: null,
    x: { clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET, redirectUri: X_REDIRECT_URI },
    sessionTtlMinutes: 30,
    rateLimits: { register: 3, login: 3, resume: 3, windowMs: 60_000 },
  });
  resetRateLimits();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await call(base, '/auth/login', json({ username: 'nobody_here', password: 'irrelevant-1' }));
      statuses.push(res.status);
    }
    assert.ok(statuses.slice(0, 3).every((s) => s === 401), `first three should pass through: ${statuses}`);
    assert.ok(statuses.slice(3).every((s) => s === 429), `the rest are limited: ${statuses}`);
    assert.match(statuses.length ? '' : '', /$/); // no-op keeps the shape readable
  } finally {
    resetRateLimits();
    setConfigForTesting({
      publicOrigin: PUBLIC_ORIGIN,
      apiOrigin: API_ORIGIN,
    basePath: '',
    apiBaseUrl: API_ORIGIN,
      port: 0,
      databaseUrl: '',
      totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
      serverDekKey: 'test-server-dek-key-0123456789abcdef',
      turnstile: null,
      x: { clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET, redirectUri: X_REDIRECT_URI },
      sessionTtlMinutes: 30,
      rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
    });
  }
});
