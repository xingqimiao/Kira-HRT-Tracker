/**
 * TOTP and recovery codes.
 *
 * These tests assert against **RFC 6238's own published vectors** rather than
 * against values this implementation produced. A round-trip test ("the code I
 * generated verifies") passes just as happily for a wrong algorithm, which is
 * exactly the failure that would ship: correct-looking codes that no authenticator
 * app accepts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  base32Encode,
  base32Decode,
  totpCodeAt,
  verifyTotpCodeWithStep,
  verifyTotpCode,
  otpauthUri,
  sealTotpSecret,
  openTotpSecret,
  generateTotpSecret,
  generateBackupCodes,
  verifyBackupCode,
  hashBackupCode,
  BACKUP_CODE_COUNT,
} from '../src/totp.ts';

/** RFC 6238 Appendix B: secret "12345678901234567890" as base32. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'utf8'));

const RFC_VECTORS: { unixSeconds: number; code: string }[] = [
  { unixSeconds: 59, code: '94287082' },
  { unixSeconds: 1111111109, code: '07081804' },
  { unixSeconds: 1111111111, code: '14050471' },
  { unixSeconds: 1234567890, code: '89005924' },
  { unixSeconds: 2000000000, code: '69279037' },
  { unixSeconds: 20000000000, code: '65353130' },
];

test('base32 encode/decode round-trips', () => {
  const bytes = Buffer.from('12345678901234567890', 'utf8');
  assert.equal(Buffer.from(base32Decode(base32Encode(bytes))).toString('utf8'), '12345678901234567890');
  // RFC 4648 test vector.
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(Buffer.from(base32Decode('MZXW6YTBOI')).toString('utf8'), 'foobar');
});

test('TOTP matches the RFC 6238 published vectors with an 8-digit truncation', () => {
  // The implementation is fixed at 6 digits (what apps default to). RFC 6238
  // publishes 8-digit codes, so each expected value is the last 6 digits of the
  // published one — the same dynamic-truncation value, just a shorter modulo.
  for (const { unixSeconds, code } of RFC_VECTORS) {
    const expected6 = code.slice(-6);
    assert.equal(
      totpCodeAt(RFC_SECRET, unixSeconds * 1000),
      expected6,
      `TOTP at ${unixSeconds}s should be ${expected6}`,
    );
  }
});

test('a code verifies within one step of drift and not beyond', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;

  assert.ok(verifyTotpCode(secret, totpCodeAt(secret, now), now), 'the current code works');
  assert.ok(verifyTotpCode(secret, totpCodeAt(secret, now - 30_000), now), 'one step back is tolerated');
  assert.ok(verifyTotpCode(secret, totpCodeAt(secret, now + 30_000), now), 'one step forward is tolerated');
  // Two steps is a minute out of sync; accepting that widens the guessing window
  // for no real usability gain.
  assert.ok(!verifyTotpCode(secret, totpCodeAt(secret, now - 60_000), now), 'two steps back is refused');
  assert.ok(!verifyTotpCode(secret, totpCodeAt(secret, now + 60_000), now), 'two steps forward is refused');
});

test('malformed input is rejected rather than throwing', () => {
  const secret = generateTotpSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', 'null', '0000000']) {
    assert.equal(verifyTotpCodeWithStep(secret, bad), null, `${JSON.stringify(bad)} must not verify`);
  }
  // An unreadable secret must fail closed, not skip the check.
  assert.equal(verifyTotpCodeWithStep('not base32 !!', '123456'), null);
});

test('the verifier reports which step matched, for replay prevention', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / 30);

  assert.equal(verifyTotpCodeWithStep(secret, totpCodeAt(secret, now), now), step);
  assert.equal(verifyTotpCodeWithStep(secret, totpCodeAt(secret, now - 30_000), now), step - 1);
});

test('secrets are encrypted at rest and fail closed on a wrong key', async () => {
  const key = 'a'.repeat(48);
  const otherKey = 'b'.repeat(48);
  const secret = generateTotpSecret();

  const sealed = await sealTotpSecret(secret, key);
  assert.ok(!sealed.includes(secret), 'the plaintext secret must not appear in the sealed value');
  assert.match(sealed, /^v1\./, 'the envelope is versioned');

  assert.equal(await openTotpSecret(sealed, key), secret, 'the right key opens it');
  // A wrong key must not yield a usable secret — this is what makes a database
  // dump insufficient to mint codes.
  assert.equal(await openTotpSecret(sealed, otherKey), null);
  assert.equal(await openTotpSecret('garbage', key), null);
  assert.equal(await openTotpSecret('v2.a.b', key), null, 'an unknown version is refused');
});

test('the otpauth URI carries what an authenticator app needs', () => {
  const uri = otpauthUri({ secretBase32: 'MZXW6YTBOI', accountLabel: 'alice', issuer: 'Kira Tracker' });
  assert.ok(uri.startsWith('otpauth://totp/'), `wrong scheme: ${uri}`);
  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('secret'), 'MZXW6YTBOI');
  assert.equal(parsed.searchParams.get('issuer'), 'Kira Tracker');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
  // The label is `issuer:account`, percent-encoded.
  assert.ok(decodeURIComponent(parsed.pathname).includes('Kira Tracker:alice'));
});

test('generated secrets are long enough to be worth anything', () => {
  const secret = generateTotpSecret();
  // 20 random bytes → 32 base32 characters.
  assert.equal(secret.length, 32, `expected 32 chars, got ${secret.length}`);
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.notEqual(generateTotpSecret(), generateTotpSecret(), 'secrets must differ');
});

test('recovery codes are single-use-shaped and verifiable', async () => {
  const { plaintext, hashes } = await generateBackupCodes();
  assert.equal(plaintext.length, BACKUP_CODE_COUNT);
  assert.equal(hashes.length, BACKUP_CODE_COUNT);

  const seen = new Set(plaintext);
  assert.equal(seen.size, BACKUP_CODE_COUNT, 'codes must not repeat');

  for (const code of plaintext) {
    assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/, `unexpected code shape: ${code}`);
    // Ambiguous characters are excluded on purpose: these get read aloud and
    // typed by hand.
    assert.ok(!/[IO01]/.test(code), `ambiguous character in ${code}`);
  }

  const [first] = plaintext;
  assert.ok(await verifyBackupCode(first, hashes[0]), 'a code verifies against its own hash');
  assert.ok(!(await verifyBackupCode(first, hashes[1])), 'a code does not verify against another');
  assert.ok(!(await verifyBackupCode('WRONG-WRONG', hashes[0])), 'a wrong code is refused');
});

test('recovery codes are hashed irreversibly and tolerate sloppy typing', async () => {
  const code = 'ABCDE-FGHJK';
  const hash = await hashBackupCode(code);
  assert.ok(!hash.includes('ABCDE'), 'the code must not be recoverable from the hash');
  assert.match(hash, /^scrypt\$/);

  // Case, spacing and the hyphen are all things people get wrong under stress, and
  // normalising them costs nothing.
  for (const variant of ['abcde-fghjk', 'ABCDEFGHJK', 'abcde fghjk', ' ABCDE-FGHJK ']) {
    assert.ok(await verifyBackupCode(variant, hash), `${JSON.stringify(variant)} should verify`);
  }
  assert.ok(!(await verifyBackupCode('ABCDE-FGHJL', hash)), 'a different code is refused');
});
