/**
 * Does the new `format` field, or an imported foreign record, break cloud sync?
 *
 *   node --experimental-transform-types scripts/check-sync-safety.mjs
 *
 * The concern is specific and worth a check rather than a reading: `buildExportPayload`
 * is shared by file export AND cloud sync, so a field added for the file protocol
 * could, in principle, travel to the server or trip a validator. This asserts it
 * does not, along the two functions that actually touch the payload.
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// `syncMerge.ts` imports the app's `logic.ts` by extensionless path — a bundler
// convention, not a Node one — so the same resolve hook the other checks use fills
// the extension in. See scripts/check-sync-merge.mjs.
register(pathToFileURL('./scripts/lib/ts-extension-hook.mjs'), pathToFileURL('./'))

const { normalizeSyncState } = await import('../src/utils/syncMerge.ts')
const { payloadToRecords } = await import('../src/services/recordDocs.ts')
const { convertForeignPayload } = await import('../src/utils/foreignImport.ts')

let pass = 0
const check = (name, fn) => {
    try { fn(); pass++; console.log(`ok    ${name}`) }
    catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1 }
}

/** A payload shaped exactly as `buildExportPayload` writes one now. */
const payload = () => ({
    format: 'kira-hrt',
    meta: { version: 3, exportedAt: '2026-01-01T00:00:00.000Z' },
    mode: 'transfem',
    weight: 62,
    modes: {
        transfem: {
            events: [{ id: 'e1', timeH: 482136, route: 'sublingual', ester: 'EV', doseMG: 2, extras: { sublingualTier: 1 } }],
            labResults: [{ id: 'l1', timeH: 482136, concValue: 367.1, unit: 'pmol/l' }],
            doseTemplates: [], quickDoses: [], journal: [], deletions: {},
        },
        transmasc: { events: [], labResults: [], doseTemplates: [], quickDoses: [], journal: [], deletions: {} },
    },
    events: [{ id: 'e1', timeH: 482136, route: 'sublingual', ester: 'EV', doseMG: 2, extras: { sublingualTier: 1 } }],
    labResults: [{ id: 'l1', timeH: 482136, concValue: 367.1, unit: 'pmol/l' }],
    doseTemplates: [],
    pkParams: null,
    appState: { settings: {} },
})

check('normalizeSyncState ignores the new format field', () => {
    const state = normalizeSyncState(payload())
    assert.ok(!('format' in state), 'a sync state has no place for it — it must not be carried')
    // And the records it *should* read still land.
    assert.equal(state.modes.transfem.events.length, 1)
    assert.equal(state.modes.transfem.labResults.length, 1)
    assert.equal(state.weight, 62)
})

check('payloadToRecords never reads the root format field', () => {
    const docs = payloadToRecords(payload())
    assert.ok(docs.length >= 2, 'the records still split out')
    for (const doc of docs) {
        // Every doc is a record; the protocol identifier is not a record and has no
        // category to be one.
        assert.ok(['dose', 'lab', 'setting'].includes(doc.category), `unexpected category ${doc.category}`)
        assert.notEqual(doc.id, 'format')
    }
    assert.ok(!docs.some((d) => JSON.stringify(d.data ?? {}).includes('kira-hrt')), 'the identifier does not ride inside a record either')
})

check('a foreign-imported payload normalises to the same sync state as a native one', () => {
    // The decisive property: after conversion, sync cannot tell the record came from
    // another app. If it could, a foreign import would sync differently from a native
    // one — which is exactly the failure this check exists to rule out.
    const transmtf = convertForeignPayload(
        { weight: 62, events: [{ id: 'e1', timeH: 482136, route: 'sublingual', ester: 'EV', doseMG: 2 }], labResults: [], gelProducts: [{ id: 1000 }] },
        'transmtf',
    ).payload

    const fromForeign = normalizeSyncState({ ...transmtf, format: 'kira-hrt' })
    const fromNative = normalizeSyncState(payload())

    assert.equal(fromForeign.modes.transfem.events.length, fromNative.modes.transfem.events.length)
    assert.equal(fromForeign.modes.transfem.events[0].ester, fromNative.modes.transfem.events[0].ester)
    assert.equal(fromForeign.weight, fromNative.weight)
    assert.ok(!('gelProducts' in fromForeign), 'the skipped catalogue cannot reach sync')
})

check('a custom gel product id does not make the record unsyncable', () => {
    // A record carrying `gelProductId: 1500` (no catalogue entry here) must still
    // normalise. The engine resolves an unknown id to the first preset rather than
    // throwing, so the record syncs with its dose/route/site intact.
    const withCustomGel = normalizeSyncState({
        format: 'kira-hrt',
        events: [{ id: 'g1', timeH: 482136, route: 'gel', ester: 'E2', doseMG: 1.5, extras: { gelProductId: 1500, gelSite: 1 } }],
    })
    assert.equal(withCustomGel.modes.transfem.events.length, 1)
    assert.equal(withCustomGel.modes.transfem.events[0].extras.gelProductId, 1500)
})

console.log(`\n${pass} checks passed${process.exitCode ? ' (with failures)' : ''}`)
