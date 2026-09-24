/**
 * Self-check for the foreign-import adapters.
 *
 *   node --experimental-transform-types scripts/check-foreign-import.mjs
 *
 * Covers recognition (every source, plus the two negative cases), the Transmtf
 * conversion, and a **real** Featherline envelope round trip — the module's
 * Argon2id + AES-GCM + gzip path is exercised end to end here rather than described,
 * because a byte offset or an AAD mistake would produce a plausible-looking
 * "wrong password" at runtime and nothing else would catch it.
 */
import assert from 'node:assert/strict'
import { argon2id } from 'hash-wasm'

import { detectForeignFormat, convertForeignPayload } from '../src/utils/foreignImport.ts'
import { isFeatherlineBackup, decryptFeatherline, mapFeatherlineSnapshot, FeatherlineError } from '../src/utils/featherlineBackup.ts'

let pass = 0
const check = (name, fn) => {
    try {
        fn()
        pass++
        console.log(`ok    ${name}`)
    } catch (e) {
        console.error(`FAIL  ${name}\n      ${e.message}`)
        process.exitCode = 1
    }
}
const checkAsync = async (name, fn) => {
    try {
        await fn()
        pass++
        console.log(`ok    ${name}`)
    } catch (e) {
        console.error(`FAIL  ${name}\n      ${e.message}`)
        process.exitCode = 1
    }
}

// ── Recognition ──────────────────────────────────────────────────────────────

check('our own file is recognised by its format marker', () => {
    const d = detectForeignFormat(JSON.stringify({ format: 'kira-hrt', meta: { version: 3 }, events: [] }))
    assert.equal(d.source, 'kira')
    assert.equal(d.encrypted, false)
})

check('a pre-marker Kira export still lands (its shape is the fallback)', () => {
    // Our own v2/v3 files written before `format` existed carry `modes`.
    const d = detectForeignFormat(JSON.stringify({ meta: { version: 3 }, mode: 'transfem', modes: {}, events: [] }))
    assert.equal(d.source, 'oyama', 'indistinguishable from Oyama by shape alone — which is why the marker exists')
    assert.equal(d.problem, undefined)
})

check('Transmtf is recognised by gelProducts', () => {
    const d = detectForeignFormat(JSON.stringify({ weight: 60, events: [], labResults: [], gelProducts: [] }))
    assert.equal(d.source, 'transmtf')
})

check("Oyama's multi-mode shape is recognised", () => {
    const d = detectForeignFormat(JSON.stringify({ mode: 'transfem', modes: { transfem: {} }, doseTemplates: [] }))
    assert.equal(d.source, 'oyama')
})

check('a password envelope is flagged encrypted, and its iter presence reported', () => {
    const ours = detectForeignFormat(JSON.stringify({ encrypted: true, iv: 'a', salt: 'b', iter: 600000, data: 'c' }))
    assert.equal(ours.encrypted, true)
    assert.equal(ours.hasIter, true)
    const transmtf = detectForeignFormat(JSON.stringify({ encrypted: true, iv: 'a', salt: 'b', data: 'c' }))
    assert.equal(transmtf.encrypted, true)
    assert.equal(transmtf.hasIter, false, 'Transmtf writes no iter; decryptData reads it at its 100000 default')
})

check('a bare array is our v1 events-only export', () => {
    const d = detectForeignFormat(JSON.stringify([{ timeH: 1, doseMG: 1, route: 'oral', ester: 'E2' }]))
    assert.equal(d.source, 'kira')
})

check('unparseable text reports unreadable, and is not a silent pass', () => {
    const d = detectForeignFormat('this is not json at all')
    assert.equal(d.source, null)
    assert.equal(d.problem, 'unreadable')
})

check('our compression envelope is passed through, not rejected', () => {
    // `{c: "..."}` must reach the existing decompression path. If recognition
    // claimed it as unrecognised, compression would break.
    const d = detectForeignFormat(JSON.stringify({ c: 'H4sIAAAA' }))
    assert.equal(d.source, null)
    assert.equal(d.problem, undefined, 'no problem flag — the caller decides')
})

check('Featherline is recognised from its magic bytes, not from text', () => {
    const bytes = new Uint8Array([0x48, 0x52, 0x54, 0x42, 0x4b, 0x50, 0x31, 3, 2, 1, 1])
    const d = detectForeignFormat(bytes)
    assert.equal(d.source, 'featherline')
    assert.equal(d.encrypted, true)
    assert.ok(d.bytes)
})

// ── Conversion ───────────────────────────────────────────────────────────────

check('Transmtf conversion drops gelProducts and reports the count', () => {
    const { payload, skipped } = convertForeignPayload(
        { weight: 60, events: [{ timeH: 1 }], labResults: [], gelProducts: [{ id: 1000 }, { id: 1001 }] },
        'transmtf',
    )
    assert.equal(skipped.gelProducts, 2)
    assert.ok(!('gelProducts' in payload), 'the catalogue must not reach the reader')
    assert.ok('events' in payload && 'weight' in payload, 'everything else is kept')
})

check('Transmtf with no custom products reports nothing skipped', () => {
    const { skipped } = convertForeignPayload({ weight: 60, events: [], gelProducts: [] }, 'transmtf')
    assert.equal(skipped.gelProducts, undefined)
})

check('an Oyama payload passes through untouched', () => {
    const input = { mode: 'transfem', modes: { transfem: { events: [{ timeH: 5 }] } }, events: [{ timeH: 5 }] }
    const { payload, skipped } = convertForeignPayload(input, 'oyama')
    assert.deepEqual(payload, input, 'byte-identical: converting a shape that already matches is where divergence starts')
    assert.deepEqual(skipped, {})
})

// ── Featherline: a real round trip ───────────────────────────────────────────

const MAGIC = 'HRTBKP1'
const enc = new TextEncoder()

/** Build a v3 envelope exactly as BackupCrypto.kt writes one. */
function buildFeatherlineFile(jsonText, password, { iterations = 3, memoryKib = 65536, parallelism = 1 } = {}) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const hashLength = 32
    const raw = enc.encode(jsonText)

    const header = new Uint8Array(37 + salt.length + nonce.length)
    const dv = new DataView(header.buffer)
    let at = 0
    for (const ch of MAGIC) header[at++] = ch.charCodeAt(0)
    header[at++] = 3           // container version
    header[at++] = 2           // KDF: Argon2id
    header[at++] = 1           // cipher: AES-256-GCM
    header[at++] = 1           // compression: gzip
    dv.setUint32(at, 0); at += 4          // uncompressed length, high word
    dv.setUint32(at, raw.length); at += 4 // …low word
    dv.setInt32(at, iterations); at += 4
    dv.setInt32(at, memoryKib); at += 4
    dv.setInt32(at, parallelism); at += 4
    dv.setInt32(at, hashLength); at += 4
    header[at++] = salt.length
    header[at++] = nonce.length
    header.set(salt, at); at += salt.length
    header.set(nonce, at); at += nonce.length

    return (async () => {
        const compressed = new Uint8Array(await new Response(
            new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')),
        ).arrayBuffer())
        const keyBytes = await argon2id({
            password, salt, parallelism, iterations, memorySize: memoryKib, hashLength, outputType: 'binary',
        })
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
        const ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce, additionalData: header }, key, compressed,
        ))
        const file = new Uint8Array(header.length + ct.length)
        file.set(header, 0)
        file.set(ct, header.length)
        return file
    })()
}

const sampleSnapshot = JSON.stringify({
    snapshotVersion: 6,
    app: { packageName: 'com.mkx.hrttracker' },
    userProfile: { weightKg: 70.5 },
    medicines: [
        { uuid: 'm1', preparationType: 'PILL', strengthMgPerTablet: 2, medicationKey: 'ESTRADIOL_VALERATE' },
        { uuid: 'm2', preparationType: 'IMPORTED_INJECTION', strengthMgPerVial: 5, medicationKey: 'ESTRADIOL_ENANTHATE' },
        // A real export's value: the strength is reconstructed rather than stored, so
        // a 12.5 mg tablet arrives carrying float noise. Taken verbatim from a backup
        // so the rounding is tested against the thing it exists for.
        { uuid: 'm3', preparationType: 'PILL', strengthMgPerTablet: 12.499934062706513, medicationKey: 'CYPROTERONE_ACETATE' },
    ],
    medicationLogs: [
        { uuid: 'd1', medicineUuid: 'm1', applicationType: 'SUBLINGUAL', count: 1, appliedAtEpochMillis: 1735689600000 },
        { uuid: 'd2', medicineUuid: 'm1', applicationType: 'SUBLINGUAL', tabletFractionNumerator: 1, tabletFractionDenominator: 2, count: 1, appliedAtEpochMillis: 1735776000000 },
        { uuid: 'd3', medicineUuid: 'm2', applicationType: 'INJECTION', count: 1, appliedAtEpochMillis: 1735862400000 },
        { uuid: 'd4', medicineUuid: 'm2', applicationType: 'SOMETHING_WE_DO_NOT_SUPPORT', count: 1, appliedAtEpochMillis: 1735948800000 },
        { uuid: 'd5', medicineUuid: 'm3', applicationType: 'ORAL', count: 1, appliedAtEpochMillis: 1736035200000 },
    ],
    bloodTestPanels: [
        { uuid: 'p1', collectedAtInstantEpochMillis: 1735689600000, results: [
            { builtinAnalyteKey: 'e2', value: 367.1, unitSnapshot: 'pmol_l' },
            { builtinAnalyteKey: 'prl', value: 210, unitSnapshot: 'ng_ml' },
        ] },
        { uuid: 'p2', collectedAtInstantEpochMillis: 1735776000000, results: [
            { builtinAnalyteKey: 'alt', value: 22, unitSnapshot: 'u_l' },
        ] },
    ],
})

const ROUND_TRIP_PASSWORD = 'correct horse battery staple'

await checkAsync('a Featherline envelope decrypts back to its exact snapshot', async () => {
    const file = await buildFeatherlineFile(sampleSnapshot, ROUND_TRIP_PASSWORD)
    assert.equal(isFeatherlineBackup(file), true)
    const json = await decryptFeatherline(file, ROUND_TRIP_PASSWORD)
    assert.equal(json, sampleSnapshot, 'byte-for-byte: gzip and the header AAD must both be right')
})

await checkAsync('a wrong password is refused, and refused as a FeatherlineError', async () => {
    const file = await buildFeatherlineFile(sampleSnapshot, ROUND_TRIP_PASSWORD)
    await assert.rejects(
        () => decryptFeatherline(file, 'not the password'),
        (e) => e instanceof FeatherlineError,
    )
})

await checkAsync('tampering with the header fails the auth check', async () => {
    const file = await buildFeatherlineFile(sampleSnapshot, ROUND_TRIP_PASSWORD)
    // Flip the declared Argon2 time cost. The header is authenticated data, so this
    // must fail rather than derive a wrong key and decrypt to noise.
    file[19] = 4
    await assert.rejects(() => decryptFeatherline(file, ROUND_TRIP_PASSWORD))
})

await checkAsync('the snapshot maps to doses, labs and weight', async () => {
    const json = await decryptFeatherline(await buildFeatherlineFile(sampleSnapshot, ROUND_TRIP_PASSWORD), ROUND_TRIP_PASSWORD)
    const mapped = mapFeatherlineSnapshot(json)

    assert.equal(mapped.weight, 70.5)

    const byId = Object.fromEntries(mapped.events.map((e) => [e.id, e]))
    assert.equal(byId.d1.doseMG, 2, 'a whole 2 mg tablet')
    assert.equal(byId.d1.ester, 'EV')
    assert.equal(byId.d1.route, 'sublingual')
    assert.equal(byId.d2.doseMG, 1, 'a half tablet is half the strength')
    assert.equal(byId.d3.doseMG, 5, 'an imported injection stores its administered mg')
    assert.equal(byId.d3.ester, 'EN')
    assert.equal(byId.d5.doseMG, 12.5, 'float-reconstruction noise in the source is trimmed')
    assert.notEqual(byId.d5.doseMG, 12.499934062706513, 'and the raw value is not what reaches the timeline')
    assert.equal(Object.keys(byId).length, 4, 'the unsupported route is dropped')

    assert.equal(mapped.skipped.doses, 1)
    assert.ok(mapped.skipped.reasons.some((r) => r.includes('unsupported route')))

    const e2 = mapped.labResults.find((l) => l.id === 'p1')
    assert.equal(e2.concValue, 367.1)
    assert.equal(e2.unit, 'pmol/l')
    assert.equal(e2.prolactin, 210, 'monitoring values join the same draw')

    const alt = mapped.labResults.find((l) => l.id === 'p2')
    assert.equal(alt.monitoringOnly, true, 'a monitoring-only panel must not read as an E2 of zero')
    assert.equal(alt.alt, 22)
})

await checkAsync('epoch ms converts to hours since 1970', async () => {
    const json = await decryptFeatherline(await buildFeatherlineFile(sampleSnapshot, ROUND_TRIP_PASSWORD), ROUND_TRIP_PASSWORD)
    const mapped = mapFeatherlineSnapshot(json)
    // 1735689600000 ms = 2025-01-01T00:00:00Z = 482136 h
    assert.equal(mapped.events.find((e) => e.id === 'd1').timeH, 482136)
})

check('a non-Featherline file is refused before any KDF work', async () => {
    assert.equal(isFeatherlineBackup(new Uint8Array([0x7b, 0x22, 0x61])), false, 'a JSON file must not match')
})

check('another app\'s backup is refused by its package name', async () => {
    assert.throws(
        () => mapFeatherlineSnapshot(JSON.stringify({ app: { packageName: 'com.someone.else' } })),
        (e) => e instanceof FeatherlineError,
    )
})

console.log(`\n${pass} checks passed${process.exitCode ? ' (with failures)' : ''}`)
