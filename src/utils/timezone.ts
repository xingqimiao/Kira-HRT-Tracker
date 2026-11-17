/**
 * The account's clock, for every question that starts with "today".
 *
 * Two devices in different time zones used to answer "today" differently: the
 * Home card's anti-androgen reading called `Date#getFullYear` on whatever zone
 * the viewer's OS reported, while a plan carried the offset of the device that
 * happened to save it. The same account therefore showed 12.5 mg on a phone in
 * Taipei and "13 hours ago" on a laptop in New York, and the overdue banner —
 * and the push that mirrors it — disagreed with itself.
 *
 * One zone per account, stored in the synced settings bag (`app-timezone`), is
 * the only thing both sides can agree on. Everything that needs a day boundary
 * converts through here.
 */

/** The zone an account gets before anyone has said otherwise — the project's own. */
export const DEFAULT_TIME_ZONE = 'Asia/Taipei';

/** This device's IANA zone, used only to seed the account's value. */
export function deviceTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
    } catch {
        return DEFAULT_TIME_ZONE;
    }
}

/** Whether `Intl` will accept the name, so a bad synced value cannot poison a render. */
export function isTimeZone(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
    const cached = formatters.get(zone);
    if (cached) return cached;
    // `h23` keeps midnight as 00 rather than 24, which `hour12: false` alone does
    // not guarantee in every ICU build.
    const made = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    formatters.set(zone, made);
    return made;
}

export interface WallClock {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

/** The wall clock `zone` shows at `atMs`. Month is 1-based, like a person reads it. */
export function wallClockIn(zone: string, atMs: number): WallClock {
    const parts = formatterFor(zone).formatToParts(new Date(atMs));
    const get = (type: Intl.DateTimeFormatPartTypes): number => {
        const part = parts.find((p) => p.type === type);
        return part ? Number(part.value) : 0;
    };
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
        second: get('second'),
    };
}

/**
 * UTC offset of `zone` at `atMs`, in `Date#getTimezoneOffset()` units: minutes
 * to add to local wall clock to get UTC, so east-of-UTC is negative (Taipei is
 * -480). `medPlan`'s day arithmetic is written against exactly that sign.
 *
 * Resolved for the instant rather than the zone, so a plan is not shifted by an
 * hour on the two DST days of the year.
 */
export function utcOffsetMinutes(zone: string, atMs: number): number {
    const wall = wallClockIn(zone, atMs);
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    // Seconds precision: the parts carry no milliseconds, so compare like for like.
    const whole = Math.floor(atMs / 1000) * 1000;
    return Math.round((whole - asUtc) / 60_000);
}

/**
 * The calendar day `zone` is on at `atMs`, as `Y-M-D`.
 *
 * Unpadded, matching the key the anti-androgen reading has always compared
 * against — it is only ever tested for equality, never parsed or sorted.
 */
export function dayKeyIn(zone: string, atMs: number): string {
    const { year, month, day } = wallClockIn(zone, atMs);
    return `${year}-${month}-${day}`;
}

/**
 * The instant at which `zone` shows the wall clock `y-m-d h:min`.
 *
 * The inverse of `wallClockIn`, and what turns a plan's `firstHour`/`firstMinute`
 * into an epoch. Two passes over the offset: the first is read at the wall clock
 * itself, which may land on the wrong side of a DST change, so the second reads it
 * at the instant the first guess produced.
 */
export function zonedTimeToEpoch(
    zone: string,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
): number {
    const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const first = wall + utcOffsetMinutes(zone, wall) * 60_000;
    return wall + utcOffsetMinutes(zone, first) * 60_000;
}

/**
 * The account's zone, for callers that cannot be handed it: the stored value
 * when the account has one, this device's otherwise.
 *
 * Kept out of `appSettings` so `logic.ts` (which the server also imports) can
 * reach it without dragging the browser storage layer into the server build.
 */
export function resolveTimeZone(stored: string | null | undefined): string {
    return isTimeZone(stored) ? stored : deviceTimeZone();
}
