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
