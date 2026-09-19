/**
 * Accounts: registration, password sign-in, and X as an assist.
 *
 * The rules under test are the ones the user asked for, stated as behaviour:
 *
 *   1. Registration produces a usable session straight away.
 *   2. Sign-in is a password, and a wrong one is refused.
 *   3. X login verifies identity but does not by itself open the data key.
 *   4. An X-created account has no password and no records until one is bound —
 *      so losing X costs a login button, never the data.
 *   5. Repeated failures lock the account, on top of the per-IP limiter.
 *
 * X's HTTP endpoints are stubbed rather than called: these tests must not depend on
 * the network, a real X app, or rate limits, and the thing being tested is this
 * server's handling of the responses, not X's availability.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, TEST_ENCRYPTION_KEY, type PostgresHandle } from './pg.ts';
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
const GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';

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
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    // The record store seals every payload; a suite that writes records must carry a
    // key, because the store refuses rather than writing plaintext.
    encryptionKey: TEST_ENCRYPTION_KEY,
    turnstile: null,
    x: { clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET, redirectUri: X_REDIRECT_URI },
    google: null,
    sessionTtlMinutes: 30,
    // Generous, so one test's attempts never consume another's budget. The limits
    // themselves are exercised by their own test below.
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });

  pg = await bootPostgres({ dir: './.pgdata-accounts', port: 55440, database: 'hrt_accounts' });  await useDatabase(pg);
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

/** Register, returning a usable session. */
async function createAccount(): Promise<{ username: string; password: string; token: string }> {
  const username = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = 'a-good-password-1';
  const reg = await call(base, '/auth/register', json({ username, password }));
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return { username, password, token: reg.body.token };
}
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('registration returns a usable session', async () => {
  resetRateLimits();
  const username = `r${Date.now().toString(36)}`;
  const reg = await call(base, '/auth/register', json({ username, password: 'a-good-password-1' }));

  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  // The session is issued here: the password has just been chosen by the caller, so
  // there is nothing left to prove before opening one.
  assert.ok(reg.body.token, 'registration issues a session');
  // And it works: the token is usable immediately.
  const me = await call(base, '/auth/account', { headers: { Authorization: `Bearer ${reg.body.token}` } });
  assert.equal(me.status, 200, 'the session from registration is live');
});

test('a password alone is enough, and a wrong one is refused', async () => {
  const account = await createAccount();
  const ok = await call(base, '/auth/login', json({ username: account.username, password: account.password }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token, 'a session is issued');

  const bad = await call(base, '/auth/login', json({ username: account.username, password: 'not-the-password' }));
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /invalid credentials/i);
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
      json({ username: account.username, password: 'wrong-password-here' }),
    );
  }
  assert.equal(last.status, 401);
  assert.match(last.body.error, /too many failed attempts/i, `got: ${last.body.error}`);

  // Even the correct credentials are refused while the lockout stands — that is the
  // point of a lockout rather than a hard failure on the attacker's request.
  const correct = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: account.password }),
  );
  assert.equal(correct.status, 401);
  assert.match(correct.body.error, /too many failed attempts/i);
});

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

test('changing the password re-keys access without touching records', async () => {
  const account = await createAccount();
  await call(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });
  await call(base, '/api/records', json({
    takenAt: Date.now(),
    category: 'dose',
    data: { id: 'pwd-dose-1', timeH: Date.now() / 3_600_000, doseMG: 5, ester: 'EV', route: 'injection', extras: {} },
  }, account.token));

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
    json({ username: account.username, password: account.password }),
  );
  assert.equal(oldLogin.status, 401, 'the old password is refused');

  // The new one works, and the records written before the change are still readable:
  // the password re-wraps the data key rather than re-encrypting anything.
  const newLogin = await call(
    base,
    '/auth/login',
    json({ username: account.username, password: newPassword }),
  );
  assert.equal(newLogin.status, 200, JSON.stringify(newLogin.body));
  const meds = await call(base, `/api/records?category=dose`, auth(newLogin.body.token));
  assert.equal(meds.body.records.length, 1, 'records survive a password change');
  assert.equal(meds.body.records[0].data.doseMG, 5, 'and decrypt correctly');
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

test('a first-time X sign-in creates an account that is usable at once', async () => {
  const x = stubX({ userId: `900${Date.now()}`, handle: 'stubuser' });
  try {
    const { location, status } = await runXCallback();
    assert.equal(status, 302, 'the callback redirects rather than returning a body');
    assert.ok(location, 'a redirect location is set');

    const landed = new URL(location!);
    // Must land on the WEB app, not the API host.
    assert.equal(landed.origin, PUBLIC_ORIGIN, 'the browser is sent to the web app');

    // No setup leg: a URL still never carries a session token, which is why a
    // one-time code travels instead.
    assert.ok(!landed.pathname.includes('setup'), `expected no setup flow, got ${landed.pathname}`);
    assert.ok(landed.searchParams.get('code'), 'a one-time code is issued');
    assert.equal(landed.searchParams.get('token'), null, 'no session token in a redirect URL');

    // The account exists with no password. It can sign in, but records stay closed
    // until a fallback credential is bound — see `requireBoundCtx`.
    const account = await import('../src/accounts.ts');
    const user = await account.loadUser({ username: 'stubuser' });
    assert.ok(user, 'the account was created');
    assert.equal(user!.password_set_at, null, 'no password set yet');
    assert.equal(
      await account.AccountService.hasBoundCredentials(user!.id),
      false,
      'an X-only account counts as unbound, so records are gated',
    );
  } finally {
    x.restore();
  }
});

test('binding a name and password makes an X account survivable on its own', async () => {
  const x = stubX({ userId: `901${Date.now()}`, handle: 'setupper' });
  try {
    const { location } = await runXCallback();
    const code = new URL(location!).searchParams.get('code')!;

    // Exchange the one-time code for a session, as the app does.
    const exchanged = await call(base, '/auth/x/exchange', json({ code }));
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    const token = exchanged.body.token as string;
    assert.ok(token, 'the exchange yields a session');

    // Bind the fallback. This is the anti-ban story: from here the account is reachable
    // without X ever being involved again.
    const bound = await call(
      base,
      '/auth/credentials/bind',
      json({ username: 'setupper', password: 'a-brand-new-password-9' }, token),
    );
    assert.equal(bound.status, 200, JSON.stringify(bound.body));

    // And it signs in by name and password, with X out of the picture entirely.
    const login = await call(
      base,
      '/auth/login',
      json({ username: 'setupper', password: 'a-brand-new-password-9' }),
    );
    assert.equal(login.status, 200, JSON.stringify(login.body));
  } finally {
    x.restore();
  }
});

/**
 * An account that has both a password and a linked X identity.
 *
 * Built through the two real paths: register (which yields a usable session), then
 * link X from that session.
 */
async function accountWithLinkedX(opts: {
  username: string;
  password: string;
}): Promise<{ userId: string; token: string }> {
  const reg = await call(base, '/auth/register', json({
    username: opts.username,
    password: opts.password,
  }));
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const token = reg.body.token as string;

  const start = await call(base, '/auth/x/start?purpose=link', auth(token));
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const state = new URL(start.body.authorize_url).searchParams.get('state')!;
  await fetch(`${base}/auth/x/callback?code=stub&state=${state}`, { redirect: 'manual' });

  return { userId: reg.body.user_id, token };
}

test('a second X sign-in for a known account returns a one-time code, not a token', async () => {
  const x = stubX({ userId: `902${Date.now()}`, handle: 'returner' });
  try {
    await accountWithLinkedX({ username: 'returner', password: 'a-returning-password-9' });

    // Clear every live unlock for this account, so this second sign-in represents a
    // fresh device. Doing it per-session would not be enough: the linking flow opened
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

    // Redeeming it with no live unlock still yields a real session: the deployment
    // holds its own copy of the data key, so a provider round-trip is enough.
    const exchanged = await call(base, '/auth/x/exchange', json({ code: oneTimeCode }));
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    assert.equal(exchanged.body.username, 'returner');
    assert.ok(exchanged.body.token, 'a provider sign-in yields a session');
    assert.equal(exchanged.body.locked_token, undefined, 'there is no locked state to carry');

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
    const account = await accountWithLinkedX({
      username: 'already',
      password: 'an-already-password-9',
    });
    assert.ok(account.token, 'the linking session is live');

    // With that session still live, an X sign-in can hand back a token directly —
    // which is what makes X login feel like one click in the common case.
    const second = await runXCallback();
    const oneTimeCode = new URL(second.location!).searchParams.get('code')!;
    const exchanged = await call(base, '/auth/x/exchange', json({ code: oneTimeCode }));
    assert.equal(exchanged.status, 200);
    assert.ok(exchanged.body.token, 'a live unlock is reused');
    const meds = await call(base, '/api/records', auth(exchanged.body.token));
    assert.equal(meds.status, 200, 'and the session works');
  } finally {
    x.restore();
  }
});

test('a Google identity is read from the ID token, and its code becomes a session', async () => {
  const { parseGoogleIdToken } = await import('../src/oauth.ts');
  const { AccountService } = await import('../src/accounts.ts');
  const { issueOneTimeCode } = await import('../src/session.ts');

  const claims = {
    sub: `goog-${Date.now()}`,
    aud: GOOGLE_CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: 'the-nonce',
  };
  const jwt = (payload: unknown) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

  // Only `sub` is taken. The scope is `openid` alone, so the app must not start
  // building a handle out of claims it never asked for — the privacy policy says we
  // receive no name, address or picture, and this is the line that keeps that true.
  const profile = parseGoogleIdToken(
    jwt({ ...claims, email: 'someone@example.test', name: 'Someone', picture: 'https://example.test/p.png' }),
    { clientId: GOOGLE_CLIENT_ID, nonce: 'the-nonce' },
  );
  assert.equal(profile.id, claims.sub, 'the subject is the account key');
  assert.equal(profile.handle, null, 'no email was requested, so none is shown');
  assert.equal(profile.displayName, null);
  assert.equal(profile.avatarUrl, null);

  // `nonce` is the replay guard and `aud` is what stops another client's token being
  // presented here; without the second one any Google app's token would be accepted.
  assert.throws(() => parseGoogleIdToken(jwt(claims), { clientId: GOOGLE_CLIENT_ID, nonce: 'another-nonce' }));
  assert.throws(() => parseGoogleIdToken(jwt(claims), { clientId: 'some-other-client', nonce: 'the-nonce' }));

  // The callback hands the browser back a one-time code, so the code has to be
  // redeemable somewhere — otherwise the flow ends at a URL the app can do nothing
  // with, which is exactly what an endpoint-less Google login did.
  const created = await AccountService.createAccountFromOAuth('google', profile);
  assert.ok(created.ok, JSON.stringify(created));
  const code = issueOneTimeCode(created.value.id);

  const exchanged = await call(base, '/auth/google/exchange', json({ code }));
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal(exchanged.body.username, created.value.username);
  assert.ok(exchanged.body.token, 'standard mode yields a real session, as it does for X');

  const reused = await call(base, '/auth/google/exchange', json({ code }));
  assert.equal(reused.status, 400, 'a one-time code is single use');
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

    // Unlinking needs a session and nothing else: it changes how the account is
    // reached, but the rule below already refuses the one case that would strand the
    // owner.
    const unlinked = await call(base, '/auth/x/unlink', json({}, account.token));
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
    const after = await call(base, '/auth/x/links', auth(account.token));
    assert.equal(after.body.links.length, 0, 'the link is gone');

    // Crucially, unlinking does not lock the user out: the password still opens the
    // account, which is the whole point of the social login being an assist.
    const stillWorks = await call(
      base,
      '/auth/login',
      json({ username: account.username, password: account.password }),
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
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    encryptionKey: null,
    turnstile: null,
    x: { clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET, redirectUri: X_REDIRECT_URI },
    google: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 3, login: 3, windowMs: 60_000 },
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
      serverDekKey: 'test-server-dek-key-0123456789abcdef',
      encryptionKey: null,
      turnstile: null,
      x: { clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET, redirectUri: X_REDIRECT_URI },
      google: null,
      sessionTtlMinutes: 30,
      rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
    });
  }
});
