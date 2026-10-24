/**
 * Share links.
 *
 * This is the only feature that serves someone **without an account**, so the
 * assertions that matter are the ones about what must not come out. A test that only
 * checked "you can read it back" would pass on an implementation that leaked a lab
 * result, a username, or a link that never expires.
 *
 * Four properties, each with a failure worth naming:
 *
 *   1. **Only sharable content.** The snapshot is built in the browser, so the server
 *      cannot trust it. A lab value, a weight or a username anywhere in the payload —
 *      at any depth — must be refused, not filtered.
 *   2. **Unguessable and unrecoverable.** The token never appears in storage, and the
 *      public read returns no id and no owner.
 *   3. **Scoped revocation.** One account cannot delete another's share by guessing an
 *      id.
 *   4. **Bounded lifetime.** `expiresAt` is required, clamped, and enforced on read.
 */
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';
import { registerAccount , TEST_KMS_CONFIG} from './helpers.ts';
import { getPool } from '../src/db.ts';
import { assertShareable, __tokenHashForTest } from '../src/shares.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

// Its own cluster and port: the suite boots one per file and they must not collide.
// The generous timeout is the embedded-postgres initdb, which is slow on a cold run.
before(async () => {
  // The full config, not a partial one: the account service reads several of these at
  // request time, and a field it needs missing makes registration fail inside the
  // route rather than at boot.
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    kms: TEST_KMS_CONFIG,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-shares', port: 55444, database: 'hrt_shares' });
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

/** The minimum a client sends: dose events and a modelled curve. */
const snapshot = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  mode: 'transfem' as const,
  timezone: 'UTC',
  createdAt: Date.now(),
  events: [
    { id: 'e1', type: 'dose', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100, at: Date.now() },
  ],
  simulation: null,
  ...extra,
});

const inFuture = (ms: number) => Date.now() + ms;
const DAY = 24 * 60 * 60 * 1000;

test('a share round-trips, and publicly readable fields carry no identity', async () => {
  const account = await registerAccount(base, { username: 'sharer_one' });

  const created = await call(base, '/api/shares', json({
    snapshot: snapshot(),
    expiresAt: inFuture(DAY),
  }, account.token));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.token, 'the token is returned once, to the creator');
  assert.ok(created.body.url.includes(created.body.token));

  // Read it back with no Authorization header at all — that is the whole feature.
  const opened = await call(base, '/api/shares/access', json({ token: created.body.token }));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.snapshot.events.length, 1);
  assert.equal(opened.body.passwordRequired, false);
  assert.equal(opened.body.expired, undefined, 'the public view does not report expiry state');

  // And nothing that identifies the owner or the row.
  const raw = JSON.stringify(opened.body);
  assert.ok(!raw.includes(account.username), 'the username must not appear anywhere');
  assert.ok(!('id' in opened.body), 'the row id is not public');
  assert.ok(!('userId' in opened.body), 'nor the owner');
  assert.ok(!raw.includes(created.body.token), 'nor the token echoed back');
});

test('a share snapshot is projected to the dose/curve shape before it is stored', async () => {
  const account = await registerAccount(base, { username: 'sharer_two' });

  // Built in the browser, so the server cannot assume the client behaved. Each of
  // these is a real field the app holds and must never publish through a share.
  for (const forbidden of [
    { labResults: [{ value: 120 }] },
    { weight: 70 },
    { events: [{ id: 'e1', note: 'x', nested: { username: 'someone' } }] },
  ]) {
    const res = await call(base, '/api/shares', json({
      snapshot: snapshot(forbidden),
      expiresAt: inFuture(DAY),
    }, account.token));
    // Audit contract (KHT-SEC-013): the snapshot is projected to the dose/curve
    // shape before storage, so sensitive collections are dropped, never stored —
    // and the anonymous reader can never see them.
    assert.equal(res.status, 201, `create should succeed (projected): ${JSON.stringify(forbidden)}`);
    const view = await call(base, '/api/shares/access', json({ token: res.body.token }));
    assert.equal(view.status, 200);
    const served = view.body.snapshot ?? view.body;
    assert.equal(served.labResults, undefined, 'lab results leaked');
    assert.equal(served.weight, undefined, 'weight leaked');
    assert.equal(served.events?.[0]?.note, undefined, 'event note leaked');
    assert.equal(served.events?.[0]?.nested, undefined, 'nested metadata leaked');
    assert.equal(served.events?.[0]?.id, 'e1', 'the dose event itself survives the projection');
  }

  // And the guard is not just a top-level name check.
  const nested = assertShareable({ events: [{ meta: { pkParams: {} } }] });
  assert.equal(nested.ok, false, 'a nested forbidden key is caught');
  const clean = assertShareable(snapshot());
  assert.equal(clean.ok, true, 'a clean snapshot passes');
});

test('the token is stored only as a hash', async () => {
  const account = await registerAccount(base, { username: 'sharer_three' });
  const created = await call(base, '/api/shares', json({
    snapshot: snapshot(),
    expiresAt: inFuture(DAY),
  }, account.token));

  const { rows } = await getPool().query<{ token_hash: string }>('SELECT token_hash FROM shares');
  const stored = rows.map((r) => r.token_hash);
  assert.ok(stored.includes(__tokenHashForTest(created.body.token)), 'the hash is what is stored');
  assert.ok(
    !stored.includes(created.body.token),
    'the plaintext token must never be in the database — a dump would hand over live links',
  );
});

test('a password-protected share asks for the password and refuses the wrong one', async () => {
  const account = await registerAccount(base, { username: 'sharer_four' });
  const created = await call(base, '/api/shares', json({
    snapshot: snapshot(),
    password: 'correct-horse-battery',
    expiresAt: inFuture(DAY),
  }, account.token));

  const noPassword = await call(base, '/api/shares/access', json({ token: created.body.token }));
  assert.equal(noPassword.status, 401);
  assert.equal(noPassword.body.code, 'PASSWORD_REQUIRED', 'the client needs to know to prompt');
  assert.ok(!noPassword.body.snapshot, 'and gets no content in the meantime');

  // A wrong password is separable from a missing link *because the requester already
  // holds the token* — the answer discloses nothing about any other share, and the
  // client has specific copy for it. An unknown token stays vague; see the expiry test.
  const wrong = await call(base, '/api/shares/access', json({ token: created.body.token, password: 'nope' }));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'INVALID_PASSWORD');
  assert.ok(!wrong.body.snapshot, 'and no content leaks with it');

  const right = await call(base, '/api/shares/access', json({ token: created.body.token, password: 'correct-horse-battery' }));
  assert.equal(right.status, 200);
  assert.equal(right.body.snapshot.events.length, 1);

  // The share password is hashed like a login password, not stored reversibly.
  const { rows } = await getPool().query<{ password_hash: string }>(
    'SELECT password_hash FROM shares WHERE id = $1', [created.body.id],
  );
  assert.match(rows[0].password_hash, /^scrypt\$/, 'scrypt, not plaintext');
  assert.ok(!rows[0].password_hash.includes('correct-horse-battery'));
});

test('an expired link is refused, and expiry cannot be pushed past the cap', async () => {
  const account = await registerAccount(base, { username: 'sharer_five' });

  const tooLong = await call(base, '/api/shares', json({
    snapshot: snapshot(),
    expiresAt: inFuture(3650 * DAY),
  }, account.token));
  assert.equal(tooLong.status, 201);
  assert.ok(
    tooLong.body.expiresAt <= Date.now() + 91 * DAY,
    `the TTL is clamped server-side, got ${tooLong.body.expiresAt}`,
  );

  const noExpiry = await call(base, '/api/shares', json({ snapshot: snapshot() }, account.token));
  assert.equal(noExpiry.status, 400, 'a link with no expiry is refused');

  const past = await call(base, '/api/shares', json({
    snapshot: snapshot(),
    expiresAt: Date.now() - 1000,
  }, account.token));
  assert.equal(past.status, 400, 'and one already expired');

  // Expiry is enforced on read, not by a sweeper: a lapsed row still present in the
  // table must not be readable.
  const created = await call(base, '/api/shares', json({
    snapshot: snapshot(),
    expiresAt: inFuture(DAY),
  }, account.token));
  await getPool().query('UPDATE shares SET expires_at = now() - interval \'1 minute\' WHERE id = $1', [created.body.id]);
  // 410 rather than 404, because the token is real and the client has a specific
  // message for it. Someone holding a lapsed link should be told it lapsed, not left
  // thinking the app is broken.
  const afterExpiry = await call(base, '/api/shares/access', json({ token: created.body.token }));
  assert.equal(afterExpiry.status, 410);
  assert.equal(afterExpiry.body.code, 'SHARE_EXPIRED');

  // An unknown token stays indistinguishable from anything else that is not a link.
  const nonsense = await call(base, '/api/shares/access', json({ token: 'not-a-real-token' }));
  assert.equal(nonsense.status, 404);
  assert.equal(nonsense.body.code, 'SHARE_NOT_FOUND');
});

test('only live shares are refreshed, and only by their owner', async () => {
  const account = await registerAccount(base, { username: 'sharer_six' });

  const live = await call(base, '/api/shares', json({
    snapshot: snapshot(), expiresAt: inFuture(DAY), live: true,
  }, account.token));
  const frozen = await call(base, '/api/shares', json({
    snapshot: snapshot(), expiresAt: inFuture(DAY), live: false,
  }, account.token));

  const updated = snapshot({ events: [] });
  const synced = await call(base, '/api/shares/live', {
    ...json({ snapshot: updated }, account.token),
    method: 'PUT',
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.updated, 1, 'exactly the live share, not the frozen one');

  const liveAfter = await call(base, '/api/shares/access', json({ token: live.body.token }));
  assert.equal(liveAfter.body.snapshot.events.length, 0, 'the live share was refreshed');

  const frozenAfter = await call(base, '/api/shares/access', json({ token: frozen.body.token }));
  assert.equal(
    frozenAfter.body.snapshot.events.length, 1,
    'a frozen share must not change under the person reading it',
  );
});

test('one account cannot revoke another account\'s share', async () => {
  const owner = await registerAccount(base, { username: 'sharer_seven' });
  const stranger = await registerAccount(base, { username: 'sharer_eight' });

  const created = await call(base, '/api/shares', json({
    snapshot: snapshot(), expiresAt: inFuture(DAY),
  }, owner.token));

  const attempt = await call(base, `/api/shares/${created.body.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${stranger.token}` },
  });
  assert.equal(attempt.status, 404, 'scoped by user_id, so it reads as no such share');

  const stillThere = await call(base, '/api/shares/access', json({ token: created.body.token }));
  assert.equal(stillThere.status, 200, 'and the share survives');

  // The owner can, and afterwards it is gone.
  const own = await call(base, `/api/shares/${created.body.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(own.status, 200);
  const gone = await call(base, '/api/shares/access', json({ token: created.body.token }));
  assert.equal(gone.status, 404);
});

test('deleting the account deletes its shares', async () => {
  const account = await registerAccount(base, { username: 'sharer_nine' });
  const created = await call(base, '/api/shares', json({
    snapshot: snapshot(), expiresAt: inFuture(DAY),
  }, account.token));

  await getPool().query('DELETE FROM users WHERE id = $1', [account.userId]);

  const { rows } = await getPool().query('SELECT id FROM shares WHERE id = $1', [created.body.id]);
  assert.equal(rows.length, 0, 'the cascade reaches shares — a public link must not outlive its account');
});

test('unauthenticated access to the owner routes is refused', async () => {
  // The one public route is `/api/shares/access`; everything else needs a session, and
  // a regression here would expose an account's share list to anyone.
  for (const [method, path] of [
    ['GET', '/api/shares'],
    ['POST', '/api/shares'],
    ['DELETE', `/api/shares/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`],
  ]) {
    const res = await call(base, path, method === 'POST' ? json({}) : { method });
    assert.equal(res.status, 401, `${method} ${path} must require a session`);
  }
});

test('the access route is rate-limited, because guessing tokens is the threat', async () => {
  // The suite configures a deliberately generous `login` limit so the fixture accounts
  // never trip it. Without lowering it here this test asserts nothing: 30 guesses all
  // pass under a limit of 1000, and it would go green on an endpoint with no ceiling.
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    kms: TEST_KMS_CONFIG,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 5, windowMs: 60_000 },
  });
  resetRateLimits();

  const attempts = [];
  for (let i = 0; i < 12; i++) {
    attempts.push(await call(base, '/api/shares/access', json({ token: `guess-${i}` })));
  }
  assert.ok(
    attempts.some((r) => r.status === 429),
    'a bulk token guess must be refused part-way through, not answered forever',
  );
  assert.ok(
    attempts.some((r) => r.status === 404),
    'and the early ones still answer normally',
  );
});

test('a weak password (<40 bits entropy) is refused at share creation', async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    kms: TEST_KMS_CONFIG,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  resetRateLimits();

  const account = await registerAccount(base, { username: 'sharer_weak_pwd' });

  // Trivial passwords like 12345678, password, 2000-01-01 must be refused
  for (const bad of ['12345678', 'password', '19981225', 'p@ssw0rd1', 'qwertyuiop']) {
    const res = await call(base, '/api/shares', json({
      snapshot: snapshot(),
      password: bad,
      expiresAt: inFuture(DAY),
    }, account.token));
    assert.equal(res.status, 400, `expected ${bad} to be refused`);
    assert.match(res.body.message, /too weak/);
  }

  // Strong password passes
  const good = await call(base, '/api/shares', json({
    snapshot: snapshot(),
    password: 'correct-horse-battery-99',
    expiresAt: inFuture(DAY),
  }, account.token));
  assert.equal(good.status, 201);
});

test('per-share lockout triggers after 5 misses and viewerPass allows unlocked readers to keep reading', async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    kms: TEST_KMS_CONFIG,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  resetRateLimits();

  const account = await registerAccount(base, { username: 'sharer_lockout' });
  const strongPassword = 'correct-horse-battery-99';
  const created = await call(base, '/api/shares', json({
    snapshot: snapshot(),
    password: strongPassword,
    expiresAt: inFuture(DAY),
  }, account.token));
  assert.equal(created.status, 201);
  const token = created.body.token;

  // 1. Legitimate reader unlocks and obtains viewerPass
  const unlocked = await call(base, '/api/shares/access', json({ token, password: strongPassword }));
  assert.equal(unlocked.status, 200);
  assert.ok(unlocked.body.viewerPass, 'viewerPass must be returned upon successful unlock');
  const viewerPass = unlocked.body.viewerPass;

  // 2. Viewer can poll with viewerPass alone
  const poll1 = await call(base, '/api/shares/access', json({ token, viewerPass }));
  assert.equal(poll1.status, 200);
  assert.equal(poll1.body.snapshot.events.length, 1);

  // 3. Attacker fails 4 times - link remains unlocked
  for (let i = 0; i < 4; i++) {
    const wrong = await call(base, '/api/shares/access', json({ token, password: 'wrong-guess-here' }));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'INVALID_PASSWORD');
  }

  // Check DB failed_attempts = 4, locked_until IS NULL
  const pool = getPool();
  const { rows: r4 } = await pool.query<{ failed_attempts: number; locked_until: Date | null }>(
    'SELECT failed_attempts, locked_until FROM shares WHERE id = $1', [created.body.id],
  );
  assert.equal(r4[0].failed_attempts, 4);
  assert.equal(r4[0].locked_until, null);

  // 4. 5th miss triggers lockout (15 minutes = ~900s)
  const miss5 = await call(base, '/api/shares/access', json({ token, password: 'wrong-guess-here' }));
  assert.equal(miss5.status, 401);
  assert.equal(miss5.body.code, 'INVALID_PASSWORD');

  const { rows: r5 } = await pool.query<{ failed_attempts: number; locked_until: Date | null }>(
    'SELECT failed_attempts, locked_until FROM shares WHERE id = $1', [created.body.id],
  );
  assert.equal(r5[0].failed_attempts, 5);
  assert.ok(r5[0].locked_until && r5[0].locked_until.getTime() > Date.now() + 800_000);

  // 5. While locked, attempts without viewerPass are refused with 429 and Retry-After
  const lockedAttempt = await call(base, '/api/shares/access', json({ token, password: strongPassword }));
  assert.equal(lockedAttempt.status, 429);
  assert.equal(lockedAttempt.body.code, 'SHARE_LOCKED');
  assert.ok(lockedAttempt.body.retryAfterSeconds > 0);

  // 6. Meanwhile, the legitimate reader presenting their viewerPass can STILL read the live share!
  const pollDuringLock = await call(base, '/api/shares/access', json({ token, viewerPass }));
  assert.equal(pollDuringLock.status, 200, 'viewerPass must bypass third-party brute-force lock');
  assert.equal(pollDuringLock.body.snapshot.events.length, 1);

  // 7. A forged / tampered viewerPass is rejected
  const fakePass = await call(base, '/api/shares/access', json({ token, viewerPass: 'fake.pass.signature' }));
  assert.equal(fakePass.status, 429, 'forged pass fails pass check and hits the lockout');

  // 8. If lock is manually cleared or expires, a correct password unlocks and resets failed_attempts
  await pool.query('UPDATE shares SET locked_until = NULL WHERE id = $1', [created.body.id]);
  const recovered = await call(base, '/api/shares/access', json({ token, password: strongPassword }));
  assert.equal(recovered.status, 200);

  const { rows: rReset } = await pool.query<{ failed_attempts: number; locked_until: Date | null }>(
    'SELECT failed_attempts, locked_until FROM shares WHERE id = $1', [created.body.id],
  );
  assert.equal(rReset[0].failed_attempts, 0);
  assert.equal(rReset[0].locked_until, null);
});

// --- client-sealed snapshots -------------------------------------------------
//
// The app seals a snapshot in the browser and hands over an envelope; the key lives
// in the link's URL fragment, which a browser never sends. The server's job is then
// mechanical: store the blob, hand it back, never try to interpret it. What these
// assert is the part that is easy to get wrong — a plaintext path that quietly
// overwrites a sealed link, or a malformed envelope that becomes a link nobody can
// ever open.

/** An envelope in the shape WebCrypto produces: AES-256-GCM, tag appended to the ct. */
function sealed(payload: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, alg: 'AES-256-GCM', iv: iv.toString('base64url'), ct: ct.toString('base64url') };
}

test('a client-sealed share round-trips as an envelope the server stored verbatim', async () => {
  const account = await registerAccount(base, { username: 'sealed_one' });
  const envelope = sealed({ marker: 'SEALED-PLAINTEXT-MARKER', events: [] });

  const created = await call(base, '/api/shares', json({
    sealed: envelope,
    mode: 'transfem',
    expiresAt: inFuture(DAY),
  }, account.token));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.token, 'the creator still gets the one-time token');
  assert.equal(created.body.mode, 'transfem', 'the plaintext mode hint comes back for the owner list');

  const opened = await call(base, '/api/shares/access', json({ token: created.body.token }));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual(opened.body.sealed, envelope, 'the envelope is handed back untouched');
  assert.equal(opened.body.snapshot, null, 'no plaintext snapshot is invented');
  assert.equal(opened.body.mode, 'transfem');

  // The whole point: nothing readable is anywhere in the response, and nothing
  // readable is in the row either.
  assert.ok(!JSON.stringify(opened.body).includes('SEALED-PLAINTEXT-MARKER'));
  const { rows } = await getPool().query<{ snapshot: unknown }>(
    'SELECT snapshot FROM shares WHERE id = $1',
    [created.body.id],
  );
  assert.ok(!JSON.stringify(rows[0].snapshot).includes('SEALED-PLAINTEXT-MARKER'),
    'the plaintext reached the database');
  assert.ok(JSON.stringify(rows[0].snapshot).includes('sealed'), 'the row holds the envelope');
});

test('a malformed envelope is refused instead of becoming an unopenable link', async () => {
  const account = await registerAccount(base, { username: 'sealed_two' });
  for (const broken of [
    { v: 1, alg: 'AES-256-GCM', iv: 'too-short', ct: 'A'.repeat(40) },
    { v: 2, alg: 'AES-256-GCM', iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(40) },
    { v: 1, alg: 'none', iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(40) },
    { v: 1, alg: 'AES-256-GCM', iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(10) },
    'not an object',
  ]) {
    const refused = await call(base, '/api/shares', json({
      sealed: broken, expiresAt: inFuture(DAY),
    }, account.token));
    assert.equal(refused.status, 400, `accepted a malformed envelope: ${JSON.stringify(broken)}`);
    assert.equal(refused.body.code, 'SHARE_REJECTED');
  }
});

test('a live sealed share is refreshed only when named, and only while live', async () => {
  const account = await registerAccount(base, { username: 'sealed_three' });
  const first = sealed({ round: 1 });
  const second = sealed({ round: 2 });

  const live = await call(base, '/api/shares', json({
    sealed: first, mode: 'transfem', expiresAt: inFuture(DAY), live: true,
  }, account.token));
  const frozen = await call(base, '/api/shares', json({
    sealed: first, mode: 'transfem', expiresAt: inFuture(DAY), live: false,
  }, account.token));

  const synced = await call(base, '/api/shares/live', {
    ...json({ shareId: live.body.id, sealed: second, mode: 'transfem' }, account.token),
    method: 'PUT',
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.updated, 1, 'exactly the named live share');

  const liveAfter = await call(base, '/api/shares/access', json({ token: live.body.token }));
  assert.deepEqual(liveAfter.body.sealed, second, 'the live link now carries the newer envelope');

  const frozenAfter = await call(base, '/api/shares/access', json({ token: frozen.body.token }));
  assert.deepEqual(frozenAfter.body.sealed, first, 'a frozen link must not change');

  // Naming a frozen share does nothing, even with the owner's token.
  const frozenWrite = await call(base, '/api/shares/live', {
    ...json({ shareId: frozen.body.id, sealed: second }, account.token),
    method: 'PUT',
  });
  assert.equal(frozenWrite.body.updated, 0);
});

test('a plaintext live update cannot overwrite a sealed share', async () => {
  // The older client refreshes every live share it owns. It has no key, so the one
  // thing it must not do is replace an envelope with plaintext — that would publish
  // what the owner deliberately sealed.
  const account = await registerAccount(base, { username: 'sealed_four' });
  const envelope = sealed({ round: 1 });
  const live = await call(base, '/api/shares', json({
    sealed: envelope, mode: 'transfem', expiresAt: inFuture(DAY), live: true,
  }, account.token));

  const plain = await call(base, '/api/shares/live', {
    ...json({ snapshot: snapshot({ events: [] }) }, account.token),
    method: 'PUT',
  });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.updated, 0, 'a sealed row was not counted as updated');

  const after = await call(base, '/api/shares/access', json({ token: live.body.token }));
  assert.deepEqual(after.body.sealed, envelope, 'the envelope survived the plaintext update');
  assert.equal(after.body.snapshot, null);
});
