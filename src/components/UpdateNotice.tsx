import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import FloatingToast from './ui/FloatingToast';
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
 * Anchored to the *top*, unlike the quick-add undo at the bottom. Both edges are
 * spoken for on a phone: the bottom belongs to the M3 navigation bar, and a notice
 * that has to sit above it is a notice competing with the tab bar for the same thumb
 * space. The top edge is empty, so the update prompt lives there and the two notices
 * never stack.
 *
 * Dismissible, because "later" is a legitimate answer and a notice with no exit is a
 * nuisance. Dismissing hides it for this session only — the build still updates on the
 * next natural open, which would have happened anyway.
 */
const UpdateNotice: React.FC = () => {
    const { t } = useTranslation();
    const [ready, setReady] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => onUpdateReady(() => setReady(true)), []);

    return (
        <FloatingToast
            open={ready && !dismissed}
            edge="top"
            icon={<Icon icon={RefreshCw} size={13} strokeWidth={2.5} />}
            onDismiss={() => setDismissed(true)}
            actions={
                <>
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
                </>
            }
        >
            {t('update.ready')}
        </FloatingToast>
    );
};

export default UpdateNotice;
