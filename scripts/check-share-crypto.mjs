/**
 * Runnable check for the share-link encryption.
 *
 * The property worth asserting is not "it round-trips" — a cipher that returned its
 * input would pass that. It is that the payload is *unreadable* without the key: the
 * key travels in the URL fragment, the server stores an envelope it cannot open, and a
 * wrong key or a single flipped byte must fail loudly rather than render something.
 *
 *   node --experimental-transform-types scripts/check-share-crypto.mjs
 *
 * `shareCrypto.ts` imports `secureStore` lazily, inside the functions that persist a
 * live share's key, so importing it here pulls in no Tauri plugin.
 */
import assert from 'node:assert/strict';

const {
  createShareKey,
  isSealedSnapshot,
  openShareSnapshot,
  sealShareSnapshot,
  shareKeyFromHash,
  withShareKey,
} = await import('../src/utils/shareCrypto.ts');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['pass', name]);
  } catch (error) {
    results.push(['fail', name, error.message]);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push(['pass', name]);
  } catch (error) {
    results.push(['fail', name, error.message]);
  }
}

const sample = {
  version: 1,
  mode: 'transfem',
  timezone: 'Asia/Tokyo',
  createdAt: 1_700_000_000_000,
  events: [{ id: 'e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100 }],
  simulation: null,
};

// --- key shape ---------------------------------------------------------------

check('a key is 32 bytes of base64url', () => {
  const key = createShareKey();
  assert.equal(key.length, 43, '43 characters is 32 bytes with no padding');
  assert.match(key, /^[A-Za-z0-9_-]+$/, 'nothing URL-unsafe');
  assert.notEqual(createShareKey(), key, 'keys are random, not derived');
});

// --- sealing ------------------------------------------------------------------

await checkAsync('a sealed snapshot opens with its own key and nothing is lost', async () => {
  const key = createShareKey();
  const sealed = await sealShareSnapshot(sample, key);
  assert.ok(isSealedSnapshot(sealed), 'the envelope is recognisable');
  assert.deepEqual(await openShareSnapshot(sealed, key), sample);
});

await checkAsync('the ciphertext does not contain the plaintext', async () => {
  const key = createShareKey();
  const sealed = await sealShareSnapshot({ note: 'PROLACTIN-SECRET-MARKER' }, key);
  const asText = Buffer.from(sealed.ct, 'base64url').toString('latin1');
  assert.ok(!asText.includes('PROLACTIN-SECRET-MARKER'), 'the plaintext must not survive in the blob');
  assert.ok(!JSON.stringify(sealed).includes('PROLACTIN-SECRET-MARKER'));
});

await checkAsync('a different key cannot open it', async () => {
  const sealed = await sealShareSnapshot(sample, createShareKey());
  await assert.rejects(() => openShareSnapshot(sealed, createShareKey()));
});

await checkAsync('a flipped ciphertext byte fails rather than decrypting', async () => {
  const key = createShareKey();
  const sealed = await sealShareSnapshot(sample, key);
  const bytes = Buffer.from(sealed.ct, 'base64url');
  bytes[0] ^= 0x01;
  const tampered = { ...sealed, ct: bytes.toString('base64url') };
  await assert.rejects(() => openShareSnapshot(tampered, key));
});

await checkAsync('each seal uses a fresh IV', async () => {
  const key = createShareKey();
  const a = await sealShareSnapshot(sample, key);
  const b = await sealShareSnapshot(sample, key);
  assert.notEqual(a.iv, b.iv, 'a reused IV under one key breaks GCM');
  assert.notEqual(a.ct, b.ct);
});

// --- envelope validation ------------------------------------------------------

check('a plaintext snapshot is not mistaken for an envelope', () => {
  assert.equal(isSealedSnapshot(sample), false);
  assert.equal(isSealedSnapshot(null), false);
  assert.equal(isSealedSnapshot({ v: 1, alg: 'AES-256-GCM', iv: 'x', ct: 'y' }), false);
  assert.equal(isSealedSnapshot({ v: 2, alg: 'AES-256-GCM', iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(40) }), false);
});

// --- the link's fragment ------------------------------------------------------

check('the key is read out of the fragment', () => {
  const key = createShareKey();
  assert.equal(shareKeyFromHash(`#k=${key}`), key);
  assert.equal(shareKeyFromHash(`#foo=1&k=${key}`), key);
  assert.equal(shareKeyFromHash('#'), null);
  assert.equal(shareKeyFromHash(''), null);
  assert.equal(shareKeyFromHash('#k=short'), null, 'a truncated key is a paste error, not a key');
  assert.equal(shareKeyFromHash(`#${key}`), null, 'a bare legacy token is not a key');
});

check('appending a key replaces any fragment already there', () => {
  const key = createShareKey();
  const url = withShareKey('https://hrt.example/share/tok#old', key);
  assert.equal(url, `https://hrt.example/share/tok#k=${key}`);
  assert.equal(shareKeyFromHash(url.slice(url.indexOf('#'))), key);
});

// --- report -------------------------------------------------------------------

const failed = results.filter(([status]) => status === 'fail');
for (const [status, name, message] of results) {
  process.stdout.write(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}\n`);
  if (message) process.stdout.write(`        ${message}\n`);
}
if (failed.length > 0) {
  process.stdout.write(`\nshare-crypto: ${failed.length} of ${results.length} checks failed\n`);
  process.exit(1);
}
process.stdout.write(`\nshare-crypto: all ${results.length} checks passed\n`);
