import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './SvgDefs';
import { useEscape } from '../hooks/useEscape';
import { useBackHandler } from '../utils/nativeBack';

/**
 * M3E Container Transform (docs/m3e-prototype.html `openFull` / `closeFull`).
 *
 * The trigger's own box becomes the overlay's clip-path and closing runs the
 * same geometry backwards. The overlay must stay mounted through the return, so
 * the caller's `open` prop is only an intent — this component owns presence.
 *
 * Both phone and desktop end at the viewport edges. The add-dose prototype's
 * desktop stage is wide enough for its two-column grid, so a 520px dialog would
 * squeeze the drug selector and the dose hero into unreadable columns.
 */

type Snapshot = {
    left: number;
    top: number;
    width: number;
    height: number;
    radius: number;
    background: string;
    color: string;
};

// The shell's FAB / speed-dial item records itself here on click. A module
// variable rather than context because the trigger and the surface can sit in
// completely different React trees (App shell vs. page), and the value is
// consumed once, synchronously, on the next render.
//
// The *geometry* is recorded here too, not re-measured when the overlay mounts.
// By then the caller has already changed the state the click implied: tapping a
// speed-dial item closes the dial, so its own CSS parks the item at 62% and 18px
// lower before the overlay's first layout effect runs. Measuring then would
// expand the surface out of a shrunken, displaced copy of the button. At click
// time the item is still where the finger left it.
type Source = {
    el: HTMLElement;
    left: number;
    top: number;
    width: number;
    height: number;
    radius: number;
    background: string;
    color: string;
    at: number;
};

let source: Source | null = null;

export function rememberTransformSource(el: HTMLElement | null): void {
    if (!el || !el.isConnected) {
        source = null;
        return;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
        source = null;
        return;
    }
    const cs = getComputedStyle(el);
    source = {
        el,
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        radius: parseFloat(cs.borderRadius) || Math.min(28, r.height / 2),
        background: cs.backgroundColor || 'var(--pric)',
        color: cs.color || 'var(--onpric)',
        at: performance.now(),
    };
}

/**
 * The element's box with its own transform taken back out.
 *
 * `getBoundingClientRect` includes the element's transform, and the trigger is
 * usually transformed at the moment we would measure it: the shell FAB carries
 * the press squash (`scale(.96)`) and a speed-dial item is parked at
 * `scale(.85)` with a translate once its menu closes. Expanding from that pose
 * is right — that is what the finger is touching — but *returning* to it left
 * the surface stopping short of the button it was landing on. The layout size is
 * unaffected by the transform and the computed matrix says how far the
 * transformed box was displaced, so both can be inverted from what we have.
 */
function restRect(el: HTMLElement, rect: DOMRect): DOMRect {
    const matrix = getComputedStyle(el).transform;
    if (!matrix || matrix === 'none') return rect;
    const values = /matrix(3d)?\(([^)]+)\)/.exec(matrix)?.[2]?.split(',').map(Number);
    if (!values || values.length < 6) return rect;
    const is3d = matrix.startsWith('matrix3d');
    const scaleX = values[0] || 1;
    const scaleY = is3d ? values[5] : values[3];
    const tx = is3d ? values[12] : values[4];
    const ty = is3d ? values[13] : values[5];
    if (!Number.isFinite(scaleY) || scaleY === 0) return rect;
    const width = rect.width / scaleX;
    const height = rect.height / scaleY;
    return new DOMRect(
        rect.left - tx + (rect.width - width) / 2,
        rect.top - ty + (rect.height - height) / 2,
        width,
        height,
    );
}

/** The trigger's resting box, measured now. Used for the return. */
function restingSnapshot(el: HTMLElement): Snapshot | null {
    if (!el.isConnected) return null;
    const measured = el.getBoundingClientRect();
    if (measured.width <= 0 || measured.height <= 0) return null;
    const r = restRect(el, measured);
    const cs = getComputedStyle(el);
    const radius = parseFloat(cs.borderRadius) || Math.min(28, r.height / 2);
    return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        radius,
        background: cs.backgroundColor || 'var(--pric)',
        color: cs.color || 'var(--onpric)',
    };
}

const EXIT_MS = 400;
/** How long before the end the trigger fades back in under the surfacing frame. */
const EXIT_FADE_AT = 160;
/** The shorter exit when there is no trigger to return into — a fade, not a morph. */
const FADE_MS = 240;

export interface ContainerTransformProps {
    open: boolean;
    onClose: () => void;
    /**
     * Reverse a close that is already running.
     *
     * The caller owns `open`, so only it can put the surface back; this is what
     * a second tap on the trigger, Escape and system back call while the surface
     * is still animating out. Omitted by callers with no state to restore.
     */
    onReopen?: () => void;
    title: string;
    children: ReactNode;
    /** Let the child own its header/body chrome. */
    bare?: boolean;
    className?: string;
}

export function ContainerTransform({
    open,
    onClose,
    onReopen,
    title,
    children,
    bare = false,
    className,
}: ContainerTransformProps) {
    const [mounted, setMounted] = useState(open);
    const [entered, setEntered] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [snap, setSnap] = useState<Snapshot | null>(null);
    /** Exit by fading in place because the trigger no longer exists. */
    const [fadeExit, setFadeExit] = useState(false);

    /** The element this surface grew out of, held for the whole lifetime. */
    const triggerRef = useRef<HTMLElement | null>(null);
    /** Whether that element was actually on screen when we hid it. */
    const triggerVisibleRef = useRef(false);
    const exitTimer = useRef<number | undefined>(undefined);
    const fadeTimer = useRef<number | undefined>(undefined);
    const enterRaf = useRef<number | undefined>(undefined);
    const interrupted = useRef(false);

    /**
     * What the surface shows — not always what the caller currently passes.
     *
     * It stays mounted through the return, and it used to render the live
     * `children` the whole time, so a caller that clears its selection on close
     * animated the next surface out: the med-plan editor played an empty "add"
     * header while it shrank. Freezing the last open view keeps the exit showing
     * the thing that is leaving.
     */
    const currentView = { title, children };
    const lastView = useRef(currentView);
    if (open) lastView.current = currentView;
    const view = open ? currentView : lastView.current;

    useEscape(() => {
        if (!open) {
            onReopen?.();
            return;
        }
        onClose();
    }, mounted);

    /**
     * The overlay is a modal, so system back must close it rather than reach the
     * page underneath. While the surface is animating out, back consumes and lets
     * the exit finish — reversing it here is what made the sheet unclosable: the
     * close and the gesture raced, the next back reopened the just-dismissed
     * surface, and with the caller's own handler above it the two fought until
     * back could no longer dismiss anything. (`onReopen` stays for Escape and the
     * return-hit tap, where reversing is the point.)
     */
    useBackHandler(mounted, () => {
        if (!open) return true;
        onClose();
        return true;
    });

    // Capture before the first paint of the overlay, so the very first frame is
    // already clipped to the trigger rather than flashing full-screen. The
    // geometry comes from the click (see `rememberTransformSource`), not from a
    // measurement here, which would already see the post-click state.
    useLayoutEffect(() => {
        if (!open || mounted) return;
        const recorded = source && performance.now() - source.at < 1000 ? source : null;
        triggerRef.current = recorded?.el ?? null;
        // A fresh open starts a new cycle. Only an exit that is still running
        // leaves this set — this effect does not run for a mid-flight reopen,
        // because the surface is already mounted.
        interrupted.current = false;
        setSnap(recorded ? {
            left: recorded.left,
            top: recorded.top,
            width: recorded.width,
            height: recorded.height,
            radius: recorded.radius,
            background: recorded.background,
            color: recorded.color,
        } : null);
        setMounted(true);
        setLeaving(false);
    }, [open, mounted]);

    // Hide the real trigger only after the clone is on screen. Inline opacity in
    // a layout effect rather than a body class, because the return has to fade
    // the same element back in at the end instead of popping it in on unmount.
    useLayoutEffect(() => {
        if (!mounted) return;
        const el = triggerRef.current;
        if (!el) return;
        const cs = getComputedStyle(el);
        // Only a trigger that is actually on screen is worth restoring: a
        // speed-dial item is already transparent once its menu closes, and
        // fading it back would leave it floating over the page afterwards.
        triggerVisibleRef.current = parseFloat(cs.opacity) > 0 && cs.visibility !== 'hidden';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        return () => {
            if (!el.isConnected) return;
            el.style.removeProperty('opacity');
            el.style.removeProperty('pointer-events');
            el.style.removeProperty('transition');
        };
    }, [mounted]);

    useLayoutEffect(() => {
        if (!mounted) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [mounted]);

    // Expand on the frame after mount. Double rAF because the browser must have
    // painted the clipped start state before the transition can run.
    useEffect(() => {
        if (!mounted || !open) return;
        enterRaf.current = requestAnimationFrame(() => {
            enterRaf.current = requestAnimationFrame(() => setEntered(true));
        });
        return () => {
            if (enterRaf.current) cancelAnimationFrame(enterRaf.current);
        };
    }, [mounted, open]);

    // Layout, not passive: both directions have to take effect before the frame
    // that shows the new `open` is painted. A passive start left one frame in
    // which the surface was neither open nor on its way out — the clip had
    // snapped to the trigger while the content was still there.
    useLayoutEffect(() => {
        if (open) {
            if (interrupted.current) {
                interrupted.current = false;
                // Reverse from wherever the clip has reached. Letting the
                // double-rAF entrance drive this would park the surface on the
                // trigger pose for two frames first, which reads as a stutter.
                setEntered(true);
                const el = triggerRef.current;
                if (el?.isConnected) {
                    el.style.removeProperty('transition');
                    el.style.opacity = '0';
                }
            }
            setLeaving(false);
            setFadeExit(false);
            return;
        }
        if (!mounted) return;
        setEntered(false);
        setLeaving(true);
        // The trigger can be gone by the time the surface closes: deleting the
        // record a sheet was opened from removes the row it grew out of. Clipping
        // back to that empty box made the surface shrink into nothing and then
        // disappear on the last frame — the "plays the close animation, then
        // flashes away" report. With nothing to land on, fade instead.
        const trigger = triggerRef.current;
        if (!trigger || !trigger.isConnected) {
            setSnap(null);
            setFadeExit(true);
            exitTimer.current = window.setTimeout(() => {
                interrupted.current = false;
                setMounted(false);
                setLeaving(false);
                setFadeExit(false);
            }, FADE_MS);
            return () => {
                if (exitTimer.current) window.clearTimeout(exitTimer.current);
            };
        }
        setFadeExit(false);
        // Re-read the trigger: the page may have scrolled or reflowed while the
        // surface was open, and the return must land on the button as it is now —
        // at its resting size, not at the size it was pressed to.
        const rest = restingSnapshot(trigger);
        if (rest) setSnap(rest);
        interrupted.current = true;
        if (triggerVisibleRef.current) {
            fadeTimer.current = window.setTimeout(() => {
                if (!trigger.isConnected) return;
                trigger.style.transition = 'opacity .16s ease';
                trigger.style.opacity = '1';
            }, EXIT_MS - EXIT_FADE_AT);
        }
        exitTimer.current = window.setTimeout(() => {
            interrupted.current = false;
            setMounted(false);
            setLeaving(false);
        }, EXIT_MS);
        return () => {
            if (exitTimer.current) window.clearTimeout(exitTimer.current);
            if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
        };
    }, [open, mounted]);

    if (!mounted) return null;

    const style = {
        '--ct': snap
            ? `inset(${snap.top}px ${Math.max(0, window.innerWidth - snap.left - snap.width)}px ${Math.max(0, window.innerHeight - snap.top - snap.height)}px ${snap.left}px round ${snap.radius}px)`
            : 'inset(0px round 0px)',
        '--ct-bg': snap?.background ?? 'var(--pric)',
        '--ct-fg': snap?.color ?? 'var(--onpric)',
    } as CSSProperties;

    return createPortal(
        <>
            <div
                className={`m3e-ct-scrim${entered ? ' on' : ''}`}
                onClick={onClose}
                aria-hidden="true"
            />
            <div
                className={`m3e-ct${entered ? ' open' : ''}${leaving ? ' out' : ''}${fadeExit ? ' fade' : ''}${bare ? ' bare' : ''}${className ? ` ${className}` : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label={view.title}
                style={style}
                data-state={leaving ? 'closed' : 'open'}
            >
                <div className="m3e-ct-inner">
                    {bare ? (
                        view.children
                    ) : (
                        <>
                            <div className="ct-bar">
                                <button
                                    type="button"
                                    className="ic-btn"
                                    onClick={onClose}
                                    aria-label={view.title}
                                >
                                    <Icon id="chev" style={{ transform: 'rotate(180deg)' }} />
                                </button>
                                <b>{view.title}</b>
                                <span className="sp" />
                            </div>
                            <div className="ct-body">{view.children}</div>
                        </>
                    )}
                </div>
            </div>
            {/* The spot that opened this is covered by the shrinking frame until
                the last frame; a second tap there during the return cancels it. */}
            {leaving && onReopen && snap ? (
                <button
                    type="button"
                    className="m3e-ct-return-hit"
                    aria-hidden="true"
                    tabIndex={-1}
                    onClick={onReopen}
                    style={{
                        left: snap.left,
                        top: snap.top,
                        width: snap.width,
                        height: snap.height,
                        borderRadius: snap.radius,
                    }}
                />
            ) : null}
        </>,
        document.body,
    );
}
