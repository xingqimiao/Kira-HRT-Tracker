import { EVENT_TIME_H_MAX, EVENT_TIME_H_MIN } from '../../logic';

/**
 * The private journal: one piece of free text per entry, and what may enter it.
 *
 * It used to carry five 0–5 experience scales and a symptom checklist. Both are
 * gone by request — the scales were self-ratings that nothing derived from, and the
 * checklist made a person choose from someone else's words before they could write
 * their own. What is left is the thing the log was always for: what the user wrote,
 * and when.
 *
 * Everything else about an entry is transport rather than content. `id` and `timeH`
 * are how it is stored and ordered; `updatedAt` is the stamp sync's newest-wins
 * compares. Only `note` is the record.
 */

/** How much text one entry may hold — long enough for a bad day, bounded for storage. */
const NOTE_MAX_LENGTH = 2000;

export interface JournalEntry {
    id: string;
    /** Hours since epoch, the same unit dose and lab records use. */
    timeH: number;
    /** Epoch ms of the last edit — what sync's newest-wins compares. */
    updatedAt?: number;
    /** The entry itself. An entry with no words is not stored at all. */
    note: string;
}

/**
 * Keep only entries this build understands, in a bounded number.
 *
 * Used on every path that crosses storage this device does not control — a file
 * import, a cloud sync, a hand-edited backup — for the same reason the dose
 * sanitisers exist: a malformed payload must not wedge the store. An entry without
 * a usable id or time is dropped rather than defaulted, because a note filed at the
 * wrong time silently reorders the log it was meant to appear in. Empty text is
 * dropped for the same reason the form refuses it: a row that says nothing is not a
 * record, and letting one through would put a blank line in the middle of a log.
 *
 * The text is kept as written, whitespace and all, up to the ceiling — trimming a
 * person's words on the way to storage is not this module's call.
 */
export function sanitizeJournalEntries(raw: unknown, max = 20000): JournalEntry[] {
    if (!Array.isArray(raw)) throw new Error('Invalid format');
    if (raw.length > max) throw new Error('Too many entries');
    const out: JournalEntry[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const src = item as Record<string, unknown>;
        const id = typeof src.id === 'string' && src.id !== '' ? src.id : null;
        const timeH = Number(src.timeH);
        if (!id) continue;
        if (!Number.isFinite(timeH) || timeH < EVENT_TIME_H_MIN || timeH > EVENT_TIME_H_MAX) continue;
        if (typeof src.note !== 'string' || src.note.trim() === '') continue;

        const entry: JournalEntry = { id, timeH, note: src.note.slice(0, NOTE_MAX_LENGTH) };
        const stamp = Number(src.updatedAt);
        if (Number.isFinite(stamp) && stamp > 0) entry.updatedAt = stamp;
        out.push(entry);
    }
    return out;
}
