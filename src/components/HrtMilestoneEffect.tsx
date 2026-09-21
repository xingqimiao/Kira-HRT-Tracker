import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
/* reicon's own `cake`, re-exported under its own name by src/icons — the app's
   one place an icon is named. */
import { Cake } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { usePresence } from '../hooks/usePresence';
import type { Milestone } from '../utils/hrtMilestone';

/**
 * The milestone notice: a bar across the top of the window, plus confetti on the
 * hundred-day one.
 *
 * ── Why a bar, and why a custom one ──────────────────────────────────────────
 *
 * /material-3 has no banner component. Asked for one on the web, its documented
 * answer is a spec-aligned custom implementation built from tokens — and the
 * first thing that decides is whether this is a dialog or a banner. It is a
 * banner: an unprompted, page-level notice over a page someone came to use. So
 * it is **non-modal** — it does not dim the page, takes no shadow, holds
 * nothing focusable, never moves or traps focus, and cannot be dismissed
 * *instead of* the page. Nothing about it stands between the reader and the
 * account settings underneath, which a centred card did simply by looking like
 * something that had to be dealt with first.
 *
 * ── Colour: one paired tonal role ────────────────────────────────────────────
 *
 * background `primary-container`, foreground `on-primary-container` — a
 * *container/content pair*, which is the only form of colour M3 guarantees
 * contrast for. It is also this palette's own metaphor: the app tints a thing
 * with primary-container when it matters to the person it belongs to, and the
 * celebration is exactly that. `secondary-container` was the other candidate;
 * it is the app's cool accent and reads as informational here, which is the
 * wrong note for a party. The pair is also the one that survives the blue key
 * colour and both themes without a second rule, because both roles are redefined
 * together in each palette.
 *
 * ── What is not here ──────────────────────────────────────────────────────────
 *
 * No shadow (a tonal surface separates; that is how the rest of this app already
 * draws lines rather than drop shadows — see the rail's own edge), no display
 * type, no spring. M3 Expressive's spring physics are Compose-only; Material Web
 * is in maintenance and has none, so the entrance and exit are the legacy
 * transition tokens, which live in `index.css` next to every other curve this
 * app uses.
 *
 * ── Confetti covers the viewport, but the bar does not own it ────────────────
 *
 * The burst falls from the top edge of the screen, not out of the bar: a
 * full-width bar drifting crumbs in the same band the words are in would read as
 * damage to the bar, and the bar's own height is not where a celebration wants
 * to live. Covering the viewport also means the confetti and the bar cannot
 * disagree about where the top of the world is when the bar is pushed down by
 * the notch inset.
 *
 * ── Reduced motion ───────────────────────────────────────────────────────────
 *
 * Handled where the rest of the app handles it — a `prefers-reduced-motion`
 * block in `index.css` — so nothing here asks the media query itself. The bar
 * has no exit animation at all under that preference and drops out of the DOM
 * the moment it is done, which is what `usePresence` is told. **The text is
 * never conditional on any of this**: the bar renders for either milestone, and
 * the message matters more than the motion.
 */

/** How many pieces a confetti burst is. Enough to read as a burst; not a particle system. */
const CONFETTI_PIECES = 60;

/**
 * How long each notice stays up, in ms.
 *
 * Must clear the last piece's `animation-delay` + `animation-duration` in
 * `index.css` — the layer is unmounted when this elapses, so a shorter value
 * would cut the tail off. The reduced-motion block shortens the animation but not
 * this wait; the layer lingers a beat with a still picture on it, which is
 * harmless and keeps one number. The cake's is longer because a two-paragraph
 * message is not read in four seconds.
 */
const CONFETTI_MS = 4200;
const CAKE_MS = 8000;

/** The exit, in ms. `usePresence` unmounts after this; the CSS animates it. */
const EXIT_MS = 200;

const CONFETTI_TINTS = [
    'var(--md-sys-color-primary)',
    'var(--md-sys-color-secondary)',
    'var(--md-sys-color-tertiary)',
    'var(--md-sys-color-primary-container)',
    'var(--md-sys-color-tertiary-container)',
] as const;

interface ConfettiPiece {
    left: number;
    drift: number;
    fall: number;
    delay: number;
    duration: number;
    rotate: number;
    tint: string;
}

/**
 * The burst, generated once per celebration.
 *
 * A fixed seed would make two celebrations on the same device identical; `useMemo`
 * on the milestone key is the smaller thing to write and the variation is the
 * point. `Math.random` here is the whole "particle system": sixty divs, each
 * with a delay, a drift and a tilt.
 */
function makeConfetti(count: number): ConfettiPiece[] {
    return Array.from({ length: count }, (_, i) => ({
        // Spread across the width rather than fired from one point: a single
        // origin reads as an explosion, which is not what a quiet tracker app
        // should do behind a settings page.
        left: (i + Math.random() * 0.9) * (100 / count),
        drift: (Math.random() - 0.5) * 140,
        fall: 70 + Math.random() * 30,
        delay: Math.random() * 700,
        duration: 2200 + Math.random() * 1400,
        rotate: (Math.random() - 0.5) * 720,
        tint: CONFETTI_TINTS[i % CONFETTI_TINTS.length],
    }));
}

interface HrtMilestoneEffectProps {
    /**
     * The milestone to show. Non-null means the caller has already decided this is
     * a milestone *and* that it has not been shown yet — this component has no
     * opinion about either, which is what keeps the rule in one testable place.
     */
    milestone: Milestone | null;
    /** Days since the start date, for the copy. Only read when `milestone` is set. */
    days: number;
    /**
     * Called once the notice has finished showing itself.
     *
     * The milestone is held outside this component because the app remounts it
     * while the session restores, and a value claimed by a one-shot storage read
     * does not survive that. Releasing it here is what stops a later mount in the
     * same session from replaying the notice.
     */
    onDone?: () => void;
}

const HrtMilestoneEffect: React.FC<HrtMilestoneEffectProps> = ({ milestone, days, onDone }) => {
    const { t } = useTranslation();

    /**
     * It shows itself, then leaves on its own.
     *
     * A banner does not wait to be dismissed — adding a close button to an
     * unprompted congratulation invents a task. It cannot be hovered or swiped
     * away either: the two things worth doing to a notice like this are reading
     * it and getting on with what you came for, and crossing a bar to get at
     * Close is a second way to lose a click to decoration.
     *
     * The timer starts when the milestone appears, not when the message is first
     * seen, so the cake gets 8s *after* its entrance rather than including it.
     */
    const [showing, setShowing] = useState(milestone !== null);
    useEffect(() => {
        if (milestone === null) return;
        setShowing(true);
        const ms = milestone === 'cake' ? CAKE_MS : CONFETTI_MS;
        const timer = setTimeout(() => setShowing(false), ms);
        return () => clearTimeout(timer);
    }, [milestone]);

    // Released when the exit has finished, so the armed value outlives the
    // remount that motivated holding it in the first place.
    useEffect(() => {
        if (showing || milestone === null) return;
        const timer = setTimeout(() => onDone?.(), EXIT_MS);
        return () => clearTimeout(timer);
    }, [showing, milestone, onDone]);

    /**
     * Deliberately **not** `aria-live`: the bar is in the DOM from the first
     * render, so there is nothing for a live region to announce — it would either
     * say nothing or interrupt. Focus is never moved to it either. The one number
     * it carries is already on the page below ("HRT 开始 N 天"), so the worst case
     * is that a screen-reader user hears the same figure twice, never a different
     * one.
     */
    const { mounted, state } = usePresence(showing, EXIT_MS);

    /**
     * Where the top of the bar belongs.
     *
     * Read from the element that is already carrying the notch inset rather than
     * from a media query written here. It is a third of the way down `<html>`'s
     * box, so on a phone in landscape with a notch it resolves to those insets,
     * and on anything else — including the day that meta tag is dropped — it is
     * `auto`, which is zero in an absolutely positioned box. Copying the insets
     * would have been a second source of truth for a value nobody else in this
     * sheet reads.
     *
     * The shell is the bar's containing block and is exactly as tall as the bar, so
     * the bar's `inset-block-start` here is an offset *within* its own strip: zero
     * on anything without a notch, the status-bar inset on a phone that has one,
     * and the strip animated to the bar's full height underneath it either way.
     * `max-height: 100%` on the words resolves against the bar rather than against
     * the shell, so a long message shrinks to the line instead of growing the bar
     * down over the page — and therefore cannot move the height mid-transition.
     */
    const barRef = useRef<HTMLDivElement | null>(null);
    const shellRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!mounted) return;
        const bar = barRef.current;
        const shell = shellRef.current;
        if (!bar || !shell) return;
        const meta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
        bar.style.top = meta ? getComputedStyle(document.documentElement).paddingTop : '0px';

        /*
         * The strip the bar takes out of the layout, and the reason the page no
         * longer jumps when it arrives.
         *
         * Written onto the shell before this frame is painted, so the first painted
         * frame is already the closed end of the tween. `state` only reaches "open"
         * on the next render, and the transition runs from this frame's zero to
         * there — which is what keeps the open height from being glimpsed for one
         * frame, a flicker that would be the jump wearing a hat.
         *
         * Measured, not guessed: the bar is one line on day 100 and three on day
         * 365, and a number written here would clip whichever one it was not
         * measured against. `offsetHeight` is the same box the CSS reads — no
         * transform touches it, and `translateY` in the entrance keyframes does
         * not resize it.
         *
         * Settling is the browser's job and it is exact: when `state` leaves
         * "open" the property goes back to 0px, the tween runs to the closed end,
         * and the shell is `height: 0` — which is also the only value that stays
         * correct through a remount, unlike the height it was at. A bar that is
         * already up has been measured, so a viewport change that rewraps the
         * message is the one case this does not follow; a `ResizeObserver` for it
         * would be a second watcher on a box that is about to animate anyway.
         */
        const height = bar.offsetHeight + 'px';
        if (state === 'open') {
            shell.style.setProperty('--m3-milestone-height', height);
        } else {
            shell.style.removeProperty('--m3-milestone-height');
        }
    }, [mounted, state]);

    const pieces = useMemo(
        () => (milestone === 'confetti' ? makeConfetti(CONFETTI_PIECES) : []),
        [milestone],
    );

    if (!mounted) return null;

    return (
        <div
            className="m3-milestone-shell"
            data-open={state === 'open' || undefined}
            data-state={state}
            ref={shellRef}
            aria-hidden={state === 'closed' || undefined}
        >
            {milestone === 'confetti' && (
                <div className="m3-confetti" aria-hidden="true">
                    {pieces.map((piece, i) => (
                        <span
                            key={i}
                            className="m3-confetti__piece"
                            style={{
                                left: `${piece.left}%`,
                                backgroundColor: piece.tint,
                                animationDelay: `${piece.delay}ms`,
                                animationDuration: `${piece.duration}ms`,
                                // The CSS reads these to steer the fall; see index.css.
                                ['--confetti-x' as string]: `${piece.drift}px`,
                                ['--confetti-y' as string]: `${piece.fall}vh`,
                                ['--confetti-r' as string]: `${piece.rotate}deg`,
                            }}
                        />
                    ))}
                </div>
            )}

            <div className="m3-milestone-bar" data-state={state} ref={barRef}>
                {/*
                  The cake is reicon's `cake` glyph, not primitives. It ships in
                  both Outline and Filled and the repo's rule is reicon for icons.
                  Filled: a solid silhouette reads at 24px against the container
                  colour where an outline would thin out.

                  `aria-hidden`: the glyph is the title's ornament, and a glyph
                  with no name of its own should not appear in the tree as
                  unlabelled content.
                */}
                <Icon
                    icon={Cake}
                    size={24}
                    weight="Filled"
                    className="m3-milestone-bar__cake"
                    aria-hidden="true"
                />
                <div className="m3-milestone-bar__text">
                    <p className="m3-milestone-bar__title">
                        {t(milestone === 'cake' ? 'account.hrt_milestone.bar_title' : 'account.hrt_milestone.confetti')
                            .replace('{days}', String(days))
                            .replace('{n}', String(days))}
                    </p>
                    {/* The anniversary copy is Chinese in every language: it is a
                        message from the KiraEqual team, quoted rather than
                        translated at the point of use, and each other language's
                        bundle carries its own rendering of it. `pre-line` is what
                        turns the stored \n\n into the paragraph break. It is the
                        banner's second line, which the spec's structure allows —
                        hence `body-small` rather than a second title. */}
                    {milestone === 'cake' && (
                        <p className="m3-milestone-bar__body">{t('account.hrt_milestone.bar_body')}</p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default HrtMilestoneEffect;
