import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, setConfigForTesting } from '../src/config.ts';
import { wrapKey, unwrapKey } from '../src/keyProvider.ts';
import { createKeyMaterial, unwrapWithServer, xorKeys } from '../src/session.ts';

const dir = mkdtempSync(join(tmpdir(), 'hrt-local-'));
const keyFile = join(dir, 'master.key');
writeFileSync(keyFile, randomBytes(32));
const env = {
  NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://hrt.test', API_ORIGIN: 'https://hrt.test',
  DATABASE_URL: 'postgres://hrt@localhost/hrt', KEY_PROVIDER: 'local', LOCAL_MASTER_KEY_FILE: keyFile,
};

test('local production starts with a persistent key and no cloud credentials', () => {
  const config = loadConfig(env);
  assert.equal(config.localMasterKey?.length, 32);
  assert.equal(config.kms, null);
  assert.equal(config.x, null);
  assert.equal(config.fcm, null);
  assert.equal(config.turnstile, null);
});

test('invalid, absent, conflicting and implicit local key settings are refused', () => {
  assert.throws(() => loadConfig({ ...env, KEY_PROVIDER: 'other' }), /KEY_PROVIDER/);
  assert.throws(() => loadConfig({ ...env, LOCAL_MASTER_KEY_FILE: '' }), /LOCAL_MASTER_KEY_FILE/);
  assert.throws(() => loadConfig({ ...env, LOCAL_MASTER_KEY_FILE: join(dir, 'missing') }));
  const short = join(dir, 'short');
  writeFileSync(short, 'too short');
  assert.throws(() => loadConfig({ ...env, LOCAL_MASTER_KEY_FILE: short }), /32 raw bytes/);
  assert.throws(() => loadConfig({ ...env, KEY_PROVIDER: undefined }), /requires KEY_PROVIDER=local/);
  assert.throws(() => loadConfig({ ...env,
    KMS_KEY_OCID: 'ocid1.key.oc1.test.abc',
    KMS_CRYPTO_ENDPOINT: 'https://test-crypto.kms.ap-tokyo-1.oraclecloud.com',
  }), /cannot be combined/);
});

test('a local account can reconstruct its record key from deployment wrappers', async () => {
  setConfigForTesting(loadConfig(env));
  const { metadata, dek } = await createKeyMaterial('correct-horse-battery-7', 'alice');
  const bare = await unwrapWithServer(metadata, 'alice');
  assert.ok(bare);
  assert.ok(metadata.pad);
  const pad = await unwrapKey(metadata.pad, 'alice', 'pad');
  assert.ok(pad);
  assert.equal(xorKeys(bare, pad), dek);
});

test('local key envelopes authenticate owner, purpose, key and ciphertext', async () => {
  const config = loadConfig(env);
  const secret = randomBytes(32).toString('base64');
  const wrapped = await wrapKey(secret, 'alice', 'dek', config);
  assert.ok(wrapped);
  assert.equal(await unwrapKey(wrapped, 'alice', 'dek', config), secret);
  assert.equal(await unwrapKey(wrapped, 'bob', 'dek', config), null);
  assert.equal(await unwrapKey(wrapped, 'alice', 'pad', config), null);
  assert.equal(await unwrapKey(wrapped, 'alice', 'dek', { ...config, localMasterKey: randomBytes(32) }), null);
  assert.equal(await unwrapKey({ ...wrapped, data: 'AAAA' }, 'alice', 'dek', config), null);
  assert.notEqual((await wrapKey(secret, 'alice', 'dek', config))?.iv, wrapped.iv);
});
