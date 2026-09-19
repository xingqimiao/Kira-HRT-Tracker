/**
 * Key-handling tests. This is the privacy boundary, so the properties asserted
 * here are the ones the README's claim actually rests on.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import {
  createUserKeyMaterial,
  unwrapDek,
  rewrapForNewPassword,
  openSession,
  lookupSession,
  hasUserSession,
  resolveSession,
  closeSession,
  closeUserSessions,
  activeSessionCount,
  touchSession,
  listUserSessions,
  revokeSessions,
  revokeOtherSessions,
} from '../src/session.ts';
import { encryptCloudPayload, decryptCloudPayload } from '../src/engine.ts';
import { bootPostgres, useDatabase, teardown, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { getPool } from '../src/db.ts';

const userId = 'user-8f2c';
const password = 'correct horse battery staple';

test('the stored wrapped key reveals nothing about the DEK', async () => {
  const { wrappedDek, dek } = await createUserKeyMaterial(password, userId);
  const serialised = JSON.stringify(wrappedDek);
  assert.ok(!serialised.includes(dek), 'DEK must not appear in the stored material');
  assert.equal(Object.keys(wrappedDek).sort().join(','), 'cloud,data,iv');
});

test('the right password recovers the same DEK; a wrong one recovers nothing', async () => {
  const { wrappedDek, dek } = await createUserKeyMaterial(password, userId);
  assert.equal(await unwrapDek(wrappedDek, password, userId), dek);
  assert.equal(await unwrapDek(wrappedDek, 'wrong password', userId), null);
});

test('a DEK is scoped to its user id', async () => {
  const { wrappedDek } = await createUserKeyMaterial(password, userId);
  // Same password, different account: the derived KEK differs, so this must fail.
  assert.equal(await unwrapDek(wrappedDek, password, 'someone-else'), null);
});

test('password change re-wraps the same DEK, leaving records readable', async () => {
  const { wrappedDek, dek } = await createUserKeyMaterial(password, userId);
  const record = await encryptCloudPayload(JSON.stringify({ doseMG: 5 }), dek);

  const newPassword = 'a completely different passphrase';
  const rotated = await rewrapForNewPassword(dek, newPassword, userId);

  assert.equal(await unwrapDek(rotated, newPassword, userId), dek, 'new password must open it');
  assert.equal(await unwrapDek(rotated, password, userId), null, 'old password must stop working');
  assert.equal(await unwrapDek(wrappedDek, password, userId), dek, 'records were never re-encrypted');

  // The original ciphertext is still readable with the (unchanged) DEK.
  assert.equal(await decryptCloudPayload(record, dek), JSON.stringify({ doseMG: 5 }));
});

test('a wrong password cannot rotate the key', async () => {
  const { wrappedDek } = await createUserKeyMaterial(password, userId);
  assert.equal(await unwrapDek(wrappedDek, 'nope', userId), null, 'no DEK, so nothing to re-wrap');
});

/**
 * The session store.
 *
 * Sessions are rows now, not Map entries, so this part of the suite boots the same
 * database the server uses — the durability is the feature, and an in-memory fake would
 * not exercise it. The properties that matter are unchanged: a session is scoped to its
 * user, revocation is immediate and scoped, and the store never hands back a key.
 *
 * Each test uses its own token and cleans up, because the table is shared with every
 * other test in the run.
 */
let pg: PostgresHandle;
let alice = '';
let bob = '';

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
  pg = await bootPostgres({ dir: './.pgdata-sessionstore', port: 55470, database: 'hrt_sessionstore' });
  await useDatabase(pg);
  const { rows } = await getPool().query<{ id: string; username: string }>(
    `INSERT INTO users (id, username, password_hash)
     VALUES (gen_random_uuid(), 'session-alice', 'x'),
            (gen_random_uuid(), 'session-bob', 'x')
     RETURNING id, username`,
  );
  alice = rows.find((row) => row.username === 'session-alice')!.id;
  bob = rows.find((row) => row.username === 'session-bob')!.id;
}, { timeout: 180_000 });

after(async () => {
  await teardown(undefined, pg);
});

test('a session resolves to its user, and to nothing else', async () => {
  const token = await openSession(alice);
  const session = await lookupSession(token);
  assert.ok(session, 'the fresh session resolves');
  assert.equal(session.userId, alice);
  assert.equal(session.persistent, false, 'a plain login keeps the idle window');
  assert.ok(session.expiresAt, 'and it has one');
  assert.deepEqual(await resolveSession(token, alice), session);
  assert.equal(await resolveSession(token, bob), null, 'a token is scoped to its user');
  assert.equal(await resolveSession('ks_forged', alice), null, 'a forged token resolves to nothing');
  await closeSession(token);
});

test('a long-term session has no expiry at all', async () => {
  const token = await openSession(alice, { persistent: true });
  const session = await lookupSession(token);
  assert.ok(session);
  assert.equal(session.persistent, true);
  assert.equal(session.expiresAt, null, 'nothing on the server will end it by time');
  // A renewal must leave it null rather than quietly filling in a window.
  await touchSession(token, { userAgent: 'test-agent' });
  const again = await lookupSession(token);
  assert.equal(again?.expiresAt, null);
  await closeSession(token);
});

test('an expired session stops resolving the moment it is asked for', async () => {
  const token = await openSession(alice);
  await getPool().query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [alice]);
  assert.equal(await lookupSession(token), null, 'past its window is gone');
  await closeSession(token);
});

test('a use renews a non-persistent window and records the device once', async () => {
  const token = await openSession(alice);
  await touchSession(token, { userAgent: 'first-agent', ip: '203.0.113.9' });
  const first = await lookupSession(token);
  assert.ok(first);
  assert.equal(first.userAgent, 'first-agent');
  assert.equal(first.ip, '203.0.113.9');
  assert.ok(first.expiresAt && Date.parse(first.expiresAt) > Date.now() + 60_000, 'the window moved out');

  await touchSession(token, { userAgent: 'second-agent', ip: '198.51.100.4' });
  const second = await lookupSession(token);
  assert.equal(second?.userAgent, 'first-agent', 'the first sighting names the device');
  assert.equal(second?.ip, '203.0.113.9');
  await closeSession(token);
});

test('the list groups by device, marks the caller, and puts it first', async () => {
  const laptop = await openSession(alice);
  await touchSession(laptop, { userAgent: 'laptop', ip: '203.0.113.1' });
  const phone = await openSession(alice);
  await touchSession(phone, { userAgent: 'phone', ip: '203.0.113.2' });
  const secondLaptop = await openSession(alice);
  await touchSession(secondLaptop, { userAgent: 'laptop', ip: '203.0.113.1' });

  const list = await listUserSessions(alice, phone);
  assert.equal(list.length, 2, 'two devices, three logins');
  assert.equal(list[0].current, true, 'the caller is marked and sorted first');
  const laptopRow = list.find((row) => row.userAgent === 'laptop');
  assert.ok(laptopRow);
  assert.equal(laptopRow.sessions, 2, 'both laptop logins are one row');
  assert.equal(laptopRow.ids.length, 2);
  for (const row of list) {
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(laptop) && !serialised.includes(phone), 'no token crosses the wire');
    assert.ok(!('dek' in row), 'and no key');
  }
  await closeUserSessions(alice);
});

test('revocation is scoped to the user whose ids they are', async () => {
  const mine = await openSession(alice);
  const theirs = await openSession(bob);
  const mineRow = await lookupSession(mine);
  const theirsRow = await lookupSession(theirs);
  assert.ok(mineRow && theirsRow);

  assert.equal(await revokeSessions(bob, [mineRow.id]), 0, 'another account cannot end it');
  assert.ok(await lookupSession(mine), 'and it is still live');
  assert.equal(await revokeSessions(alice, [mineRow.id]), 1);
  assert.equal(await lookupSession(mine), null);
  await closeSession(theirs);
});

test('sign out everywhere else keeps exactly one session', async () => {
  await closeUserSessions(alice);
  const keep = await openSession(alice);
  await openSession(alice);
  await openSession(alice);
  assert.equal(await revokeOtherSessions(alice, keep), 2);
  const list = await listUserSessions(alice, null);
  assert.equal(list.length, 1);
  assert.equal(list[0].current, false, 'no token was passed, so nothing is marked');
  await closeUserSessions(alice);
});

test('hasUserSession and the count agree with the rows', async () => {
  await closeUserSessions(alice);
  assert.equal(await hasUserSession(alice), false);
  const token = await openSession(alice);
  assert.equal(await hasUserSession(alice), true);
  assert.ok((await activeSessionCount()) >= 1);
  await closeSession(token);
});

