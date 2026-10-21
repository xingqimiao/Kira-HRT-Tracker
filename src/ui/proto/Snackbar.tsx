import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

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

export function Snackbar({ open, message, actionLabel, onAction, onClose, duration }: SnackbarProps) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEffect(() => {
        if (!open) {
            if (timer.current) clearTimeout(timer.current);
            return;
        }
        const ms = duration ?? (actionLabel ? 8000 : 4000);
        timer.current = setTimeout(() => closeRef.current?.(), ms);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [open, duration, actionLabel]);

    return createPortal(
        <div
            className={`snack${open ? ' show' : ''}`}
            role="status"
            aria-live="polite"
            // A hidden snackbar must leave the accessibility tree as well as the
            // screen: it is always mounted so the slide can be a transition, and
            // an `aria-live` region that still exists announces its stale text.
            aria-hidden={!open}
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
        </div>,
        document.body,
    );
}
