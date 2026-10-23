/**
 * The error vocabulary has to be the same on both sides of the wire.
 *
 * The web app mirrors `API_CODES` because it is deployed separately from the
 * service and has to keep working against a server that predates the code
 * contract. A code added to the server and not to the mirror would arrive as an
 * `unknown` kind — the failure this refactor exists to end — so the two lists are
 * compared here rather than trusted.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { API_CODES } from '../src/types.ts';
import { API_CODES as CLIENT_CODES } from '../../src/services/apiCodes.ts';
import { apiCodeFor } from '../src/http.ts';

test('the server and client vocabularies are identical', () => {
  assert.deepEqual(
    [...CLIENT_CODES],
    [...API_CODES],
    'src/services/apiCodes.ts must mirror server/src/types.ts, in the same order',
  );
});

test('the vocabulary has no duplicates', () => {
  assert.equal(new Set(API_CODES).size, API_CODES.length, 'a repeated code would silently change meaning');
});

test('the lockout and the rate limiter are different codes', () => {
  // Both arrive as 401 or 429, and the UI does different things with them: one is
  // "stop trying, this account is locked", the other is "slow down". Matching on
  // status would merge them.
  assert.equal(apiCodeFor('too many failed attempts; try again later', 401), 'LOCKED');
  assert.equal(apiCodeFor('too many attempts; try again shortly', 429), 'RATE_LIMITED');
});

test('the codes the client branches on come from the messages that carry them', () => {
  assert.equal(apiCodeFor('invalid credentials', 401), 'INVALID_CREDENTIALS');
  assert.equal(apiCodeFor('username_taken', 400), 'USERNAME_TAKEN');
  assert.equal(apiCodeFor('username is already taken', 400), 'USERNAME_TAKEN');
  assert.equal(apiCodeFor('X login is not configured on this instance', 400), 'NOT_CONFIGURED');
  assert.equal(apiCodeFor('account_incomplete', 403), 'ACCOUNT_INCOMPLETE');
});

test('an unmapped message still gets a code, from its status', () => {
  // Dynamic messages (`X authorization was declined (…)`) cannot be in the table.
  // They must still answer with a code, or a client has nothing to branch on.
  assert.equal(apiCodeFor('X authorization was declined (access_denied)', 400), 'INVALID_REQUEST');
  assert.equal(apiCodeFor('something nobody mapped', 503), 'UNAVAILABLE');
  assert.equal(apiCodeFor('something nobody mapped', 599), 'INTERNAL');
});

/**
 * The shape cannot drift back.
 *
 * A route that hand-writes `send(res, 400, { error: '...' })` would answer in the
 * old contract — no code — and the client would fall back to string matching for
 * that one path, which is the failure this refactor removed. `fail()` is the only
 * place allowed to build a failure body, so these patterns must not appear
 * anywhere in the routing file.
 */
test('no route builds a failure body by hand', () => {
  const source = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\{\s*error:\s*'/, 'a literal error field must go through fail()');

  // Every `send()` after `fail()` is defined must name a success status, except the
  // one inside `fail` itself, which is the only caller allowed a computed status.
  const sends = [...source.slice(source.indexOf('function fail(')).matchAll(/send\(res,\s*([^,)]+),/g)]
    .map((match) => match[1].trim());
  assert.equal(sends.filter((status) => status === 'status').length, 1,
    'only fail() may answer with a computed status');
  assert.deepEqual(
    sends.filter((status) => status !== 'status' && !/^[23]\d\d$/.test(status)),
    [],
    'a failure status must be sent by fail(), never by send() directly',
  );
});
