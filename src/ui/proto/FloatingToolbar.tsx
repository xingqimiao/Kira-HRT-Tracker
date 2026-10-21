import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * FloatingToolbar — the selection action bar (AGENTS.md §3, batch selection).
 *
 * A 56px pill in `--pric` that floats above the navigation bar while a batch is
 * being selected. It is a toolbar, not a dialog: it takes no focus, and every
 * action in it is reversible except the one that names itself "delete".
 *
 * It renders at the document root because the page it belongs to scrolls; a
 * fixed bar inside a scrolling subtree picks up the subtree's transform context
 * on some mobile browsers and stops being fixed.
 */
export interface FloatingToolbarProps {
    open: boolean;
    children: React.ReactNode;
    /** Accessible name, e.g. "Selection actions". */
    label?: string;
}

/** Matches the `.ftool` transition in proto-compat.css. */
const EXIT_MS = 220;

export function FloatingToolbar({ open, children, label }: FloatingToolbarProps) {
    const [mounted, setMounted] = useState(open);
    const [shown, setShown] = useState(open);

    useEffect(() => {
        if (open) {
            setMounted(true);
            const frame = requestAnimationFrame(() => setShown(true));
            return () => cancelAnimationFrame(frame);
        }
        setShown(false);
        const timer = window.setTimeout(() => setMounted(false), EXIT_MS);
        return () => window.clearTimeout(timer);
    }, [open]);

    if (!mounted) return null;
    return createPortal(
        <div className={`ftool${shown ? ' on' : ''}`} role="toolbar" aria-label={label} aria-hidden={!open || undefined}>
            {children}
        </div>,
        document.body,
    );
}

export interface FloatingToolbarActionProps {
    icon?: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
}

export function FloatingToolbarAction({ icon, label, onClick, disabled, danger }: FloatingToolbarActionProps) {
    return (
        <button
            type="button"
            className={`ftool-action${danger ? ' danger' : ''}`}
            onClick={onClick}
            disabled={disabled}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}
