/**
 * The KMS master key is the deployment's only way to open an account, so its
 * configuration is validated as a unit: both variables or neither, an endpoint host
 * under the OCI KMS zone, and a production boot that refuses to start without it —
 * an instance that stored an account and could not open it again would be lying.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.ts';

const BASE = {
  PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
  API_ORIGIN: 'https://api.kiramyao.com',
  DATABASE_URL: 'postgres://hrt@127.0.0.1:5432/hrt',
  NODE_ENV: 'production',
  KMS_KEY_OCID: 'ocid1.key.oc1.ap-tokyo-1.ezvmu6vqaabfc.abxhiljr3o6ah4yxsioulouvpn3cev63s3vxvfg6m5xm6np27djpnric45qq',
  KMS_CRYPTO_ENDPOINT: 'https://ezvmu6vqaabfc-crypto.kms.ap-tokyo-1.oraclecloud.com',
};

test('a complete KMS pair loads and lands in the config', () => {
  const config = loadConfig({ ...BASE });
  assert.equal(config.kms?.keyId, BASE.KMS_KEY_OCID);
  assert.equal(config.kms?.cryptoEndpoint, BASE.KMS_CRYPTO_ENDPOINT);
});

test('half a KMS pair is the failure worth catching', () => {
  const { KMS_CRYPTO_ENDPOINT: _endpoint, ...noEndpoint } = BASE;
  assert.throws(() => loadConfig(noEndpoint), /KMS_CRYPTO_ENDPOINT is required/);
  const { KMS_KEY_OCID: _key, ...noKey } = BASE;
  assert.throws(() => loadConfig(noKey), /KMS_KEY_OCID is required/);
});

test('an endpoint outside the OCI KMS zone is refused at startup', () => {
  assert.throws(
    () => loadConfig({ ...BASE, KMS_CRYPTO_ENDPOINT: 'https://evil.example.com/decrypt' }),
    /not an OCI KMS crypto endpoint/,
  );
  assert.throws(
    () => loadConfig({ ...BASE, KMS_CRYPTO_ENDPOINT: 'http://ezvmu6vqaabfc-crypto.kms.ap-tokyo-1.oraclecloud.com' }),
    /must be https/,
  );
});

test('a production boot without any KMS refuses to start', () => {
  const { KMS_KEY_OCID: _key, KMS_CRYPTO_ENDPOINT: _endpoint, ...noKms } = BASE;
  assert.throws(() => loadConfig(noKms), /KMS_KEY_OCID \+ KMS_CRYPTO_ENDPOINT are required in production/);
});
