/**
 * Runnable check for the milestone rule.
 *
 *   node scripts/check-hrt-milestone.mjs
 *
 * The account page celebrates on a multiple of 100 days and on a multiple of
 * 365, and the two ways that rule can be quietly wrong both cost a person the
 * moment it exists for:
 *
 *   - an ordinary day that celebrates anyway — the effect becomes wallpaper and
 *     is ignored on the day it was meant for;
 *   - a milestone that does not — nobody ever reports a party that did not
 *     happen.
 *
 * The third case is the overlap: 365 is not a multiple of 100, but 36500 is a
 * multiple of both, and the cake has to win. Asserted directly rather than
 * argued about.
 *
 * Invocation style follows check-hrt-start.mjs, which is next door: `node` runs
 * the `.ts` import directly through type stripping, so no build step and no test
 * runner are involved. It needs Node 22.6+; that is the same floor the
 * neighbouring checks already set.
 */
import assert from 'node:assert/strict'

const { milestoneFor, CONFETTI_EVERY_DAYS, CAKE_EVERY_DAYS } = await import('../src/utils/hrtMilestone.ts')

const results = []
function check(name, fn) {
    try { fn(); results.push(['pass', name]) }
    catch (error) { results.push(['fail', name, error.message]) }
}

/** Every day count from 1 to `until`, so the boundaries are checked in context. */
const everyDayUpTo = (until) => {
    const milestones = new Map()
    for (let day = 1; day <= until; day += 1) {
        const milestone = milestoneFor(day)
        if (milestone !== null) milestones.set(day, milestone)
    }
    return milestones
}

// 1. The two asked-for days, and the one either side of each of them.
check('day 100 is confetti and its neighbours are not', () => {
    assert.equal(milestoneFor(99), null)
    assert.equal(milestoneFor(100), 'confetti')
    assert.equal(milestoneFor(101), null)
})

check('day 365 is the cake and its neighbours are not', () => {
    assert.equal(milestoneFor(364), null)
    assert.equal(milestoneFor(365), 'cake')
    assert.equal(milestoneFor(366), null)
})

// 2. The rule is a cadence, not two special cases: every multiple lands.
check('every multiple of 100 up to 1000 celebrates, and nothing else does', () => {
    const found = everyDayUpTo(1000)
    assert.deepEqual([...found.keys()], [100, 200, 300, 365, 400, 500, 600, 700, 730, 800, 900, 1000])
})

check('a long run finds exactly the multiples of 100 and 365', () => {
    const expected = new Set()
    for (let day = 1; day <= 5000; day += 1) {
        if (day % 365 === 0 || day % 100 === 0) expected.add(day)
    }
    assert.deepEqual([...everyDayUpTo(5000).keys()], [...expected].sort((a, b) => a - b))
})

// 3. The overlap. 36500 is the first day that is both, and the cake is the rarer
//    of the two — a round year should not be reported as a hundred-day mark.
check('the first day that is both is a cake, not confetti', () => {
    assert.equal(36500 % CONFETTI_EVERY_DAYS, 0, '36500 should be a multiple of 100 for this to test anything')
    assert.equal(36500 % CAKE_EVERY_DAYS, 0, '36500 should be a multiple of 365 for this to test anything')
    assert.equal(milestoneFor(36500), 'cake')
})

// 4. No day count means nothing to celebrate. `hrtDaysSince` returns null for an
//    absent or unusable date and for one still in the future, and the count is
//    zero on the very day the intro asks — answering the question is not a
//    milestone, and celebrating it would fire for every existing user on upgrade.
check('no day count, and day zero, celebrate nothing', () => {
    assert.equal(milestoneFor(null), null)
    assert.equal(milestoneFor(0), null)
})

check('a count that is not a whole day celebrates nothing', () => {
    assert.equal(milestoneFor(100.5), null)
    assert.equal(milestoneFor(Number.NaN), null)
    assert.equal(milestoneFor(Number.POSITIVE_INFINITY), null)
})

for (const [status, name, detail] of results) {
    console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const failed = results.filter(([s]) => s === 'fail').length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
