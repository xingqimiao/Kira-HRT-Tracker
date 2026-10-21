import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../SvgDefs';
import { useEscape } from '../../hooks/useEscape';

/**
 * The prototype's bottom sheet / centred dialog.
 *
 * Phone: `.sheet` slides up from the bottom at its content height, capped at
 * 88%; the grab handle expands it to the full 88% for a long form. Wide window:
 * the same panel becomes a 460px centred dialog with all four corners and no
 * handle — there is nothing to drag on a desktop.
 */

export interface AdaptiveSheetProps {
    open: boolean;
    onClose: () => void;
    title?: React.ReactNode;
    ariaLabel?: string;
    children: React.ReactNode;
    defaultTall?: boolean;
    tall?: boolean;
    wide?: boolean;
    footer?: React.ReactNode;
    closeLabel?: string;
    bare?: boolean;
    /**
     * Stacking override. The default layer (scrim 40 / sheet 41) is right for
     * page sheets; a sheet opened from above a full-screen surface (the app-lock
     * reset panel) must outrank that surface.
     */
    zIndex?: number;
}

const CLOSE_MS = 420;

export function AdaptiveSheet({
    open,
    onClose,
    title,
    ariaLabel,
    children,
    defaultTall = false,
    tall: controlledTall,
    wide = false,
    footer,
    closeLabel = 'Close',
    bare = false,
    zIndex,
}: AdaptiveSheetProps) {
    const [mounted, setMounted] = useState(open);
    const [shown, setShown] = useState(false);
    const [tall, setTall] = useState(defaultTall);
    const panelRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef<number | null>(null);

    useEscape(onClose, open);

    // Mount and start the entrance in layout, with a forced style read between
    // the off-screen pose and `.on`. Without that read the browser occasionally
    // coalesced both paints and the sheet appeared already open — the reported
    // "sometimes it just flashes in" on every bottom sheet.
    useLayoutEffect(() => {
        if (!open) return;
        if (!mounted) {
            setMounted(true);
            return;
        }
        const el = panelRef.current;
        if (!el) return;
        void el.offsetHeight;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = requestAnimationFrame(() => setShown(true));
        });
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        };
    }, [open, mounted]);

    useEffect(() => {
        if (open) return;
        setShown(false);
        if (!mounted) return;
        const timer = window.setTimeout(() => setMounted(false), CLOSE_MS);
        return () => window.clearTimeout(timer);
    }, [open, mounted]);

    useEffect(() => {
        if (controlledTall !== undefined) setTall(controlledTall);
    }, [controlledTall]);

    useEffect(() => {
        if (!mounted) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [mounted]);

    useEffect(() => {
        if (open && mounted) panelRef.current?.focus({ preventScroll: true });
    }, [open, mounted]);

    if (!mounted) return null;

    return createPortal(
        <>
            <div className={`scrim${shown ? ' on' : ''}`} onClick={onClose} aria-hidden="true" style={zIndex !== undefined ? { zIndex } : undefined} />
            <div
                ref={panelRef}
                className={`sheet${shown ? ' on' : ''}${tall ? ' tall' : ''}${wide ? ' wide' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
                tabIndex={-1}
                style={{ display: 'flex', flexDirection: 'column', ...(zIndex !== undefined ? { zIndex: zIndex + 1 } : {}) }}
            >
                <button type="button" className="sh-handle" onClick={() => setTall(value => !value)} aria-label={tall ? 'Collapse' : 'Expand'} aria-expanded={tall} />
                {!bare ? (
                    <div className="hrow" style={{ padding: '2px 0 8px' }}>
                        {title !== undefined ? <b style={{ fontSize: 18 }}>{title}</b> : <span />}
                        <button type="button" className="ic-btn" onClick={onClose} aria-label={closeLabel} style={{ width: 38, height: 38 }}>
                            <Icon id="x" />
                        </button>
                    </div>
                ) : null}
                {/* Natural height by default; only the explicitly tall sheet
                    fills the remaining space. `flex:1` on an auto-height parent
                    still reserved empty space below a one-paragraph notice. */}
                <div className="sheet-body" style={{ overflow: 'auto', flex: tall ? 1 : '0 1 auto', minHeight: 0 }}>{children}</div>
                {footer ? <div style={{ flex: 'none', paddingTop: 10 }}>{footer}</div> : null}
            </div>
        </>,
        document.body,
    );
}
