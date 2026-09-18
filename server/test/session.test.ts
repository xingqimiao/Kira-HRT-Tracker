/**
 * Key-handling tests. This is the privacy boundary, so the properties asserted
 * here are the ones the README's claim actually rests on.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createUserKeyMaterial,
  unwrapDek,
  rewrapForNewPassword,
  openSession,
  resolveSession,
  closeSession,
  closeUserSessions,
  activeSessionCount,
  findUserSession,
  touchSession,
  listUserSessions,
  revokeSessions,
  revokeOtherSessions,
} from '../src/session.ts';
import { encryptCloudPayload, decryptCloudPayload } from '../src/engine.ts';

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

test('sessions hand back the DEK and are scoped to their user', async () => {
  const { dek } = await createUserKeyMaterial(password, userId);
  const token = openSession(userId, dek);
  assert.equal(resolveSession(token, userId), dek);
  assert.equal(resolveSession(token, 'another-user'), null, 'token must not cross accounts');
  assert.equal(resolveSession('ks_forged', userId), null);
});

test('closing a session revokes it immediately', async () => {
  const { dek } = await createUserKeyMaterial(password, userId);
  const token = openSession(userId, dek);
  closeSession(token);
  assert.equal(resolveSession(token, userId), null);
});

test('closing all of a user sessions leaves other users untouched', async () => {
  const a = await createUserKeyMaterial(password, userId);
  const b = await createUserKeyMaterial(password, 'other-user');
  const tokenA = openSession(userId, a.dek);
  const tokenB = openSession('other-user', b.dek);

  closeUserSessions(userId);
  assert.equal(resolveSession(tokenA, userId), null, 'target user revoked');
  assert.equal(resolveSession(tokenB, 'other-user'), b.dek, 'bystander unaffected');

  closeSession(tokenB);
  assert.equal(activeSessionCount(), 0);
});

/**
 * The agent-token window.
 *
 * `findUserSession` is what lets a durable `hrt_` token read anything: the token
 * supplies a user id, this supplies the key. These tests pin the two properties the
 * policy depends on, because the policy's honesty rests on exactly them — an unlocked
 * session is *required*, and a session stays open as long as someone keeps reading.
 */
test('an agent token needs an unlock: no session means no key', () => {
  assert.equal(findUserSession(userId), null, 'a token alone must resolve to nothing');
});

test('an agent token reads during the owner\'s unlock, with no token of its own', async () => {
  const { dek } = await createUserKeyMaterial(password, userId);
  openSession(userId, dek);
  // The token path passes no session token here — it only knows the user id. Getting
  // the DEK back is what makes a leaked token dangerous while the user is signed in.
  assert.equal(findUserSession(userId), dek);
  closeUserSessions(userId);
});

test('a token read keeps the session alive past its nominal 30-minute window', async () => {
  const { dek } = await createUserKeyMaterial(password, userId);
  // A session that is already expired, to prove findUserSession is not merely
  // returning something that happened to still be valid.
  openSession(userId, dek, -1);
  assert.equal(findUserSession(userId), null, 'expired session sweeps to nothing before any read');

  const fresh = openSession(userId, dek, 1);
  assert.equal(findUserSession(userId), dek, 'a token read extends the live window');
  // The refresh means revoking is the only way to end it — expiry alone will not,
  // so long as reads keep arriving. Documented in CODE-AUDIT.md.
  closeSession(fresh);
});

test('revoking every session ends token access immediately', async () => {
  const { dek } = await createUserKeyMaterial(password, userId);
  openSession(userId, dek);
  assert.equal(findUserSession(userId), dek);
  closeUserSessions(userId);
  assert.equal(findUserSession(userId), null, 'revocation must close the window, not shorten it');
});

test('the DEK a token obtains is scoped to its own account', async () => {
  const a = await createUserKeyMaterial(password, userId);
  const b = await createUserKeyMaterial(password, 'other-user');
  assert.notEqual(a.dek, b.dek, 'two accounts must not share a DEK');

  openSession('other-user', b.dek);
  assert.equal(findUserSession(userId), null, 'an open session for B must not unlock A');
  assert.equal(findUserSession('other-user'), b.dek);

  closeUserSessions('other-user');
  assert.equal(findUserSession(userId), null);
});

/**
 * The account page's device list.
 *
 * The list exists so a person can *end* access they no longer recognise, so the two
 * properties that matter are that it names unlocks without ever carrying a credential,
 * and that revoking a row cannot reach another account. Both are pinned here.
 *
 * Each test uses its own user id: the store is module-level and shared with every other
 * test in the run, so a shared id would make the assertions depend on their order.
 */
test('a session row is named by an id, and carries no token or key', async () => {
  const user = 'sessions-row-shape';
  const { dek } = await createUserKeyMaterial(password, user);
  try {
    const token = openSession(user, dek);
    const rows = listUserSessions(user, token);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].current, true);
    assert.notEqual(rows[0].id, token, 'the handle must not be the credential');
    assert.deepEqual(rows[0].ids, [rows[0].id]);

    // Pretty-printed so a nested leak cannot hide behind escaping.
    const serialised = JSON.stringify(rows, null, 2);
    assert.ok(!serialised.includes(token), 'the token must never cross the wire');
    assert.ok(!serialised.includes(dek), 'nor the key it carries');
  } finally {
    closeUserSessions(user);
  }
});

test('two unlocks on one device read as one row that stands for both', async () => {
  const user = 'sessions-grouping';
  const { dek } = await createUserKeyMaterial(password, user);
  try {
    const first = openSession(user, dek);
    const second = openSession(user, dek);
    const device = { userAgent: 'TestAgent/1.0', ip: '203.0.113.7' };
    touchSession(first, device);
    touchSession(second, device);

    const rows = listUserSessions(user, second);
    assert.equal(rows.length, 1, 'the same device is one row');
    assert.equal(rows[0].sessions, 2);
    assert.equal(rows[0].ids.length, 2);
    assert.equal(new Set(rows[0].ids).size, 2, 'both unlocks are named, with no duplicate');
    assert.equal(rows[0].current, true, 'the caller is marked, not hidden');
  } finally {
    closeUserSessions(user);
  }
});

test('the first sighting names the device and later requests do not relabel it', async () => {
  const user = 'sessions-touch-once';
  const { dek } = await createUserKeyMaterial(password, user);
  try {
    const token = openSession(user, dek);
    touchSession(token, { userAgent: 'FirstAgent/1.0', ip: '198.51.100.4' });
    touchSession(token, { userAgent: 'LaterAgent/9.9', ip: '198.51.100.99' });

    const [row] = listUserSessions(user, token);
    assert.equal(row.userAgent, 'FirstAgent/1.0');
    assert.equal(row.ip, '198.51.100.4');
  } finally {
    closeUserSessions(user);
  }
});

test('revocation by handle is scoped to its account', async () => {
  const owner = 'sessions-revoke-owner';
  const stranger = 'sessions-revoke-stranger';
  const a = await createUserKeyMaterial(password, owner);
  const b = await createUserKeyMaterial(password, stranger);
  try {
    openSession(owner, a.dek);
    const victim = openSession(stranger, b.dek);
    const strangerId = listUserSessions(stranger, victim)[0].id;

    assert.equal(revokeSessions(owner, [strangerId]), 0, 'another account\'s id is not an authorization');
    assert.equal(resolveSession(victim, stranger), b.dek, 'the other account is still unlocked');

    const own = listUserSessions(owner, null)[0].id;
    assert.equal(revokeSessions(owner, [own]), 1);
    assert.equal(listUserSessions(owner, null).length, 0);
  } finally {
    closeUserSessions(owner);
    closeUserSessions(stranger);
  }
});

test('signing out everywhere else keeps the caller', async () => {
  const user = 'sessions-revoke-others';
  const { dek } = await createUserKeyMaterial(password, user);
  try {
    // Named devices, so the three unlocks are three rows and "two revoked" is visible
    // as two rows going away rather than as arithmetic on a single grouped row.
    touchSession(openSession(user, dek), { userAgent: 'Phone/1.0', ip: '203.0.113.1' });
    touchSession(openSession(user, dek), { userAgent: 'Tablet/1.0', ip: '203.0.113.2' });
    const keeper = openSession(user, dek);
    touchSession(keeper, { userAgent: 'Laptop/1.0', ip: '203.0.113.3' });
    assert.equal(listUserSessions(user, keeper).length, 3);

    assert.equal(revokeOtherSessions(user, keeper), 2);
    const rows = listUserSessions(user, keeper);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].current, true);
    assert.equal(rows[0].userAgent, 'Laptop/1.0');
  } finally {
    closeUserSessions(user);
  }
});
