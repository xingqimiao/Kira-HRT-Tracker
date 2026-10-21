import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../../components/Icon';
import { X } from '../../icons';

/**
 * Snackbar — the transient confirmation, with undo.
 *
 * Docked bottom-right on a wide window and bottom-centre above the navigation
 * bar on a phone. It stays mounted so the slide is a transition rather than a
 * mount, and it auto-hides when a duration is given.
 *
 * `onAction` is what makes the destructive flows honest: the record is removed
 * immediately and this is the one place it can come back from, so the snackbar
 * waits longer (8s) when there is an action than when there is not (4s).
 *
 * Two ways out, matching where the finger is: a swipe down on a phone (the same
 * gesture the sheets use) and a close button on a desktop window, where a drag is
 * not a gesture anyone tries. Both run `onClose`, so dismissing is exactly what
 * the timer would have done — nothing is left in a half-state.
 */

export interface SnackbarProps {
    open: boolean;
    message: React.ReactNode;
    actionLabel?: string;
    onAction?: () => void;
    onClose?: () => void;
    /** Milliseconds. Defaults to 8000 with an action, 4000 without. */
    duration?: number;
}

/** How far a finger has to travel before the swipe counts as "dismiss". */
const DISMISS_AFTER_PX = 64;

export function Snackbar({ open, message, actionLabel, onAction, onClose, duration }: SnackbarProps) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // The close button only exists on a wide window; the swipe only on a phone.
    // Reading the same 760px breakpoint the shell uses keeps the two shells' idea
    // of "desktop" from drifting apart.
    const [isDesktop, setIsDesktop] = useState(
        () => typeof window !== 'undefined' && window.innerWidth >= 760,
    );
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const query = window.matchMedia('(min-width: 760px)');
        const apply = () => setIsDesktop(query.matches);
        apply();
        query.addEventListener('change', apply);
        return () => query.removeEventListener('change', apply);
    }, []);

    // Vertical drag offset while the finger is down; 0 when not dragging.
    const [offset, setOffset] = useState(0);
    const drag = useRef<{ startY: number; active: boolean } | null>(null);

    useEffect(() => {
        if (!open) {
            if (timer.current) clearTimeout(timer.current);
            setOffset(0);
            drag.current = null;
            return;
        }
        const ms = duration ?? (actionLabel ? 8000 : 4000);
        timer.current = setTimeout(() => closeRef.current?.(), ms);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [open, duration, actionLabel]);

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (isDesktop || !open) return;
        drag.current = { startY: event.clientY, active: true };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current?.active) return;
        // Downward only: an upward drag has nowhere to go, and lifting the pill off
        // the bottom edge would read as a bug rather than a dismissal.
        setOffset(Math.max(0, event.clientY - drag.current.startY));
    };
    const endDrag = () => {
        if (!drag.current?.active) return;
        drag.current.active = false;
        const travelled = offset;
        setOffset(0);
        if (travelled >= DISMISS_AFTER_PX) closeRef.current?.();
    };

    return createPortal(
        <div
            className={`snack${open ? ' show' : ''}`}
            role="status"
            aria-live="polite"
            // A hidden snackbar must leave the accessibility tree as well as the
            // screen: it is always mounted so the slide can be a transition, and
            // an `aria-live` region that still exists announces its stale text.
            aria-hidden={!open}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            // Inline so it wins over `.snack.show{transform:none}`, and the
            // transition is dropped mid-drag so the pill tracks the finger exactly.
            style={{
                // The drag has to win over the page's own vertical scroll.
                touchAction: 'none',
                ...(offset > 0
                    ? {
                        transform: `translateY(${offset}px)`,
                        opacity: Math.max(0.2, 1 - offset / 160),
                        transition: 'none',
                    }
                    : {}),
            }}
        >
            <span className="min-w-0 flex-1">{message}</span>
            {actionLabel && onAction ? (
                <button
                    type="button"
                    className="snack-action"
                    onClick={() => {
                        onAction();
                        onClose?.();
                    }}
                >
                    {actionLabel}
                </button>
            ) : null}
            {isDesktop ? (
                <button
                    type="button"
                    onClick={() => onClose?.()}
                    aria-label="Close"
                    className="shrink-0 rounded-full"
                    style={{ color: 'inherit', opacity: 0.7, padding: 6, lineHeight: 0 }}
                >
                    <Icon icon={X} size={14} />
                </button>
            ) : null}
        </div>,
        document.body,
    );
}
