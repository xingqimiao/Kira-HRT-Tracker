/**
 * The date a person's HRT started, as an account-scoped setting.
 *
 * Stored as the plain `YYYY-MM-DD` string an `<input type="date">` produces, and
 * carried in the settings bag like the calibration preferences — so it rides
 * sync and export instead of dying with this browser's localStorage.
 *
 * Its only consumer is one line on the account page ("HRT started N days ago"),
 * which is why the two questions below are the whole module: is this a date at
 * all, and how many whole days ago was it.
 */

/** `YYYY-MM-DD`, or null for anything else — a future build's format included. */
export function normalizeHrtStartDate(raw: unknown): string | null {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    // The shape test cannot see an impossible day: `Date.parse('2024-02-31')`
    // silently rolls over to 2 March rather than returning NaN, so the parsed
    // components are compared back to the written ones. UTC throughout, so this
    // validity check cannot be shifted by the reader's timezone the way the
    // local-midnight day count below deliberately is.
    const [y, m, d] = raw.split('-').map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
        ? raw
        : null;
}

/**
 * Whole days from the start date to `now`, or null when the date is unusable or
 * still ahead of us. Both ends sit at local midnight and the difference is
 * rounded, so a DST shift cannot turn one day into none or into two.
 */
export function hrtDaysSince(raw: unknown, now: number = Date.now()): number | null {
    const date = normalizeHrtStartDate(raw);
    if (!date) return null;
    const start = new Date(`${date}T00:00:00`).getTime();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const days = Math.round((today.getTime() - start) / 86_400_000);
    return days >= 0 ? days : null;
}

/**
 * `Date` → local-time `YYYY-MM-DD`, the shape `hrtStartDate` is stored in.
 *
 * Local, not UTC: the date picker hands back a local midnight, and
 * `toISOString()` would shift it a day backwards for anyone east of Greenwich —
 * which is the whole readership. The intro and the account page both write
 * through this, so the two cannot disagree about what "the 15th" means.
 */
export function toYmd(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The inverse. Falls back to today rather than an Invalid Date, so a picker
 *  opened on a malformed value still has something to show. */
export function fromYmd(value: string): Date {
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
