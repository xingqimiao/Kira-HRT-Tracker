import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '../../hooks/usePresence';

/**
 * The two edge-anchored notices: the quick-add undo and the update prompt.
 *
 * Every other surface in this app is a centred dialog, and they share one motion
 * (`.modal-*` in index.css). These two are not dialogs — they sit at a screen edge,
 * over the app rather than instead of it, and they can be dismissed by gesture. That
 * is a different enough thing to be a different component: the motion comes *from the
 * edge it is anchored to* and leaves the same way, and a horizontal drag can throw it
 * away. Sharing one shell is also how the two stay identical — they are the same
 * object seen twice, so a tweak to one is a tweak to both.
 *
 * The motion is driven by inline styles and a CSS transition rather than a keyframe
 * animation, and that is deliberate. A swipe writes `transform` every pointer move, and
 * a filled-forwards keyframe would keep overriding it — the pill would refuse to follow
 * the finger. A transition composes with inline styles instead of fighting them, and
 * `transition: none` during the drag is all it takes to stop it lagging.
 *
 * Centring lives on the outer element, so the inner element's transform is free for the
 * motion and the drag. Putting both on one node would mean every keyframe had to
 * remember the offset. The outer element spans the full width and centres the pill with
 * flexbox rather than `left: 50%; translateX(-50%)`: a fixed box with `left: 50%` has
 * only the right half as its available width, so shrink-to-fit sized the pill to 50% of
 * the viewport — on a 390px phone that collapsed it to 195px and wrapped the label
 * ("已记下…" over three lines, 撤销 stacked vertically). A full-width flex row has the
 * whole viewport to size against, and the padding is what keeps the pill off the edges.
 */

/** Must match the transition in `poseStyle` below. */
const EXIT_MS = 220;
/** Pointer travel before a press becomes a drag rather than a click on a button in it. */
const SLOP_PX = 6;
/** Past this much travel, releasing throws the notice away. */
const DISMISS_PX = 72;
/** …or this much speed, so a short flick counts even when it did not travel far. */
const DISMISS_VELOCITY_PX_MS = 0.5;

export interface FloatingToastProps {
    /** The surface's own open state; the exit runs on the way to false. */
    open: boolean;
    /** Which screen edge it hangs from. Determines the direction it moves. */
    edge?: 'top' | 'bottom';
    /** The leading badge glyph. */
    icon: React.ReactNode;
    /** The message. */
    children: React.ReactNode;
    /** Right-aligned controls. */
    actions?: React.ReactNode;
    /** Called when the notice is swiped away. Without it the drag is not offered. */
    onDismiss?: () => void;
    className?: string;
}

const FloatingToast: React.FC<FloatingToastProps> = ({
    open, edge = 'bottom', icon, children, actions, onDismiss, className = '',
}) => {
    const { mounted } = usePresence(open, EXIT_MS);

    // The entrance needs the closed pose painted once before it can transition out of
    // it; mounting straight into `open` would just appear. Reduced motion skips the
    // wait, since the preference is asking for exactly that.
    const [entered, setEntered] = useState(false);
    const reducedRef = useRef(false);
    useEffect(() => {
        reducedRef.current = typeof window !== 'undefined'
            && !!window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }, []);
    useEffect(() => {
        if (!open) {
            setEntered(false);
            return;
        }
        if (reducedRef.current) {
            setEntered(true);
            return;
        }
        const id = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(id);
    }, [open]);

    const [drag, setDrag] = useState({ dx: 0, active: false });
    const startRef = useRef<{ x: number; t: number; id: number } | null>(null);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!onDismiss) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        startRef.current = { x: e.clientX, t: performance.now(), id: e.pointerId };
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const start = startRef.current;
        if (!start) return;
        const dx = e.clientX - start.x;
        if (!drag.active) {
            // Still a press, not a drag. Reporting it as one would move the pill under a
            // finger that only meant to tap 撤销 or 更新 — and capturing the pointer here
            // would also swallow that tap's click.
            if (Math.abs(dx) < SLOP_PX) return;
            // The drag has begun: capture so the moves keep arriving once the finger
            // outruns the pill's box. Capturing *now* rather than on pointerdown is what
            // keeps a plain tap working.
            e.currentTarget.setPointerCapture(start.id);
        }
        setDrag({ dx, active: true });
    };
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        const start = startRef.current;
        startRef.current = null;
        if (!start || !drag.active) return;
        const dx = e.clientX - start.x;
        const elapsed = Math.max(1, performance.now() - start.t);
        if (Math.abs(dx) > DISMISS_PX || Math.abs(dx) / elapsed > DISMISS_VELOCITY_PX_MS) {
            onDismiss?.();
        }
        setDrag({ dx: 0, active: false });
    };

    if (!mounted) return null;

    const dismissed = edge === 'top' ? 'translateY(-18px) scale(0.96)' : 'translateY(18px) scale(0.96)';
    const pose: React.CSSProperties = drag.active
        ? {
            // Follow the finger, fading as it travels so the throw reads as leaving.
            transform: `translateX(${drag.dx}px)`,
            opacity: Math.max(0.15, 1 - Math.abs(drag.dx) / (DISMISS_PX * 2.6)),
            transition: 'none',
        }
        : {
            transform: open && entered ? 'none' : dismissed,
            opacity: open && entered ? 1 : 0,
        };

    return createPortal(
        <div
            // Full-width, centred by flexbox: see the header note for why this is not
            // `left: 50%` + translate. The centring and the edge offset live here, so
            // the inner element's transform is free for the motion and the drag.
            className="fixed inset-x-0 z-[95] flex justify-center px-4"
            style={{
                ...(edge === 'top'
                    ? { top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }
                    : { bottom: 'var(--floating-toast-bottom)' }),
                // A leaving notice must not eat clicks meant for the page.
                pointerEvents: open ? undefined : 'none',
            }}
        >
            <div
                role="status"
                aria-live="polite"
                data-state={open ? 'open' : 'closed'}
                className={`floating-toast flex max-w-[24rem] items-center gap-2.5 rounded-full border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-highest)] py-2 pl-2 pr-1.5 shadow-[var(--shadow-m3-3)] ${onDismiss ? 'cursor-grab active:cursor-grabbing' : ''} ${className}`}
                style={{
                    ...pose,
                    transition: drag.active
                        ? 'none'
                        : 'transform 220ms var(--md-sys-motion-easing-emphasized-decelerate, cubic-bezier(0.2,0,0,1)), opacity 220ms linear',
                    // Horizontal drags are ours; vertical ones stay the page's scroll.
                    touchAction: 'pan-y',
                    willChange: 'transform, opacity',
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)]">
                    {icon}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium text-[var(--color-m3-on-surface)]">
                    {children}
                </span>
                {actions}
            </div>
        </div>,
        document.body,
    );
};

export default FloatingToast;
