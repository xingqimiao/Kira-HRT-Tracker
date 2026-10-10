/**
 * Runnable check for the record payload encryption.
 *
 * This module is the one place that can silently corrupt every stored record: a
 * swapped IV or a dropped auth tag still produces *some* string, and the failure only
 * shows up as unreadable data long after the write. So the properties asserted here
 * are the ones the storage format actually depends on, including the wire format
 * itself that the column is documented to hold.
 *
 *   node scripts/check-payload-crypto.mjs
 *
 * No browser, no network, no database: pure functions over `node:crypto`.
 */
import assert from 'node:assert/strict'

const {
    encryptPayload,
    decryptPayload,
    sealPayload,
    openPayload,
    isEncryptedPayload,
} = await import('../server/src/payloadCrypto.ts')

const results = []
function check(name, fn) {
    try {
        fn()
        results.push(['pass', name])
    } catch (error) {
        results.push(['fail', name, error.message])
    }
}

const KEY = Buffer.alloc(32, 7)
const KEY2 = Buffer.alloc(32, 9)

// ── Round trip ────────────────────────────────────────────────────────────────

check('a record survives encryption and decryption', () => {
    const record = { med_name: '雌二醇', dosage: '2mg', note: '舌下含服' }
    const sealed = encryptPayload(record, KEY)
    assert.deepEqual(decryptPayload(sealed, KEY), record)
})

check('unicode, nesting and null survive', () => {
    const record = {
        med_name: '醋酸环丙孕酮',
        values: [1, 2.5, null, true],
        nested: { deep: { note: '备注 🩸' } },
        empty: '',
    }
    assert.deepEqual(decryptPayload(encryptPayload(record, KEY), KEY), record)
})

// ── The documented wire format ────────────────────────────────────────────────
//
// `payload_encrypted` is TEXT holding "iv:tag:ciphertext" in base64. The gate is on
// the exact shape because that string is what a future reader of the column sees.

check('the sealed form is iv:tag:ciphertext in base64', () => {
    const sealed = encryptPayload({ a: 1 }, KEY)
    const parts = sealed.split(':')
    assert.equal(parts.length, 3, `expected 3 parts, got ${parts.length}`)

    const [iv, tag, ct] = parts
    assert.equal(Buffer.from(iv, 'base64').length, 12, 'AES-GCM uses a 96-bit IV')
    assert.equal(Buffer.from(tag, 'base64').length, 16, 'GCM tag is 128 bits')
    assert.ok(Buffer.from(ct, 'base64').length > 0, 'ciphertext must not be empty')
})

check('the plaintext does not appear in the sealed form', () => {
    const sealed = encryptPayload({ med_name: '雌二醇', dosage: '2mg' }, KEY)
    assert.ok(!sealed.includes('雌二醇'), 'the medication name must not survive')
    assert.ok(!sealed.includes('2mg'), 'nor the dose')
    assert.ok(!sealed.includes('med_name'), 'nor any field name')
})

// GCM's security argument needs a fresh nonce per message under one key. Two records
// with the same content must not be linkable, and nonce reuse breaks GCM outright.
check('two encryptions of the same record differ, and both decrypt', () => {
    const record = { med_name: 'same', dosage: 'same' }
    const once = encryptPayload(record, KEY)
    const twice = encryptPayload(record, KEY)

    assert.notEqual(once, twice, 'an identical record must not produce an identical string')
    assert.notEqual(once.split(':')[0], twice.split(':')[0], 'each message needs its own IV')
    assert.deepEqual(decryptPayload(once, KEY), record)
    assert.deepEqual(decryptPayload(twice, KEY), record)
})

// ── Tampering and wrong keys fail closed ──────────────────────────────────────
//
// The whole point of GCM over CTR here: a modified ciphertext must be rejected, not
// decrypted into a plausible-looking dose that then gets shown as someone's history.

check('a tampered ciphertext is rejected', () => {
    const sealed = encryptPayload({ dosage: '2mg' }, KEY)
    const [iv, tag, ct] = sealed.split(':')
    const bytes = Buffer.from(ct, 'base64')
    bytes[0] ^= 0x01
    const flipped = [iv, tag, bytes.toString('base64')].join(':')
    assert.throws(() => decryptPayload(flipped, KEY))
})

check('a tampered tag is rejected', () => {
    const sealed = encryptPayload({ dosage: '2mg' }, KEY)
    const [iv, tag, ct] = sealed.split(':')
    const bytes = Buffer.from(tag, 'base64')
    bytes[0] ^= 0x01
    assert.throws(() => decryptPayload([iv, bytes.toString('base64'), ct].join(':'), KEY))
})

check('the wrong key cannot decrypt', () => {
    const sealed = encryptPayload({ dosage: '2mg' }, KEY)
    assert.throws(() => decryptPayload(sealed, KEY2))
})

check('a malformed string is rejected rather than half-read', () => {
    // `'a:b:c'` is deliberately absent: those happen to base64-decode to 12 + 16 + 0
    // bytes, so it passes the shape gate and the *empty ciphertext* is what rejects it.
    // That is asserted separately below rather than left as a shape case that passes
    // for a different reason than the one it claims.
    for (const bad of ['', 'not-base64', 'a:b', 'a:b:c:d', '!!!:!!!:!!!']) {
        assert.throws(() => decryptPayload(bad, KEY), `expected a throw for ${JSON.stringify(bad)}`)
    }
})

check('an empty ciphertext is rejected', () => {
    const [iv, tag] = encryptPayload({ a: 1 }, KEY).split(':')
    assert.throws(() => decryptPayload(`${iv}:${tag}:`, KEY))
})

// ── Recognition ──────────────────────────────────────────────────────────────

check('isEncryptedPayload accepts the sealed form and refuses lookalikes', () => {
    const sealed = sealPayload({ a: 1 }, KEY)
    assert.equal(isEncryptedPayload(sealed), true)
    assert.equal(isEncryptedPayload(encryptPayload({ a: 1 }, KEY)), false, 'an untagged value is not a stored payload')
    assert.equal(isEncryptedPayload(''), false)
    assert.equal(isEncryptedPayload('plain json'), false)
    assert.equal(isEncryptedPayload('v2:a:b:c'), false, 'right tag, wrong shape')
    assert.equal(isEncryptedPayload(null), false)
    assert.equal(isEncryptedPayload(undefined), false)
    assert.equal(isEncryptedPayload({ iv: 'x' }), false)
})

// ── Seal / open, and the refusal of the retired form ─────────────────────────
//
// Every stored row is sealed under its own account's DEK and tagged `v2:`. A row with
// no tag predates per-account keys and was sealed under the retired deployment-wide
// key, so opening it must fail rather than be guessed at.

check('sealPayload then openPayload round-trips under one key', () => {
    const record = { med_name: '雌二醇', dosage: '2mg' }
    const sealed = sealPayload(record, KEY)
    assert.ok(sealed.startsWith('v2:'), 'a sealed payload carries the per-account tag')
    assert.deepEqual(openPayload(sealed, KEY), record)
})

check('openPayload refuses a payload with no per-account tag', () => {
    const untagged = encryptPayload({ med_name: 'legacy' }, KEY)
    assert.throws(() => openPayload(untagged, KEY), /no per-account seal tag/)
})

check('openPayload refuses another account\'s key', () => {
    const sealed = sealPayload({ dosage: '2mg' }, KEY)
    assert.throws(() => openPayload(sealed, KEY2))
})

for (const [status, name, detail] of results) {
    console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const failed = results.filter(([status]) => status === 'fail').length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
