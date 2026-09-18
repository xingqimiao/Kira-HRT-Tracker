/**
 * Runnable check for the overview page's one-tap "add a saved dose" button.
 *
 * The conversion is the part that can be wrong without anyone noticing: a record
 * that lands with the right dose but without its `extras` looks correct in the
 * timeline and plots differently in the simulation, which is the one thing the
 * overview exists to show.
 *
 *   node --experimental-transform-types scripts/check-template-quick-add.mjs
 *
 * No browser, no model, no network — the module is pure, which is the reason this
 * check is cheap enough to be worth running every time.
 */
import assert from 'node:assert/strict'

const { templateToEvent } = await import('../src/utils/templateToEvent.ts')

const results = []
function check(name, fn) {
    try {
        fn()
        results.push(['pass', name])
    } catch (error) {
        results.push(['fail', name, error.message])
    }
}

// 1. A plain template lands at the given time, as a record of that template.
check('a plain template becomes a record at the given time', () => {
    const event = templateToEvent(
        { route: 'oral', ester: 'E2', doseMG: 2, extras: {} },
        'id-1',
        500_000,
    )
    assert.deepEqual(event, {
        id: 'id-1',
        route: 'oral',
        timeH: 500_000,
        doseMG: 2,
        ester: 'E2',
        extras: {},
    })
})

// 2. The extras are the whole reason templates are worth saving: a patch applied
//    without its wear duration self-completes at the wrong moment.
check('patch extras survive the conversion', () => {
    const extras = { releaseRateUGPerDay: 100, patchWearH: 84 }
    const event = templateToEvent(
        { route: 'patchApply', ester: 'E2', doseMG: 0, extras },
        'id-2',
        1,
    )
    assert.deepEqual(event.extras, extras, 'extras must be carried over')
})

// 3. Copied, not shared. One template is tapped every few days; if the record and
//    the template held the same object, editing either would change both.
check('extras are copied, not shared with the template', () => {
    const extras = { gelSite: 1 }
    const template = { route: 'gel', ester: 'E2', doseMG: 1.5, extras }
    const first = templateToEvent(template, 'id-3', 1)
    const second = templateToEvent(template, 'id-4', 2)
    assert.notEqual(first.extras, second.extras, 'each record needs its own object')
    first.extras.gelSite = 2
    assert.equal(extras.gelSite, 1, 'writing through a record must not touch the template')
    assert.equal(second.extras.gelSite, 1, 'and must not touch its sibling record')
})

// 4. A record is not an edit. `updatedAt` is stamped by the data layer on write;
//    carrying one over would let an old template out-rank a newer edit in sync.
check('no updatedAt is invented', () => {
    const event = templateToEvent(
        { route: 'sublingual', ester: 'E2', doseMG: 1, extras: { sublingualTier: 3 } },
        'id-5',
        10,
    )
    assert.equal('updatedAt' in event, false)
})

for (const [status, name, detail] of results) {
    console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const failed = results.filter(([status]) => status === 'fail').length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
