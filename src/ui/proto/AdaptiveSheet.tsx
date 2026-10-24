import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../SvgDefs';
import { useEscape } from '../../hooks/useEscape';
import { useBackHandler } from '../../utils/nativeBack';

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

/** Everything the panel draws, captured as one value so it can be frozen. */
interface SheetView {
    title: React.ReactNode;
    ariaLabel?: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
    wide: boolean;
    closeLabel: string;
}

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

    /**
     * What the panel shows — which is not always what the caller currently
     * passes.
     *
     * The panel stays mounted for CLOSE_MS after `open` goes false, and it used
     * to render the live `children` throughout. Any caller that clears its
     * selection on close therefore animated the *next* surface out: opening a lab
     * record and closing it played the add form (two hormone heroes, a wider
     * panel, an "add" title) for a fifth of a second, however small the record
     * was. Freezing the last open view keeps the exit showing the thing that is
     * leaving.
     */
    const currentView: SheetView = { title, ariaLabel, children, footer, wide, closeLabel };
    const lastView = useRef<SheetView>(currentView);
    if (open) lastView.current = currentView;
    const view = open ? currentView : lastView.current;

    useEscape(onClose, open);

    // Every sheet is dismissible by system back, and it says so itself: a caller
    // that had to remember this made the surface unclosable when it forgot, and
    // two that both remembered made two handlers fight over one gesture.
    useBackHandler(open, () => {
        onClose();
        return true;
    });

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

    // Closing is a layout effect, not a passive one: a passive effect let the
    // commit that clears `open` paint once more with `.on` still applied, which
    // was a fully-open frame of whatever the caller had just replaced.
    useLayoutEffect(() => {
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
                className={`sheet${shown ? ' on' : ''}${tall ? ' tall' : ''}${view.wide ? ' wide' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label={view.ariaLabel ?? (typeof view.title === 'string' ? view.title : undefined)}
                tabIndex={-1}
                style={{ display: 'flex', flexDirection: 'column', ...(zIndex !== undefined ? { zIndex: zIndex + 1 } : {}) }}
            >
                <button type="button" className="sh-handle" onClick={() => setTall(value => !value)} aria-label={tall ? 'Collapse' : 'Expand'} aria-expanded={tall} />
                {!bare ? (
                    <div className="hrow" style={{ padding: '2px 0 8px' }}>
                        {view.title !== undefined ? <b style={{ fontSize: 18 }}>{view.title}</b> : <span />}
                        <button type="button" className="ic-btn" onClick={onClose} aria-label={view.closeLabel} style={{ width: 38, height: 38 }}>
                            <Icon id="x" />
                        </button>
                    </div>
                ) : null}
                {/* Natural height by default; only the explicitly tall sheet
                    fills the remaining space. `flex:1` on an auto-height parent
                    still reserved empty space below a one-paragraph notice. */}
                <div className="sheet-body" style={{ overflow: 'auto', flex: tall ? 1 : '0 1 auto', minHeight: 0 }}>{view.children}</div>
                {view.footer ? <div style={{ flex: 'none', paddingTop: 10 }}>{view.footer}</div> : null}
            </div>
        </>,
        document.body,
    );
}
