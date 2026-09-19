/**
 * Live sessions over HTTP: listing devices and ending access.
 *
 * `session.test.ts` covers the registry itself. What is *ours* here is the wiring
 * above it, and the two things that wiring can get wrong without any visible
 * symptom:
 *
 *   1. **The list must not be a way back in.** It exists so a person can end
 *      access to a device they do not recognise, so the row names a device and
 *      carries nothing that could resume the unlock it describes. That is asserted
 *      on the serialised body rather than by reading the handler.
 *   2. **A row is a device, not an unlock.** Two unlocks from the same browser are
 *      one row standing for both, and revoking that row has to end both — the
 *      request carries every id behind it for exactly that reason.
 *
 * Scoping is the other half: an id is a handle, not an authorization, so one
 * account's ids must do nothing in another account's hands.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';
import { registerAccount, signIn, authHeader } from './helpers.ts';

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
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    encryptionKey: null,
    google: null,
    turnstile: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-sessions', port: 55449, database: 'hrt_sessions' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

/**
 * A request from a named device.
 *
 * The device is written on the first authenticated request through a token, and
 * the list groups by it — so a test that wants two unlocks to look like one device
 * has to name the device on both of them, in the order it wants them counted.
 */
const asDevice = (userAgent: string, token: string): RequestInit => ({
  headers: { ...authHeader(token), 'user-agent': userAgent },
});

const listSessions = (token: string, userAgent?: string) =>
  call(base, '/auth/sessions', userAgent ? asDevice(userAgent, token) : { headers: authHeader(token) });

test('the list names the caller and carries no credential', async () => {
  resetRateLimits();
  const account = await registerAccount(base);
  const listed = await listSessions(account.token, 'FirstDevice/1.0');

  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const rows = listed.body.sessions;
  assert.equal(rows.length, 1, 'one unlock, one row');
  assert.equal(rows[0].current, true, 'the caller can tell which row is itself');
  assert.equal(rows[0].sessions, 1);

  // The row names a device so access can be *ended*; it must never be a way to resume
  // the session it describes.
  const serialised = JSON.stringify(listed.body, null, 2);
  assert.ok(!serialised.includes(account.token), 'the token is not in the list');
});

test('the same device signing in twice is one row standing for both', async () => {
  resetRateLimits();
  const account = await registerAccount(base);
  // Name the device on the unlock that registration left live, so both unlocks
  // carry it and the grouping has something to group.
  await listSessions(account.token, 'SameDevice/1.0');

  const again = await signIn(base, account);
  assert.equal(again.status, 200, JSON.stringify(again.body));

  const listed = await listSessions(again.body.token, 'SameDevice/1.0');
  const rows = listed.body.sessions;
  assert.equal(rows.length, 1, 'one device, one row');
  assert.equal(rows[0].sessions, 2, 'and the row says how many unlocks it stands for');
  assert.equal(rows[0].ids.length, 2, 'revoking the row can revoke both');
  assert.equal(new Set(rows[0].ids).size, 2, 'with no id listed twice');
  assert.equal(rows[0].current, true);
});

test('signing out everywhere else ends the other devices and only those', async () => {
  resetRateLimits();
  const account = await registerAccount(base);
  // A second unlock, distinguished by the user agent of its first request.
  const other = await signIn(base, account);
  assert.equal(other.status, 200, JSON.stringify(other.body));
  await listSessions(other.body.token, 'OtherDevice/1.0');

  const before = await listSessions(account.token, 'FirstDevice/1.0');
  assert.equal(before.body.sessions.length, 2, 'two devices are listed to begin with');

  const revoked = await call(base, '/auth/sessions/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(account.token) },
    body: JSON.stringify({ all_others: true }),
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.revoked, 1, 'exactly the other device');

  const after = await listSessions(account.token, 'FirstDevice/1.0');
  assert.equal(after.body.sessions.length, 1);
  assert.equal(after.body.sessions[0].current, true);

  // And the revoked unlock really is gone, not merely hidden from the list.
  const used = await call(base, '/auth/account', { headers: authHeader(other.body.token) });
  assert.equal(used.status, 401, 'the revoked session no longer authenticates');
});

test('one account cannot revoke another account session', async () => {
  resetRateLimits();
  const owner = await registerAccount(base);
  const stranger = await registerAccount(base);
  const victim = await listSessions(stranger.token, 'Victim/1.0');
  const victimId = victim.body.sessions[0].id;

  const attempt = await call(base, '/auth/sessions/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(owner.token) },
    body: JSON.stringify({ ids: [victimId] }),
  });
  assert.equal(attempt.status, 200, JSON.stringify(attempt.body));
  assert.equal(attempt.body.revoked, 0, 'an id is not an authorization');

  const still = await listSessions(stranger.token, 'Victim/1.0');
  assert.equal(still.body.sessions.length, 1, 'the stranger is still signed in');
});

test('revoking by id ends that device, and a request naming nothing is refused', async () => {
  resetRateLimits();
  const account = await registerAccount(base);
  const other = await signIn(base, account);
  await listSessions(other.body.token, 'DropMe/1.0');
  const rows = (await listSessions(account.token, 'KeepMe/1.0')).body.sessions;
  const doomed = rows.find((r: { current: boolean }) => !r.current);
  assert.ok(doomed, 'the other device is listed');

  const revoked = await call(base, '/auth/sessions/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(account.token) },
    body: JSON.stringify({ ids: doomed.ids }),
  });
  assert.equal(revoked.body.revoked, doomed.ids.length, 'every unlock behind the row');

  const after = (await listSessions(account.token, 'KeepMe/1.0')).body.sessions;
  assert.equal(after.length, 1, 'only the caller is left');

  const empty = await call(base, '/auth/sessions/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(account.token) },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400, 'a revoke with nothing named is refused');
});
