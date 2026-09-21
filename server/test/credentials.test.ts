/**
 * The two keys that must not sit on the same disk as the database.
 *
 * `applyCredentials` is the seam: it folds a systemd credential directory into the
 * environment before anything reads the environment. These pin the three states a
 * deployment can be in while migrating, because the middle one -- credentials
 * configured but not yet read -- looks identical from the outside.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.ts';

const BASE = {
  PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
  API_ORIGIN: 'https://api.kiramyao.com',
  DATABASE_URL: 'postgres://hrt@127.0.0.1:5432/hrt',
  NODE_ENV: 'production',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  SERVER_DEK_KEY: 'a'.repeat(64),
};

const missing = () => { throw new Error('ENOENT'); };

test('a credential overrides a stale line in the environment', () => {
  const fresh = Buffer.alloc(32, 2).toString('base64');
  const files: Record<string, string> = { '/cred/ENCRYPTION_KEY': fresh, '/cred/SERVER_DEK_KEY': 'b'.repeat(64) };
  const config = loadConfig(
    { ...BASE, ENCRYPTION_KEY: 'stale', SERVER_DEK_KEY: 'stale', CREDENTIALS_DIRECTORY: '/cred' },
    (p) => { const v = files[p]; if (v === undefined) throw new Error('ENOENT'); return v; },
  );
  assert.equal(config.encryptionKey?.toString('base64'), fresh.trim());
  assert.equal(config.serverDekKey, 'b'.repeat(64));
  assert.deepEqual(config.keysFromCredentials, ['ENCRYPTION_KEY', 'SERVER_DEK_KEY']);
});

test('with no credential directory the environment is still enough', () => {
  const config = loadConfig({ ...BASE }, missing);
  assert.equal(config.serverDekKey, 'a'.repeat(64));
  assert.deepEqual(config.keysFromCredentials, [], 'nothing claimed that did not happen');
});

test('a credential directory that lacks the file falls back rather than failing', () => {
  // This is the half-migrated deployment: the unit names the credentials, the files
  // are not there yet. Booting must not depend on the order of those two steps.
  const config = loadConfig({ ...BASE, CREDENTIALS_DIRECTORY: '/cred' }, missing);
  assert.equal(config.serverDekKey, 'a'.repeat(64));
  assert.deepEqual(config.keysFromCredentials, []);
});
