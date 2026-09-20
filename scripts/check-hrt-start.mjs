/**
 * Runnable check for the intro's start-date answer.
 *
 *   node --experimental-transform-types scripts/check-hrt-start.mjs
 *
 * The day count is the only arithmetic behind the account page's "HRT started N
 * days ago" line, and the two ways it can be quietly wrong are worth a check: an
 * impossible date that the shape test accepts (2024-02-31 parses as a day in some
 * engines), and a DST shift turning a whole-day difference into one day too few or
 * too many. Both are cheap to assert and neither shows up in a screenshot.
 *
 * Local-midnight anchors throughout: `hrtDaysSince` compares local midnights, so a
 * test written against UTC timestamps would pass or fail on the machine's zone.
 */
import assert from 'node:assert/strict'

const { normalizeHrtStartDate, hrtDaysSince } = await import('../src/utils/hrtStart.ts')

const results = []
function check(name, fn) {
    try { fn(); results.push(['pass', name]) }
    catch (error) { results.push(['fail', name, error.message]) }
}

const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime()

// 1. A well-formed date is kept verbatim.
check('a plain date survives normalisation unchanged', () => {
    assert.equal(normalizeHrtStartDate('2024-01-15'), '2024-01-15')
})

// 2. The shape test alone cannot reject 2024-02-31; the parser must.
check('an impossible calendar date is rejected', () => {
    assert.equal(normalizeHrtStartDate('2024-02-31'), null)
    assert.equal(normalizeHrtStartDate('2023-02-29'), null)
})

// 3. Anything that is not the stored shape is not a date — including the formats a
//    different build might produce, and a non-string.
check('anything off-shape is rejected', () => {
    for (const bad of ['', '2024/01/15', '20240115', '2024-1-5', 20240115, null, undefined, {}]) {
        assert.equal(normalizeHrtStartDate(bad), null, `${String(bad)} should not be a date`)
    }
})

// 4. Whole days, counted from midnight to midnight.
check('days are whole days between local midnights', () => {
    assert.equal(hrtDaysSince('2024-01-15', at(2024, 1, 15, 23)), 0)
    assert.equal(hrtDaysSince('2024-01-15', at(2024, 1, 16, 0)), 1)
    assert.equal(hrtDaysSince('2024-01-15', at(2024, 1, 16, 23)), 1)
    assert.equal(hrtDaysSince('2024-01-15', at(2026, 9, 21)), 980)
})

// 5. A start date in the future is not a negative count — the line is simply not shown.
check('a future start date yields no count', () => {
    assert.equal(hrtDaysSince('2024-01-15', at(2024, 1, 14, 23)), null)
})

// 6. The DST trap: those days are 23 or 25 hours long, and a floor would lose one.
check('a DST-shortened span still counts whole days', () => {
    assert.equal(hrtDaysSince('2024-03-09', at(2024, 3, 11, 1)), 2)
    assert.equal(hrtDaysSince('2024-11-02', at(2024, 11, 5, 1)), 3)
})

// 7. A skipped answer is '', and the line must not render for it.
check('an empty answer yields no count', () => {
    assert.equal(hrtDaysSince(''), null)
    assert.equal(hrtDaysSince(undefined), null)
})

for (const [status, name, detail] of results) {
    console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const failed = results.filter(([s]) => s === 'fail').length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
