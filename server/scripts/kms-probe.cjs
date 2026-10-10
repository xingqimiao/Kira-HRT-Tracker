/**
 * KMS readiness probe — run ON the OCI instance, before any code depends on KMS.
 *
 * Verifies the whole chain in one shot: Instance Principals auth (IMDS reachable,
 * dynamic group matches this instance), the IAM policy grants `use` on the vault
 * and key, and the master key is ENABLED. Does one Encrypt → Decrypt round trip
 * with a throwaway payload; nothing is persisted anywhere.
 *
 *   node kms-probe.cjs   # with KMS_KEY_OCID and KMS_CRYPTO_ENDPOINT in the env
 *
 * Exit 0 + "KMS PROBE OK" means the runtime can mint and unwrap KMS-wrapped
 * server wrappers. An authorization failure here means the dynamic group rule or
 * the `Allow dynamic-group … to use vaults/keys` policy is not in effect yet —
 * IAM propagation can take a minute or two after creation.
 */
'use strict';

const common = require('oci-common');
const kms = require('oci-keymanagement');

/** Only a real KMS cryptographic endpoint is acceptable: https, and a host under
 *  a regional kms oraclecloud.com zone. This is a trust boundary — the endpoint
 *  is where the wrapped master key material goes. */
function assertEndpoint(urlRaw) {
  let url;
  try { url = new URL(urlRaw); } catch { throw new Error('KMS_CRYPTO_ENDPOINT is not a URL'); }
  if (url.protocol !== 'https:') throw new Error('KMS_CRYPTO_ENDPOINT must be https');
  if (!/^[a-z0-9-]+-crypto\.kms\.[a-z0-9-]+\.oraclecloud\.com$/.test(url.hostname)) {
    throw new Error(`KMS_CRYPTO_ENDPOINT host looks wrong: ${url.hostname}`);
  }
  return urlRaw;
}

async function main() {
  const keyId = process.env.KMS_KEY_OCID;
  const endpoint = assertEndpoint(process.env.KMS_CRYPTO_ENDPOINT || '');
  if (!keyId || !/^ocid1\.key\.oc1\./.test(keyId)) {
    throw new Error('KMS_KEY_OCID must be a master-encryption-key OCID (ocid1.key.oc1.…)');
  }

  console.error('[1/4] authenticating via Instance Principals (IMDS)…');
  const provider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();

  console.error('[2/4] building KmsCryptoClient →', endpoint);
  const client = new kms.KmsCryptoClient({ authenticationDetailsProvider: provider });
  client.endpoint = endpoint;

  const marker = `kira-kms-probe-${Date.now()}`;
  const associatedData = { context: 'kira-kms-probe' };
  console.error('[3/4] Encrypt…');
  const enc = await client.encrypt({
    encryptDataDetails: {
      keyId,
      plaintext: Buffer.from(marker, 'utf8').toString('base64'),
      associatedData,
    },
  });

  console.error('[4/4] Decrypt…');
  const dec = await client.decrypt({
    decryptDataDetails: { keyId, ciphertext: enc.encryptedData.ciphertext, associatedData },
  });
  const round = Buffer.from(dec.decryptedData.plaintext, 'base64').toString('utf8');

  if (round !== marker) {
    throw new Error(`round trip mismatch: got ${JSON.stringify(round)}`);
  }
  console.log('KMS PROBE OK');
  console.log('keyId   :', keyId);
  console.log('endpoint:', endpoint);
  console.log('keyVersion:', enc.encryptedData.keyVersion);
}

main().catch((error) => {
  const e = error || {};
  console.error('KMS PROBE FAILED');
  console.error('statusCode:', e.statusCode, 'service:', e.serviceCode || '');
  console.error('message  :', e.message);
  if (e.statusCode === 401 || e.statusCode === 403 || e.statusCode === 404) {
    console.error('→ authz failure: check (a) dynamic group rule matches this instance');
    console.error('  (b) policy: Allow dynamic-group <dg> to use vaults/keys in tenancy kiramyao');
    console.error('  (c) IAM propagation delay — wait 1-2 minutes and retry');
  }
  process.exit(1);
});
