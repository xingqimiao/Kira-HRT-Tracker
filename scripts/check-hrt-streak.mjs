/**
 * Runnable check for the third-day streak rule.
 *
 *   node scripts/check-hrt-streak.mjs
 *
 * The note fires on one day only — the third of a consecutive run — and the two
 * ways the rule can be quietly wrong both matter:
 *
 *   - it fires on a day that is not the third (a run of two, a run of ten, a gap
 *     in the middle), and the note becomes noise on a day it was not earned;
 *   - it fails to fire on the third, and a small kindness is simply never seen.
 *
 * Invocation follows check-hrt-milestone.mjs next door: `node` runs the `.ts`
 * import directly through type stripping, so no build step and no test runner.
 * Node 22.6+.
 */
import assert from 'node:assert/strict'

const { isThirdDayStreak, consecutiveRunEndingOn } = await import('../src/utils/hrtStreak.ts')

const results = []
function check(name, fn) {
    try { fn(); results.push(['pass', name]) }
    catch (error) { results.push(['fail', name, error.message]) }
}

/** A run of consecutive days ending on `end`, as a Set, going back `n` days. */
const runEnding = (end, n) => {
    const set = new Set()
    const cursor = new Date(`${end}T12:00:00`)
    for (let i = 0; i < n; i++) {
        const k = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
        set.add(k)
        cursor.setDate(cursor.getDate() - 1)
    }
    return set
}

const TODAY = '2026-09-22'

check('two days already recorded, then today — fires', () => {
    // The user's own case: Monday and Tuesday logged, a record added on Wednesday.
    const days = new Set(['2026-09-21', '2026-09-22', '2026-09-23'])
    assert.equal(isThirdDayStreak(days, '2026-09-23'), true)
})

check('a run of exactly three — fires', () => {
    assert.equal(isThirdDayStreak(runEnding(TODAY, 3), TODAY), true)
})

check('only today and yesterday — does not fire', () => {
    const two = new Set([TODAY, '2026-09-21'])
    assert.equal(isThirdDayStreak(two, TODAY), false)
})

check('a longer run does not fire on its later days', () => {
    for (const n of [4, 5, 10, 100]) {
        assert.equal(isThirdDayStreak(runEnding(TODAY, n), TODAY), false, `run of ${n} fired`)
    }
})

check('a gap two days back breaks the run — does not fire', () => {
    const gapped = new Set([TODAY, '2026-09-21', '2026-09-19'])
    assert.equal(isThirdDayStreak(gapped, TODAY), false)
})

check('today missing from the set — does not fire', () => {
    // A set whose most recent day is yesterday: today was not recorded.
    assert.equal(isThirdDayStreak(runEnding('2026-09-21', 3), TODAY), false)
})

check('a record set that ends three days ago — does not fire today', () => {
    assert.equal(isThirdDayStreak(runEnding('2026-09-19', 3), TODAY), false)
})

check('the run walks a month boundary correctly', () => {
    const set = new Set(['2026-10-01', '2026-09-30', '2026-09-29'])
    assert.equal(consecutiveRunEndingOn(set, '2026-10-01'), 3)
    assert.equal(isThirdDayStreak(set, '2026-10-01'), true)
})

check('an unparseable day key counts nothing', () => {
    assert.equal(consecutiveRunEndingOn(new Set([TODAY]), 'nonsense'), 0)
})

for (const [status, name, detail] of results) {
    console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const failed = results.filter(([s]) => s === 'fail').length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
