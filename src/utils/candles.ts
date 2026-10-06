/**
 * OHLC aggregation for the chart's candle (K线) view.
 *
 * The curve being read is a *continuous estimate*, not a sequence of trades:
 * "open" is the model's value where the bucket begins and "close" is where it
 * ends, so a candle is a range summary of one stretch of the simulation rather
 * than a market fact. What it buys the reader is the daily (or hourly) peak and
 * trough at a glance, which a single line hides inside its thickness.
 *
 * Buckets follow the **local calendar**, not epoch hours — the same rule
 * DoseHeatmap keeps to. A UTC-aligned "day" would open at 08:00 for a UTC+8
 * account, and every candle on the chart would disagree with the date labels
 * underneath it by eight hours.
 */

export interface Candle {
    /** Bucket start, ms — aligned to the local calendar (local midnight + n × interval). */
    t0: number;
    /** Bucket end, exclusive. */
    t1: number;
    open: number;
    close: number;
    high: number;
    low: number;
}

/** A point on the curve: absolute ms and the (already calibrated) value. */
export interface CurvePoint {
    t: number;
    v: number;
}

/**
 * Candle intervals the chart knows how to label, in hours, ascending.
 *
 * The steps a trading chart offers: hourly steps up to a day, then the day
 * multiples a K-line reader actually names (三日, 周) — not 2-day candles,
 * which have no name to disclose under. Beyond a week the resolution keeps
 * doubling (see `resolveCandleIntervalH`), staying whole days so the buckets
 * keep aligning to local midnights.
 */
export const CANDLE_LADDER_H: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 24, 72, 168];

/** The granularity the user picked, in hours: 1 (小时K) or 24 (日K). */
export type CandleBaseH = 1 | 24;

/** How many candles one plot may hold before the interval has to coarsen. */
export const MAX_CANDLES = 200;

/**
 * The interval actually drawn: the smallest ladder step of at least `baseH`
 * that fits the span within `maxCandles` candles.
 *
 * The requested base is a floor, never a ceiling — a finer resolution than the
 * user asked for would invent structure the data does not show. Past the ladder
 * the week keeps doubling (2, 4, 8 … weeks), staying whole days so the buckets
 * keep aligning to local midnights.
 */
export function resolveCandleIntervalH(baseH: CandleBaseH, spanMs: number, maxCandles = MAX_CANDLES): number {
    const hours = spanMs / 3600000;
    for (const step of CANDLE_LADDER_H) {
        if (step >= baseH && hours / step <= maxCandles) return step;
    }
    let step = CANDLE_LADDER_H[CANDLE_LADDER_H.length - 1];
    while (hours / step > maxCandles) step *= 2;
    return step;
}

/** Local midnight of the day `t` falls on, through the calendar so a DST
 *  boundary cannot slide the bucket an hour off the wall clock. */
const startOfDay = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Local midnight of 2024-01-01, a Monday — the anchor DoseHeatmap's grid uses
 *  too. Multi-day buckets count whole days back from here, so 周K opens on a
 *  Monday like every weekly chart the app's readers know. */
const MONDAY_EPOCH = new Date(2024, 0, 1).getTime();

/**
 * Aggregate sorted-or-not points into OHLC buckets of `intervalH` hours.
 *
 * A stretch with no samples produces no candle — a gap in the records must not
 * grow a body of its own, and the next bucket's open is its own first sample,
 * never a value carried across the gap.
 */
export function buildCandles(points: CurvePoint[], intervalH: number): Candle[] {
    if (points.length === 0) return [];
    const sorted = [...points].sort((a, b) => a.t - b.t);

    const stepMs = intervalH * 3600000;
    const multiDay = intervalH > 24;
    const daysPerBucket = multiDay ? intervalH / 24 : 0;
    if (multiDay && !Number.isInteger(daysPerBucket)) return [];

    const out: Candle[] = [];
    let current: Candle | null = null;

    for (const { t, v } of sorted) {
        const midnight = startOfDay(t);
        let t0: number;
        if (multiDay) {
            // Whole days back to the anchor Monday; `round` snaps across DST,
            // where a "day" is 23 or 25 hours but still exactly one day.
            const daysFromAnchor = Math.round((midnight - MONDAY_EPOCH) / 86400000);
            const back = daysFromAnchor - Math.floor(daysFromAnchor / daysPerBucket) * daysPerBucket;
            const d = new Date(midnight);
            t0 = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
        } else {
            t0 = midnight + Math.floor((t - midnight) / stepMs) * stepMs;
        }

        if (!current || current.t0 !== t0) {
            current = { t0, t1: t0 + stepMs, open: v, close: v, high: v, low: v };
            out.push(current);
        } else {
            if (v > current.high) current.high = v;
            if (v < current.low) current.low = v;
            current.close = v;
        }
    }
    return out;
}
