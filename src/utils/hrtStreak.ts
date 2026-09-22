/**
 * The one-off "you have kept this up for three days" note.
 *
 * ── What it counts, and why exactly three ───────────────────────────────────
 *
 * The note congratulates a *run*, not a total: two consecutive days of records
 * followed by today's third. So the whole rule is "the run of consecutive days
 * that ends today is exactly three long".
 *
 * Exactly three, not three-or-more, is the deliberate half. Longer-than-three
 * would greet someone who has been logging for a month the first time this
 * ships — and would fire on every later day of a long run if the shown-flag
 * were ever lost. Exactly three makes the day it is meant for the only day it
 * can fire, the same way `milestoneFor` keys on the exact day.
 *
 * ── Why "ends today" and not "ends on the latest record" ─────────────────────
 *
 * The message says "today's self was recorded too" — so the run has to include
 * today's own local day, not merely the most recent day someone happened to log.
 * A back-filled record for last week, however many consecutive days it completes,
 * is not this morning's habit and should not draw the note. It also means an
 * existing record set whose tail happens to be three days fires nothing on
 * upgrade: today is not in it.
 */

/**
 * How many consecutive local days, counting back from `end`, are in `days`.
 *
 * `days` holds `YYYY-MM-DD` keys (see `toDayKey`) and `end` is one of them. The
 * walk steps a local calendar day at a time rather than subtracting 24h from a
 * timestamp: a midnight-anchored `Date` shifted by 86400000 lands on the wrong
 * day across a DST change, and noon-anchoring the intermediate value is what
 * keeps the step exactly one day.
 */
export function consecutiveRunEndingOn(days: Iterable<string>, end: string): number {
    const present = days instanceof Set ? days : new Set(days);
    let run = 0;
    const cursor = new Date(`${end}T12:00:00`);
    if (Number.isNaN(cursor.getTime())) return 0;

    while (true) {
        const key = `${String(cursor.getFullYear()).padStart(4, '0')}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        if (!present.has(key)) return run;
        run += 1;
        cursor.setDate(cursor.getDate() - 1);
    }
}

/**
 * Is `todayKey` the third consecutive day of recording?
 *
 * The caller supplies the day keys of every dose record and today's own key, so
 * the rule stays a pure function beside the two named constants, with no clock
 * or storage of its own.
 */
export function isThirdDayStreak(days: Iterable<string>, todayKey: string): boolean {
    return consecutiveRunEndingOn(days, todayKey) === 3;
}
