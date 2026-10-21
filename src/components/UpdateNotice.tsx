import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { RefreshCw, X } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { onUpdateReady, applyUpdate } from '../utils/swUpdate';
import { checkNativeUpdate } from '../utils/nativeUpdate';
import { isNativeApp } from '../utils/platform';
import { NativeUpdateSheet } from './NativeUpdateSheet';
import { openUpdateSheet } from '../utils/updateSheet';

/**
 * "A new version is ready."
 *
 * Deliberately not a forced reload. This app is used mid-task — a dose half entered, a
 * lab report being read off the page — and a refresh imposed at that moment discards
 * work. So the new build waits, the running one keeps working, and this asks. Nothing
 * is lost by waiting: the worker has already installed and is serving the new assets.
 *
 * Two shapes, because the two platforms answer different questions:
 *
 *   - **Web** — a reload costs nothing, so the prompt is one line on the `FloatingToast`
 *     pill: "a new version is ready" + Reload. Anchored to the *top*: the bottom edge
 *     belongs to the M3 navigation bar on a phone, and a notice competing with the tab
 *     bar for the same thumb space is a worse notice.
 *   - **Android** — the update is an APK replace: the user has to leave the app, and
 *     they deserve the changelog. That is an M3E bottom sheet (see `NativeUpdateSheet`),
 *     which is also the one surface that can show download progress. The settings
 *     "check for updates" item opens the same sheet, so both entry points land in the
 *     same flow instead of one of them answering with text and starting a download the
 *     user cannot see.
 *
 * Dismissible, because "later" is a legitimate answer and a notice with no exit is a
 * nuisance. Dismissing hides it for this session only — the build still updates on the
 * next natural open, which would have happened anyway.
 */
const UpdateNotice: React.FC = () => {
    const { t } = useTranslation();
    const [ready, setReady] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    // Swipe-down to dismiss on a phone, matching the quick-add snackbar. The close
    // button stays for the desktop shell, where a drag is not a gesture anyone tries.
    const [dragOffset, setDragOffset] = useState(0);
    const drag = useRef<{ startY: number; active: boolean } | null>(null);

    useEffect(() => {
        if (isNativeApp()) {
            void checkNativeUpdate()
                .then((update) => {
                    if (update) openUpdateSheet(update);
                })
                .catch(() => {});
            return;
        }
        return onUpdateReady(() => setReady(true));
    }, []);

    if (isNativeApp()) return <NativeUpdateSheet />;

    return createPortal(
        <div
            className={`snack${ready && !dismissed ? ' show' : ''}`}
            role="status"
            aria-live="polite"
            onPointerDown={(event) => {
                // Desktop keeps the button; the drag is a phone gesture.
                if (document.body.classList.contains('desktop')) return;
                drag.current = { startY: event.clientY, active: true };
                event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
                if (!drag.current?.active) return;
                setDragOffset(Math.max(0, event.clientY - drag.current.startY));
            }}
            onPointerUp={() => {
                if (!drag.current?.active) return;
                drag.current.active = false;
                const travelled = dragOffset;
                setDragOffset(0);
                if (travelled >= 64) setDismissed(true);
            }}
            onPointerCancel={() => {
                drag.current = null;
                setDragOffset(0);
            }}
            style={{
                // The drag has to win over the page's own vertical scroll.
                touchAction: 'none',
                ...(dragOffset > 0
                    ? {
                        transform: `translateY(${dragOffset}px)`,
                        opacity: Math.max(0.2, 1 - dragOffset / 160),
                        transition: 'none',
                    }
                    : {}),
            }}
        >
            <span className="min-w-0">{t('update.ready')}</span>
            <span className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={applyUpdate}>
                    {t('update.reload')}
                </button>
                <button
                    type="button"
                    onClick={() => setDismissed(true)}
                    aria-label={t('update.later')}
                    style={{ color: 'inherit', padding: 6, lineHeight: 0 }}
                >
                    <Icon icon={X} size={14} />
                </button>
            </span>
        </div>,
        document.body,
    );
};

export default UpdateNotice;
