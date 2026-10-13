/**
 * Occurrence ledger for web medication reminders.
 *
 * The browser transport fires a reminder when a plan's due time passes without a
 * matching dose. With only in-memory memory of what it already showed, every page
 * reload re-fires the same reminder — the reported bug. This ledger records each
 * occurrence the moment it is about to be shown, keyed by plan id and the *due
 * instant*, so one occurrence is shown at most once for the life of the record.
 *
 * Identity is the due instant, not the calendar day, so nothing needs clearing at a
 * day boundary: tomorrow's due time is simply a different key. The ledger is pruned
 * by age and capped by size so it cannot grow without bound.
 *
 * Pure functions only — the caller owns where the JSON string is stored — so the
 * behaviour can be unit-checked without a browser or the notification plugin.
 */

/** Occurrences older than this are never reported again, so they can be forgotten. */
export const LEDGER_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** A backstop on size, in case of a long-running session or clock games. */
export const LEDGER_MAX_SIZE = 500;

/** One plan's specific due instant — stable across reloads and day rollovers. */
export function occurrenceKey(planId: string, dueMs: number): string {
    return `${planId}:${dueMs}`;
}

/** The due instant encoded in an occurrence key, or null when it is not one. */
export function keyDueMs(key: string): number | null {
    const i = key.lastIndexOf(':');
    if (i < 0) return null;
    const n = Number(key.slice(i + 1));
    return Number.isFinite(n) ? n : null;
}

/** Parse a stored ledger, discarding anything malformed rather than throwing. */
export function readLedger(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return [];
        return value.filter((k): k is string => typeof k === 'string' && keyDueMs(k) !== null);
    } catch { return []; }
}

export function serializeLedger(keys: string[]): string {
    return JSON.stringify(keys);
}

/** Drop occurrences outside the retention window, then cap to the newest. */
export function pruneLedger(
    keys: string[],
    nowMs: number,
    maxAgeMs = LEDGER_MAX_AGE_MS,
    maxSize = LEDGER_MAX_SIZE,
): string[] {
    const cutoff = nowMs - maxAgeMs;
    const kept = keys.filter((k) => { const due = keyDueMs(k); return due !== null && due >= cutoff; });
    if (kept.length <= maxSize) return kept;
    return [...kept].sort((a, b) => (keyDueMs(b) ?? 0) - (keyDueMs(a) ?? 0)).slice(0, maxSize);
}
