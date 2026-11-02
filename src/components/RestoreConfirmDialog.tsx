import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import Switch from './Switch';
import { Download, TriangleWarning } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';
import { AdaptiveSheet, useMediaQuery } from '../ui/proto';
import { saveTextFile } from '../utils/saveFile';
import type { RestorePreview } from '../hooks/useCoreSync';

/**
 * The second gate on "replace the cloud".
 *
 * It shows what would actually disappear — counted from the account's own records,
 * not from the file — and it does not enable the destructive button until the current
 * state has been saved to a file and the deletion has been acknowledged. The caller
 * still owns the write; this component never restores anything by itself.
 */

interface RestoreConfirmDialogProps {
    open: boolean;
    onClose: () => void;
    /** Reads the account and describes the difference. */
    load: () => Promise<RestorePreview | null>;
    /**
     * Performs the replace. Resolves true when the server accepted it; the caller
     * closes this dialog and reports the outcome itself.
     */
    onConfirm: () => Promise<boolean>;
}

const CATEGORY_KEY: Record<string, string> = {
    dose: 'restore.cat.dose',
    lab: 'restore.cat.lab',
    journal: 'restore.cat.journal',
    note: 'restore.cat.note',
    setting: 'restore.cat.setting',
};

const RestoreConfirmDialog: React.FC<RestoreConfirmDialogProps> = ({ open, onClose, load, onConfirm }) => {
    const { t } = useTranslation();
    const desktop = useMediaQuery('(min-width: 760px)');
    const { mounted, state } = usePresence(open, 200);

    const [preview, setPreview] = useState<RestorePreview | null>(null);
    const [failed, setFailed] = useState(false);
    const [backupSaved, setBackupSaved] = useState(false);
    const [ack, setAck] = useState(false);
    const [busy, setBusy] = useState(false);

    useEscape(onClose, open && !busy);

    // The caller builds `load` inline, so its identity changes on every parent
    // render (a sync tick is enough). Reading through a ref keeps the fetch tied to
    // the open, not to the parent: otherwise the backup and the acknowledgement are
    // wiped out from under the user mid-flow and the button silently re-disables.
    const loadRef = useRef(load);
    loadRef.current = load;

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setPreview(null);
        setFailed(false);
        setBackupSaved(false);
        setAck(false);
        setBusy(false);
        void loadRef.current().then(result => {
            if (cancelled) return;
            if (result) setPreview(result);
            else setFailed(true);
        });
        return () => { cancelled = true; };
    }, [open]);

    const downloadBackup = () => {
        if (!preview) return;
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
        saveTextFile(`hrt-cloud-backup-${stamp}.json`, 'application/json', preview.backup);
        setBackupSaved(true);
    };

    const canConfirm = Boolean(preview) && backupSaved && ack && !busy;

    const confirm = async () => {
        if (!canConfirm) return;
        setBusy(true);
        const ok = await onConfirm();
        setBusy(false);
        if (ok) onClose();
    };

    const diff = preview?.diff;
    const body = (
        <div className="d-col" style={{ gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="ic err" aria-hidden="true" style={{ flex: 'none' }}>
                    <Icon icon={TriangleWarning} size={22} />
                </span>
                {/* The boxes are centred but the glyph ink is not: this font leaves ~3px more
                    space below the em box than above, so the title is offset to match the icon. */}
                <b style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.3, transform: 'translateY(-3px)' }}>{t('restore.title')}</b>
            </div>

            {!preview && !failed && (
                <p className="sub" style={{ margin: 0 }}>{t('restore.loading')}</p>
            )}
            {failed && (
                <p className="sub" role="alert" style={{ margin: 0, color: 'var(--err)' }}>
                    {t('restore.load_failed')}
                </p>
            )}

            {diff && (
                <>
                    <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>
                        {t('restore.summary')
                            .replace('{cloud}', String(diff.cloudRecords))
                            .replace('{file}', String(diff.importRecords))}
                    </p>

                    <div className="d-col" style={{ gap: 6 }}>
                        {[
                            { key: 'restore.removed', n: diff.removed, tone: 'var(--err)' },
                            { key: 'restore.added', n: diff.added, tone: 'inherit' },
                            { key: 'restore.changed', n: diff.changed, tone: 'inherit' },
                            { key: 'restore.unchanged', n: diff.unchanged, tone: 'var(--var)' },
                        ].map(row => (
                            <div key={row.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                                <span className="sub" style={{ margin: 0 }}>{t(row.key)}</span>
                                <b style={{ fontVariantNumeric: 'tabular-nums', color: row.tone }}>{row.n}</b>
                            </div>
                        ))}
                    </div>

                    {diff.categories.length > 0 && (
                        <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>
                            {t('restore.categories')} · {diff.categories.map(c => {
                                const parts = [];
                                if (c.removed) parts.push(`-${c.removed}`);
                                if (c.added) parts.push(`+${c.added}`);
                                return `${t(CATEGORY_KEY[c.category] ?? 'restore.cat.other')} ${parts.join('/')}`;
                            }).join(' · ')}
                        </p>
                    )}

                    {diff.settingsChanged && (
                        <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>{t('restore.settings')}</p>
                    )}

                    <button
                        type="button"
                        className="btn t"
                        style={{ width: '100%', height: 48, justifyContent: 'center' }}
                        onClick={downloadBackup}
                    >
                        <Icon icon={Download} size={18} />
                        {t(backupSaved ? 'restore.backup_done' : 'restore.backup')}
                    </button>
                    {!backupSaved && (
                        <p className="sub" style={{ margin: 0, fontSize: 12 }}>{t('restore.backup_hint')}</p>
                    )}

                    <div
                        role="group"
                        aria-labelledby="restore-ack-text"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            minHeight: 48,
                            paddingTop: 4,
                        }}
                        onClick={event => {
                            // The switch handles its own click; the row is a bigger target.
                            if ((event.target as HTMLElement).closest('.m3-switch')) return;
                            setAck(v => !v);
                        }}
                    >
                        <span id="restore-ack-text" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                            {t('restore.ack').replace('{n}', String(diff.removed))}
                        </span>
                        <Switch checked={ack} onChange={setAck} label={t('restore.ack').replace('{n}', String(diff.removed))} />
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="btn x" style={{ flex: 1, height: 48 }} onClick={onClose}>
                            {t('btn.cancel')}
                        </button>
                        <button
                            type="button"
                            className="btn"
                            style={{
                                flex: 1,
                                height: 48,
                                background: canConfirm ? 'var(--err)' : 'var(--surf2, var(--surf))',
                                color: canConfirm ? 'var(--onerrc)' : 'var(--var)',
                                opacity: canConfirm ? 1 : .55,
                            }}
                            disabled={!canConfirm}
                            aria-busy={busy}
                            onClick={() => void confirm()}
                        >
                            {t(busy ? 'restore.busy' : 'restore.confirm_action')}
                        </button>
                    </div>
                </>
            )}

            {failed && (
                <button type="button" className="btn" style={{ width: '100%', height: 48 }} onClick={onClose}>
                    {t('btn.close')}
                </button>
            )}
        </div>
    );

    if (!desktop) {
        return (
            <AdaptiveSheet open={open} onClose={onClose} bare closeLabel={t('btn.close')}>
                {body}
            </AdaptiveSheet>
        );
    }

    if (!mounted) return null;

    return createPortal(
        <div className="modal-overlay z-[60]" data-state={state}>
            <div className="modal-shell">
                <div className="modal-card">{body}</div>
            </div>
        </div>,
        document.body,
    );
};

export default RestoreConfirmDialog;
