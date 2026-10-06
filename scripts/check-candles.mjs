/**
 * Runnable check for the chart's candle (K-line) aggregation.
 *
 *   node --experimental-transform-types scripts/check-candles.mjs
 *
 * The candles are an OHLC read of a continuous PK curve, and two ways for it
 * to be quietly wrong both matter:
 *
 *   - a bucket that does not start where the reader's calendar says it starts
 *     (an interval that drifts off local midnight puts the "day" boundary at
 *     08:00 for a UTC+8 account);
 *   - an interval that resolves finer than the window can draw, leaving the
 *     plot a solid mass of sub-pixel bodies.
 *
 * Invocation follows check-hrt-streak.mjs next door: `node` runs the `.ts`
 * import through type stripping, no build step and no test runner. Node 22.6+.
 */
import assert from 'node:assert/strict'

const { resolveCandleIntervalH, buildCandles, CANDLE_LADDER_H } = await import('../src/utils/candles.ts')

const results = []
function check(name, fn) {
    try { fn(); results.push(['pass', name]) }
    catch (error) { results.push(['fail', name, error.message]) }
}

const HOUR = 3600000
/** Local wall-clock date → ms. Constructor args are local, so the expectations
 *  below hold whatever timezone this machine runs in. */
const at = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime()
/** `n` half-hourly samples starting at `start`. */
const halfHoursFrom = (start, n) =>
    Array.from({ length: n }, (_, i) => ({ t: start + i * 0.5 * HOUR, v: 100 + i }))

// ── resolveCandleIntervalH ──────────────────────────────────────────────────

check('ladder is ascending and starts at 1h', () => {
    for (let i = 1; i < CANDLE_LADDER_H.length; i++) assert(CANDLE_LADDER_H[i] > CANDLE_LADDER_H[i - 1])
    assert.equal(CANDLE_LADDER_H[0], 1)
})

check('1h base on 7d stays 1h (168 candles fits)', () => {
    assert.equal(resolveCandleIntervalH(1, 7 * 24 * HOUR), 1)
})

check('1h base on 30d steps up, not a 720-candle mass', () => {
    const h = resolveCandleIntervalH(1, 30 * 24 * HOUR)
    assert.equal(h, 4) // 720/4 = 180 ≤ 200
})

check('1d base on 30d stays daily', () => {
    assert.equal(resolveCandleIntervalH(24, 30 * 24 * HOUR), 24)
})

check('1d base on a year coarsens to a named, whole-day interval', () => {
    const h = resolveCandleIntervalH(24, 365 * 24 * HOUR)
    assert(h % 24 === 0, `expected whole days, got ${h}h`)
    assert(h >= 24, `expected ≥ daily, got ${h}h`)
    assert((365 * 24) / h <= 200, `${h}h does not fit a year within 200 candles`)
})

check('resolved interval always divides the span into ≤ max candles', () => {
    for (const days of [7, 30, 90, 365, 3650]) {
        for (const base of [1, 24]) {
            const h = resolveCandleIntervalH(base, days * 24 * HOUR)
            assert((days * 24) / h <= 200 + 1e-9, `${days}d base ${base}h → ${h}h`)
        }
    }
})

check('resolved interval never coarser than the base', () => {
    assert.equal(resolveCandleIntervalH(24, 3 * 24 * HOUR), 24)
    assert.equal(resolveCandleIntervalH(1, 12 * HOUR), 1)
})

// ── buildCandles ────────────────────────────────────────────────────────────

check('empty points → no candles', () => {
    assert.deepEqual(buildCandles([], 24), [])
})

check('1h buckets open on the wall-clock hour', () => {
    // 2, 3 and 17 minutes past 14:00 → one bucket opening at 14:00.
    const t0 = at(2026, 5, 15, 14, 0)
    const pts = [
        { t: t0 + 2 * 60000, v: 10 },
        { t: t0 + 3 * 60000, v: 30 },
        { t: t0 + 17 * 60000, v: 20 },
    ]
    const [c] = buildCandles(pts, 1)
    assert.equal(c.t0, t0)
    assert.equal(c.open, 10)
    assert.equal(c.close, 20)
    assert.equal(c.high, 30)
    assert.equal(c.low, 10)
})

check('daily buckets align to local midnight, not UTC', () => {
    // Samples at 01:00 and 23:00 on two consecutive days, values rising.
    const pts = [
        { t: at(2026, 5, 15, 1), v: 5 },
        { t: at(2026, 5, 15, 13), v: 90 },
        { t: at(2026, 5, 15, 23), v: 50 },
        { t: at(2026, 5, 16, 2), v: 60 },
    ]
    const cs = buildCandles(pts, 24)
    assert.equal(cs.length, 2)
    assert.equal(cs[0].t0, at(2026, 5, 15))
    assert.equal(cs[1].t0, at(2026, 5, 16))
    assert.equal(cs[0].open, 5)
    assert.equal(cs[0].close, 50)
    assert.equal(cs[0].high, 90)
    assert.equal(cs[0].low, 5)
    assert.equal(cs[1].open, 60)
})

check('a day with no samples produces no candle', () => {
    const pts = [
        { t: at(2026, 5, 15, 9), v: 10 },
        { t: at(2026, 5, 17, 9), v: 20 }, // the 16th is missing entirely
    ]
    const cs = buildCandles(pts, 24)
    assert.equal(cs.length, 2)
    assert.equal(cs[1].t0, at(2026, 5, 17))
    assert.equal(cs[1].open, 20) // the gap must not leak a value across it
})

check('weekly buckets open on a Monday', () => {
    // 2026-06-04 is a Thursday. Ten daily samples from that day span the
    // Monday-opened weeks Jun 1–7 and Jun 8–14.
    const pts = Array.from({ length: 10 }, (_, i) => ({ t: at(2026, 5, 4 + i, 12), v: i }))
    const cs = buildCandles(pts, 168)
    assert.equal(cs.length, 2)
    assert.equal(cs[0].t0, at(2026, 5, 1))
    assert.equal(cs[0].close, 3) // the first week holds Jun 4–7 only
    assert.equal(cs[1].t0, at(2026, 5, 8))
    assert.equal(cs[1].close, 9)
})

check('unsorted input is tolerated (sorted internally)', () => {
    const pts = [
        { t: at(2026, 5, 15, 20), v: 3 },
        { t: at(2026, 5, 15, 8), v: 1 },
    ]
    const [c] = buildCandles(pts, 24)
    assert.equal(c.open, 1)
    assert.equal(c.close, 3)
})

check('single sample yields a candle', () => {
    const [c] = buildCandles([{ t: at(2026, 5, 15, 9), v: 42 }], 24)
    assert.equal(c.open, 42)
    assert.equal(c.close, 42)
    assert.equal(c.high, 42)
    assert.equal(c.low, 42)
})

let failed = 0
for (const [status, name, message] of results) {
    if (status === 'fail') { failed++; console.error(`FAIL ${name}\n     ${message}`) }
    else console.log(`pass ${name}`)
}
console.log(`${results.length - failed}/${results.length} checks pass`)
process.exit(failed ? 1 : 0)
