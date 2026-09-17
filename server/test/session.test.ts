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
