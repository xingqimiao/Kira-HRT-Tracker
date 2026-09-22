/**
 * Which milestone — if any — a day count lands on.
 *
 * The account page's "HRT started N days ago" line has two audiences: the
 * person who checks it every day, and the one who opens it on day 365. The
 * second deserves a moment; the first does not deserve confetti every morning.
 *
 * So the whole decision is one pure function beside the day count, and it
 * answers with a value rather than a boolean because the two milestones are not
 * interchangeable — 100 gets confetti, 365 gets the cake and its message, and a
 * day that is a multiple of both (36500 is the first) is the rarer one.
 *
 * Precedence is therefore by size, not by the order they are written in: the
 * cake outranks the confetti, because a person who reaches a round year should
 * be told so rather than shown the hundred-day effect for the hundredth time.
 */

/** What a milestone day celebrates. */
export type Milestone = 'confetti' | 'cake';

/**
 * Anything the milestone banner can show.
 *
 * `streak3` is not a day count and is not produced by `milestoneFor` — it is the
 * one-off third-day note (see `hrtStreak.ts`). It rides the same banner because
 * the user asked for "the same kind of banner as the birthday one, without the
 * cake", and the banner's shell, its measured height and its exit are exactly
 * what a second notice would otherwise have to rebuild. Widening the type here
 * is smaller than a second component and keeps one place that knows how a notice
 * enters and leaves.
 */
export type MilestoneNotice = Milestone | 'streak3';

/** The cadence each effect runs on, in days. */
export const CONFETTI_EVERY_DAYS = 100;
export const CAKE_EVERY_DAYS = 365;

/**
 * The milestone `days` falls on, or null for an ordinary day.
 *
 * Day 0 is deliberately not a milestone. "HRT 开始 0 天" is the day someone
 * answers the intro's question, which is already the moment they are having —
 * celebrating it would fire the effect for every existing user the first time
 * this ships, since their date is what puts them there. `days` is a whole
 * non-negative count from `hrtDaysSince`, and a null count (no date set, an
 * unusable one, a future one) is not a day at all.
 */
export function milestoneFor(days: number | null): Milestone | null {
    if (days === null || !Number.isInteger(days) || days <= 0) return null;
    if (days % CAKE_EVERY_DAYS === 0) return 'cake';
    if (days % CONFETTI_EVERY_DAYS === 0) return 'confetti';
    return null;
}

/**
 * Keep an armed milestone alive across a remount of the component that read it.
 *
 * ── The bug this exists for ──────────────────────────────────────────────────
 *
 * `pendingMilestone` is a one-shot: it answers "should we celebrate, and may I
 * be the one to claim it", and claiming means stamping today's date into
 * localStorage before returning. That makes it correct exactly once. The app
 * remounts the component holding it — `CoreSessionProvider` restores the
 * session and its children mount a second time — so the value was read on the
 * first mount, the stamp was written, and the second mount then read its own
 * stamp back, concluded the celebration had already happened, and returned ''.
 * The milestone fired on the only builds that do not remount: none of them.
 *
 * ── Why a module-level cell and not a ref ────────────────────────────────────
 *
 * A ref would be reset by the very remount it has to survive, which is the
 * bug and not the fix. The milestone is one value per *session*, not per
 * component instance, so the cell lives beside the rule that produces it and is
 * cleared when the milestone is taken. It is deliberately not persisted: the
 * "shown" stamp in storage is what stops a *reload* from replaying, and this
 * only stops a *remount* from dropping what the first read already claimed.
 */
let armed: { milestone: Milestone; days: number } | null = null;

/**
 * The milestone to celebrate this session, or null.
 *
 * `decide` is `pendingMilestone`'s answer — `<days>:<milestone>`, or '' — and is
 * only consulted when nothing is armed, so the storage read and the stamp it
 * writes happen once per session rather than once per mount.
 */
export function armMilestone(pending: string | undefined): { milestone: Milestone; days: number } | null {
    if (armed) return armed;
    if (!pending) return null;
    const [days, name] = pending.split(':');
    if (name !== 'cake' && name !== 'confetti') return null;
    const count = Number(days);
    if (!Number.isFinite(count)) return null;
    armed = { milestone: name, days: count };
    return armed;
}

/**
 * Drop the armed milestone.
 *
 * Called when the notice has been shown, so a later mount of the same session
 * does not replay it. Not called on unmount: the remount *is* the reason the
 * value is held here, and dropping it there would put the bug straight back.
 */
export function clearArmedMilestone(): void {
    armed = null;
}
