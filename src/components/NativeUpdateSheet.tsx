import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { RefreshCw } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { AdaptiveSheet } from '../ui/proto/AdaptiveSheet';
import { downloadNativeUpdate, type UpdatePhase } from '../utils/nativeUpdate';
import { closeUpdateSheet, useUpdateSheet } from '../utils/updateSheet';

/**
 * The Android update prompt, as an M3E bottom sheet.
 *
 * It replaced a card pinned to the top edge. The card had two problems that only
 * showed up in use: it was not the app's own vocabulary (every other transient
 * surface here is a sheet), and its progress was invisible from anywhere but that
 * card — so "check for updates" in Settings could start a download the user never
 * saw. The sheet is opened by both entry points and owns the progress, so whichever
 * way you got here, you are looking at the thing that is happening.
 *
 * Why a sheet rather than a dialog: an APK replace asks the user to leave the app
 * and install something, so it owes them the changelog, and a changelog is a list.
 */

/** How many changelog lines to show before folding the rest behind a toggle. */
const MAX_NOTES = 4;

export const NativeUpdateSheet: React.FC = () => {
    const update = useUpdateSheet();
    const { t } = useTranslation();
    const [phase, setPhase] = useState<UpdatePhase>('idle');
    const [pct, setPct] = useState(0);
    const [expanded, setExpanded] = useState(false);

    // A new update (or a fresh open) starts from a clean slate: the previous
    // attempt's "failed" must not greet someone checking again.
    useEffect(() => {
        if (!update) {
            setPhase('idle');
            setPct(0);
            setExpanded(false);
        }
    }, [update]);

    // "Installing" means the system installer is on screen. Coming back to the app
    // without it having replaced us means the user cancelled — and a button stuck on
    // "installing" would then be a dead end, because it is disabled while busy.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible') setPhase((p) => (p === 'installing' ? 'idle' : p));
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, []);

    if (!update) return null;

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

    const allNotes = update.notes;
    const hasMore = allNotes.length > MAX_NOTES;
    const notes = expanded || !hasMore ? allNotes : allNotes.slice(0, MAX_NOTES);
    const hidden = allNotes.length - notes.length;

    return (
        <AdaptiveSheet
            open
            onClose={closeUpdateSheet}
            title={t('update.native_ready').replace('{version}', update.version)}
            closeLabel={t('update.later')}
            footer={
                <button
                    type="button"
                    className="btn"
                    onClick={start}
                    disabled={busy}
                    style={{ width: '100%', minHeight: 48 }}
                >
                    {busy ? (
                        <span className="flex items-center justify-center gap-2">
                            <Icon icon={RefreshCw} size={16} />
                            {label}
                        </span>
                    ) : label}
                </button>
            }
        >
            {notes.length > 0 && (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {notes.map((note, i) => (
                        <li key={i} className="flex gap-2" style={{ paddingBlock: 6 }}>
                            <span
                                aria-hidden
                                style={{
                                    marginTop: 8,
                                    width: 4,
                                    height: 4,
                                    borderRadius: 2,
                                    background: 'var(--out)',
                                    flexShrink: 0,
                                }}
                            />
                            <span style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--var)' }}>{note}</span>
                        </li>
                    ))}
                </ul>
            )}

            {hasMore && (
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    style={{
                        marginTop: 8,
                        border: 0,
                        background: 'none',
                        padding: 0,
                        color: 'var(--pri)',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                    }}
                >
                    {expanded ? t('update.less') : t('update.more').replace('{n}', String(hidden))}
                </button>
            )}

            {phase === 'downloading' && (
                <div
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    style={{
                        marginTop: 16,
                        height: 6,
                        borderRadius: 3,
                        background: 'var(--sch-h)',
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            width: `${pct}%`,
                            height: '100%',
                            borderRadius: 3,
                            background: 'var(--pri)',
                            transition: 'width 180ms linear',
                        }}
                    />
                </div>
            )}

            {phase === 'permission' && (
                <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--warn)' }}>
                    {t('update.perm_hint')}
                </p>
            )}
            {phase === 'error' && (
                <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--err)' }}>
                    {t('update.failed')}
                </p>
            )}
        </AdaptiveSheet>
    );
};
