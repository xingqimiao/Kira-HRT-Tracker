export const DEFAULT_TIME_ZONE = 'UTC';

/** The current system zone, read fresh from the native bridge or browser. */
export function deviceTimeZone(): string {
    try {
        const native = (globalThis as { HrtTimeZone?: { current: () => string } }).HrtTimeZone?.current();
        const zone = native || Intl.DateTimeFormat().resolvedOptions().timeZone;
        return isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
    } catch {
        return DEFAULT_TIME_ZONE;
    }
}

/** Whether `Intl` will accept the name, so a bad synced value cannot poison a render. */
export function isTimeZone(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 64 || (value !== 'UTC' && !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) return false;
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

export interface TimeContext {
    deviceTimezone: string;
    nowUtcMs: number;
}

export function deviceTimeContext(nowUtcMs = Date.now()): TimeContext {
    return { deviceTimezone: deviceTimeZone(), nowUtcMs };
}

export function calendarDateIn(zone: string, instant: number): string {
    const { year, month, day } = wallClockIn(zone, instant);
    return [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

export function parseCalendarDate(value: unknown): [number, number, number] | null {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    const [year, month, day] = value.split('-').map(Number);
    return [year, month, day];
}

function calendarOrdinal([year, month, day]: [number, number, number]): number {
    const y = year - Number(month < 3);
    const m = month + (month < 3 ? 9 : -3);
    return 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)
        + Math.floor((153 * m + 2) / 5) + day;
}

export function calendarDaysBetween(from: string, to: string): number {
    const a = parseCalendarDate(from);
    const b = parseCalendarDate(to);
    if (!a || !b) throw new RangeError('Invalid calendar date');
    return calendarOrdinal(b) - calendarOrdinal(a);
}

export function addCalendarDays(date: string, days: number): string {
    const calendar = new Date(date + 'T00:00:00Z');
    calendar.setUTCDate(calendar.getUTCDate() + days);
    return calendar.toISOString().slice(0, 10);
}

function zonedCandidates(zone: string, wall: number): { instant: number; displacement: number }[] {
    const offsets = new Set([-36, 0, 36].map(hours => utcOffsetMinutes(zone, wall + hours * 3_600_000)));
    return [...offsets].map(offset => {
        const instant = wall + offset * 60_000;
        return { instant, displacement: (offset - utcOffsetMinutes(zone, instant)) * 60_000 };
    });
}

export function zonedTimeToEpoch(zone: string, year: number, month: number, day: number, hour: number, minute: number): number {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    return zonedCandidates(zone, wall).filter(candidate => candidate.displacement >= 0)
        .sort((a, b) => a.displacement - b.displacement || a.instant - b.instant)[0]?.instant ?? NaN;
}


export function parseLocalInstant(zone: string, value: string): number | null {
    const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(value);
    if (!match || !parseCalendarDate(match[1])) return null;
    const exact = zonedCandidates(zone, Date.parse(value + 'Z')).filter(candidate => candidate.displacement === 0);
    return exact.length === 1 ? exact[0].instant : null;
}

export function recordInstant(record: unknown): number {
    const value = record as { timeH?: unknown; timestamp_utc_ms?: unknown } | null;
    const utc = value?.timestamp_utc_ms;
    if (typeof utc === 'number' && Number.isFinite(utc)) return utc;
    const hours = value?.timeH;
    return typeof hours === 'number' ? hours * 3_600_000 : NaN;
}

export function originalTimeLabel(record: { timeH: number; timestamp_utc_ms?: number; recorded_tz?: string }, deviceTimezone: string, locale?: string): string | null {
    if (!isTimeZone(record.recorded_tz) || resolveZoneAlias(record.recorded_tz) === resolveZoneAlias(deviceTimezone)) return null;
    const time = recordInstant(record);
    return Number.isFinite(time) ? new Intl.DateTimeFormat(locale, {
        timeZone: record.recorded_tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(time) + ' · ' + record.recorded_tz : null;
}

function resolveZoneAlias(zone: string): string {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
}

export function withUtcTime<T extends { timeH: number; timestamp_utc_ms?: number }>(record: T): T {
    if (!Number.isFinite(record?.timestamp_utc_ms)) return record;
    const timeH = record.timestamp_utc_ms! / 3_600_000;
    return timeH === record.timeH ? record : { ...record, timeH };
}
