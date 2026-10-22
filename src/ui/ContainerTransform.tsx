import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './SvgDefs';
import { useEscape } from '../hooks/useEscape';
import { useBackHandler } from '../utils/nativeBack';

/**
 * M3E Container Transform (docs/m3e-prototype.html `openFull` / `closeFull`).
 *
 * The trigger's own box becomes the overlay's clip-path, a ghost of the trigger
 * cross-fades out while the surface expands, and closing runs the same geometry
 * backwards. The overlay must stay mounted through the 500ms return, so the
 * caller's `open` prop is only an intent — this component owns presence.
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
    icon: string;
};

// The shell's FAB / speed-dial item records itself here on pointerdown. A
// module variable rather than context because the trigger and the surface can
// sit in completely different React trees (App shell vs. page), and the value
// is consumed once, synchronously, on the next render.
let sourceEl: HTMLElement | null = null;
let sourceAt = 0;

export function rememberTransformSource(el: HTMLElement | null): void {
    sourceEl = el;
    sourceAt = el ? performance.now() : 0;
}

function snapshotOf(el: HTMLElement | null, icon: string): Snapshot | null {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
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
        icon,
    };
}

const EXIT_MS = 520;
/** The shorter exit when there is no trigger to return into — a fade, not a morph. */
const FADE_MS = 240;

export interface ContainerTransformProps {
    open: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    /** Let the child own its header/body chrome. */
    bare?: boolean;
    /** Sprite id drawn inside the trigger ghost. */
    ghostIcon?: string;
    className?: string;
}

export function ContainerTransform({
    open,
    onClose,
    title,
    children,
    bare = false,
    ghostIcon = 'plus',
    className,
}: ContainerTransformProps) {
    const [mounted, setMounted] = useState(open);
    const [entered, setEntered] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [snap, setSnap] = useState<Snapshot | null>(null);
    /** Exit by fading in place because the trigger no longer exists. */
    const [fadeExit, setFadeExit] = useState(false);
    const hiddenRef = useRef<HTMLElement | null>(null);
    const exitTimer = useRef<number | undefined>(undefined);
    const enterRaf = useRef<number | undefined>(undefined);

    useEscape(onClose, open && mounted);

    /**
     * The overlay is a modal, so system back must close it rather than reach the
     * page underneath. Without this the med-plan editor stayed open while back
     * torn the settings category down — one swipe flashed the page behind the
     * sheet, a second one left settings altogether. Registered while `open`
     * only: during the 520ms return animation the surface is still mounted but
     * is no longer in front.
     */
    useBackHandler(open, () => {
        onClose();
        return true;
    });

    // Capture before the first paint of the overlay, so the very first frame is
    // already clipped to the trigger rather than flashing full-screen.
    useLayoutEffect(() => {
        if (!open || mounted) return;
        const fresh = performance.now() - sourceAt < 1000;
        const next = snapshotOf(fresh ? sourceEl : null, ghostIcon);
        setSnap(next);
        setMounted(true);
        setLeaving(false);
    }, [open, mounted, ghostIcon]);

    // Hide the real trigger only after the clone is on screen. Restoring is the
    // mirror image, and the cleanup catches an unmount mid-flight.
    useEffect(() => {
        if (!mounted) return;
        const el = sourceEl;
        if (el && performance.now() - sourceAt < 1000) {
            el.style.visibility = 'hidden';
            hiddenRef.current = el;
        }
        return () => {
            if (hiddenRef.current) hiddenRef.current.style.visibility = '';
            hiddenRef.current = null;
        };
    }, [mounted]);

    useEffect(() => {
        if (!mounted) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        // The shell FAB is a separate floating layer. If it stays visible while
        // the surface collapses back to a list row, the row-sized panel slides
        // over it and the depth ordering reads wrong. Keep it out of the way for
        // the whole enter/exit, then let the shell show it again.
        document.body.classList.remove('ct-returning');
        document.body.classList.add('ct-active');
        return () => {
            document.body.style.overflow = previous;
            document.body.classList.remove('ct-active');
            // Hand the FAB back in with a small settle rather than popping it
            // into existence on the frame the overlay unmounts.
            document.body.classList.add('ct-returning');
            window.setTimeout(() => document.body.classList.remove('ct-returning'), 320);
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

    useEffect(() => {
        if (open) {
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
        if (!sourceEl || !sourceEl.isConnected) {
            setSnap(null);
            setFadeExit(true);
            exitTimer.current = window.setTimeout(() => {
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
        // surface was open, and the return must land on the button as it is now.
        const fresh = performance.now() - sourceAt < 1000;
        setSnap(current => snapshotOf(fresh ? sourceEl : null, ghostIcon) ?? current);
        exitTimer.current = window.setTimeout(() => {
            setMounted(false);
            setLeaving(false);
        }, EXIT_MS);
        return () => {
            if (exitTimer.current) window.clearTimeout(exitTimer.current);
        };
    }, [open, mounted, ghostIcon]);

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
                aria-label={title}
                style={style}
                data-state={leaving ? 'closed' : 'open'}
            >
                {snap ? (
                    <div
                        className="m3e-ct-ghost"
                        aria-hidden="true"
                        style={{
                            left: snap.left,
                            top: snap.top,
                            width: snap.width,
                            height: snap.height,
                            borderRadius: snap.radius,
                            background: snap.background,
                            color: snap.color,
                        }}
                    >
                        <Icon id={snap.icon || ghostIcon} />
                    </div>
                ) : null}

                <div className="m3e-ct-inner">
                    {bare ? (
                        children
                    ) : (
                        <>
                            <div className="ct-bar">
                                <button
                                    type="button"
                                    className="ic-btn"
                                    onClick={onClose}
                                    aria-label={title}
                                >
                                    <Icon id="chev" style={{ transform: 'rotate(180deg)' }} />
                                </button>
                                <b>{title}</b>
                                <span className="sp" />
                            </div>
                            <div className="ct-body">{children}</div>
                        </>
                    )}
                </div>
            </div>
        </>,
        document.body,
    );
}
