import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { RefreshCw, X } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { onUpdateReady, applyUpdate } from '../utils/swUpdate';

/**
 * "A new version is ready — reload."
 *
 * Deliberately not a forced reload. This app is used mid-task — a dose half entered, a
 * lab report being read off the page — and a refresh imposed at that moment discards
 * work. So the new build waits, the running one keeps working, and this asks. Nothing
 * is lost by waiting: the worker has already installed and is serving the new assets.
 *
 * Shaped like the quick-add confirmation rather than like a browser prompt: a pill in
 * the same bottom slot, a round glyph on the left, the action as the accent on the
 * right. That confirmation is the app's established "something just happened, here is
 * the one thing you can do about it" surface, and a second one with a different shape
 * for the same kind of message would read as a different kind of message.
 *
 * Dismissible, because "later" is a legitimate answer and a notice with no exit is a
 * nuisance. Dismissing hides it for this session only — the build still updates on the
 * next natural open, which is what would have happened anyway.
 */
const UpdateNotice: React.FC = () => {
    const { t } = useTranslation();
    const [ready, setReady] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => onUpdateReady(() => setReady(true)), []);

    if (!ready || dismissed) return null;

    return createPortal(
        <div
            role="status"
            aria-live="polite"
            className="update-notice fixed top-4 left-1/2 z-[95] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-2.5 rounded-full border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-highest)] py-2 pl-2 pr-1.5 shadow-[var(--shadow-m3-3)]"
        >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)]">
                <Icon icon={RefreshCw} size={13} strokeWidth={2.5} />
            </span>
            <span className="min-w-0 flex-1 text-sm font-medium text-[var(--color-m3-on-surface)]">
                {t('update.ready')}
            </span>
            <button
                type="button"
                onClick={applyUpdate}
                className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-[var(--color-m3-primary)] transition-colors hover:bg-[var(--color-m3-primary)]/10"
            >
                {t('update.reload')}
            </button>
            <button
                type="button"
                onClick={() => setDismissed(true)}
                aria-label={t('update.later')}
                className="mr-1 shrink-0 rounded-full p-1.5 text-[var(--color-m3-on-surface-variant)] transition-colors hover:bg-[var(--color-m3-surface-container)]"
            >
                <Icon icon={X} size={13} />
            </button>
        </div>,
        document.body,
    );
};

export default UpdateNotice;
