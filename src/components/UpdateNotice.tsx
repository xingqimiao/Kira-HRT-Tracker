import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import FloatingToast from './ui/FloatingToast';
import { RefreshCw, X } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { onUpdateReady, applyUpdate } from '../utils/swUpdate';
import { checkNativeUpdate, downloadNativeUpdate, type NativeUpdate, type UpdatePhase } from '../utils/nativeUpdate';
import { isNativeApp } from '../utils/platform';

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
 *
 * The *web* prompt is one line ("A new version is ready" + Update), so it rides the
 * single-line `FloatingToast` pill. The *native* one is a card instead: an APK replace
 * asks the user to leave the app and install something, so it owes them the changelog,
 * and a changelog is a list — the pill's one-line `rounded-full` shell reflowed five
 * notes into an unreadable paragraph. See `NativeUpdateCard` below.
 */
const UpdateNotice: React.FC = () => {
    const { t } = useTranslation();
    const [ready, setReady] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [nativeUpdate, setNativeUpdate] = useState<NativeUpdate | null>(null);

    useEffect(() => {
        if (isNativeApp()) {
            void checkNativeUpdate().then(setNativeUpdate).catch(() => {});
            return;
        }
        return onUpdateReady(() => setReady(true));
    }, []);

    if (isNativeApp() && nativeUpdate) {
        return (
            <NativeUpdateCard
                update={nativeUpdate}
                open={!dismissed}
                onDismiss={() => setDismissed(true)}
            />
        );
    }

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
                        className="shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold text-[var(--color-m3-primary)] transition-colors hover:bg-[var(--color-m3-primary)]/10"
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

/** How many changelog lines the card lists before folding the rest into "…". */
const MAX_NOTES = 4;

/**
 * The native update prompt: a card at the top edge, not the shared pill.
 *
 * Left as its own element rather than added to `FloatingToast` because the two want
 * different shells — a one-line pill and a multi-line card — and forcing one component
 * to be both would cost more than the few lines here. It borrows the same top-edge
 * placement and swipe-to-dismiss gesture is intentionally NOT offered: a destructive
 * "throw it away" on a prompt whose only job is to inform reads as discarding the
 * update. The close button is the dismissal.
 */
const NativeUpdateCard: React.FC<{
    update: NativeUpdate;
    open: boolean;
    onDismiss: () => void;
}> = ({ update, open, onDismiss }) => {
    const { t } = useTranslation();
    const [entered, setEntered] = useState(false);
    // The hand-off to the system installer is a native, multi-second job (download,
    // then a prompt), so the card reflects each phase instead of closing on the tap
    // and looking like the tap did nothing.
    const [phase, setPhase] = useState<UpdatePhase>('idle');
    const [pct, setPct] = useState(0);
    useEffect(() => {
        if (!open) { setEntered(false); return; }
        const id = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(id);
    }, [open]);
    if (!open) return null;

    const start = () => {
        setPhase('downloading');
        setPct(0);
        downloadNativeUpdate(update, {
            onProgress: setPct,
            onInstalling: () => setPhase('installing'),
            onPermission: () => setPhase('permission'),
            onError: () => setPhase('error'),
        });
    };

    const busy = phase === 'downloading' || phase === 'installing';
    const label = phase === 'downloading'
        ? t('update.downloading').replace('{pct}', String(pct))
        : phase === 'installing'
            ? t('update.installing')
            : phase === 'permission' || phase === 'error'
                ? t('update.retry')
                : t('update.download');

    const notes = update.notes.slice(0, MAX_NOTES);
    const extra = update.notes.length - notes.length;

    return createPortal(
        <div
            className="fixed inset-x-0 z-[95] flex justify-center px-4"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
        >
            <div
                role="status"
                aria-live="polite"
                className="w-full max-w-[24rem] rounded-[var(--radius-lg)] border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-highest)] p-4 shadow-[var(--shadow-m3-3)]"
                style={{
                    transform: entered ? 'none' : 'translateY(-18px) scale(0.97)',
                    opacity: entered ? 1 : 0,
                    transition: 'transform 220ms var(--md-sys-motion-easing-emphasized-decelerate, cubic-bezier(0.2,0,0,1)), opacity 220ms linear',
                }}
            >
                <div className="flex items-start gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)]">
                        <Icon icon={RefreshCw} size={14} strokeWidth={2.5} />
                    </span>
                    <p className="min-w-0 flex-1 pt-0.5 text-sm font-semibold text-[var(--color-m3-on-surface)]">
                        {t('update.native_ready').replace('{version}', update.version)}
                    </p>
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label={t('update.later')}
                        className="-mr-1 -mt-1 shrink-0 rounded-full p-1.5 text-[var(--color-m3-on-surface-variant)] transition-colors hover:bg-[var(--color-m3-surface-container)]"
                    >
                        <Icon icon={X} size={14} />
                    </button>
                </div>

                {(phase === 'idle') && notes.length > 0 && (
                    <ul className="mt-3 space-y-1.5 ps-1 text-xs leading-relaxed text-[var(--color-m3-on-surface-variant)]">
                        {notes.map((note, i) => (
                            <li key={i} className="flex gap-2">
                                <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--color-m3-outline)]" />
                                <span className="min-w-0">{note}</span>
                            </li>
                        ))}
                        {extra > 0 && <li className="ps-3 opacity-70">{t('update.more').replace('{n}', String(extra))}</li>}
                    </ul>
                )}

                {phase === 'permission' && (
                    <p className="mt-3 text-xs leading-relaxed text-[var(--color-m3-on-surface-variant)]">
                        {t('update.perm_hint')}
                    </p>
                )}
                {phase === 'error' && (
                    <p className="mt-3 text-xs leading-relaxed text-[var(--color-m3-error)]">
                        {t('update.failed')}
                    </p>
                )}

                {/* Determinate while downloading; an indeterminate filler bar while the
                    installer is coming up, so the button always shows it is working. */}
                {(phase === 'downloading' || phase === 'installing') && (
                    <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-[var(--color-m3-surface-container)]">
                        <div
                            className={`h-full rounded-full bg-[var(--color-m3-primary)] ${phase === 'installing' ? 'w-full animate-pulse' : ''}`}
                            style={phase === 'installing' ? undefined : { width: `${pct}%` }}
                        />
                    </div>
                )}

                <button
                    type="button"
                    onClick={start}
                    disabled={busy}
                    className="mt-4 w-full rounded-full bg-[var(--color-m3-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--color-m3-on-primary)] transition-colors hover:brightness-105 disabled:opacity-70"
                >
                    {label}
                </button>
            </div>
        </div>,
        document.body,
    );
};

export default UpdateNotice;
