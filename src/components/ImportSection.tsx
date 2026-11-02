import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Switch from './Switch';
import RestoreConfirmDialog from './RestoreConfirmDialog';
import { useTranslation } from '../contexts/LanguageContext';
import { ChevronDown, ChevronUp, Check, Copy, TestTube2, TriangleWarning } from '../icons';
import { SegmentedList, SegmentedListItem } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import type { RestorePreview } from '../hooks/useCoreSync';

/** How an import treats what is already in the account. */
export type ImportMode = 'merge' | 'overwrite';

/** What an import would bring in, counted before anything is written. */
export interface ImportPreview {
    source: string;
    doses: number;
    labs: number;
    /** Labs with no analyte (a backup from before the field existed). */
    legacyLabs?: number;
}

interface ImportSectionProps {
    /**
     * Imports a file's contents. Accepts bytes as well as text because one supported
     * source (Featherline) exports a binary container rather than JSON.
     *
     * `mode` is only ever `overwrite` when `canOverwrite` is true; the caller still owns
     * the decision because replacing the account needs a signed-in session.
     */
    onImportJson: (
        data: string | ArrayBuffer,
        opts?: { legacyAnalyteFromUnit?: boolean; mode?: ImportMode },
    ) => boolean | Promise<boolean>;
    /** Whether "replace the cloud" is available at all (a signed-in Core session). */
    canOverwrite?: boolean;
    /**
     * Why the replace action is unavailable, so the disabled zone can say something
     * more useful than "disabled". Omitted while the capability is still unknown.
     */
    restoreDisabledReason?: 'signed-out' | 'server-off';
    /** Reads the account and describes what replacing it would delete. */
    onRestorePreview?: (data: string | ArrayBuffer) => Promise<RestorePreview | null>;
    /** Counts the payload without applying it. */
    onPreview?: (data: string | ArrayBuffer) => Promise<ImportPreview | null>;
    /**
     * Plaintext that only became readable after the password step.
     *
     * A protected file cannot be counted before it is opened, so the importer
     * hands the decrypted text back here and the ordinary review runs on it —
     * including the legacy-analyte switch, which a password would otherwise hide.
     */
    review?: { data: string; nonce: number } | null;
    /** Called once `review` has been turned into a preview, so it is not replayed. */
    onReviewConsumed?: () => void;
}

/**
 * Import, in two steps: read/count, then confirm. The file is never merged on
 * the same tap that chose it.
 */
const ImportSection: React.FC<ImportSectionProps> = ({
    onImportJson,
    canOverwrite = false,
    restoreDisabledReason,
    onRestorePreview,
    onPreview,
    review,
    onReviewConsumed,
}) => {
    const { t } = useTranslation();
    const [showPaste, setShowPaste] = useState(false);
    const [text, setText] = useState('');
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [pending, setPending] = useState<string | ArrayBuffer | null>(null);
    const [busy, setBusy] = useState(false);
    const [legacyCompat, setLegacyCompat] = useState(false);
    /**
     * The destructive path is its own dialog, not a mode toggle next to the safe
     * button: merging can never remove anything, so it stays the primary action and
     * the only way to replace the account is to open the danger zone deliberately.
     */
    const [confirmOpen, setConfirmOpen] = useState(false);
    /** Merge is the default; the overwrite card below only exists while this is on. */
    const [overwrite, setOverwrite] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    /** The review already shown, so a re-render cannot replay it. */
    const consumedReview = useRef<number | null>(null);

    const begin = async (data: string | ArrayBuffer) => {
        if (!onPreview) {
            await onImportJson(data);
            return;
        }
        setBusy(true);
        const counted = await onPreview(data).catch(() => null);
        setBusy(false);
        if (!counted) {
            await onImportJson(data);
            return;
        }
        setLegacyCompat((counted.legacyLabs ?? 0) > 0);
        setPreview(counted);
        setPending(data);
    };

    const confirm = async () => {
        if (pending === null) return;
        const data = pending;
        setPreview(null);
        setPending(null);
        await onImportJson(data, { legacyAnalyteFromUnit: legacyCompat });
        setLegacyCompat(false);
        setText('');
        setShowPaste(false);
    };

    // Stable identity: the dialog re-reads on open, not on every parent render. An
    // inline arrow here reset the backup/acknowledgement state whenever the caller
    // re-rendered, which silently re-armed close to a destructive action.
    const loadRestorePreview = useCallback(
        () => (pending !== null && onRestorePreview ? onRestorePreview(pending) : Promise.resolve(null)),
        [pending, onRestorePreview],
    );

    const resetReview = () => {
        setOverwrite(false);
        setPreview(null);
        setPending(null);
        setLegacyCompat(false);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            await begin(reader.result as string | ArrayBuffer);
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
    };

    // A password-protected file reaches its review only after decryption, which
    // happens outside this component. The nonce guard also absorbs StrictMode's
    // double effect: the ref survives the remount, so the second run is a no-op.
    useEffect(() => {
        if (!review || consumedReview.current === review.nonce) return;
        consumedReview.current = review.nonce;
        void begin(review.data).finally(() => onReviewConsumed?.());
    }, [review, onReviewConsumed]);

    if (preview) {
        const disabledCopy = restoreDisabledReason === 'signed-out'
            ? t('restore.disabled_signed_out')
            : t('restore.disabled_server');
        return (
            <div className="d-col" style={{ gap: 12 }}>
                <p className="sub">{t('import.merge_note')}</p>
                <SegmentedList label={t('import.title')}>
                    <SegmentedListItem icon={undefined} sprite="code" title={preview.source} subtitle={t('import.title')} />
                    <SegmentedListItem sprite="db" title={`${preview.doses}`} subtitle={t('timeline.records')} />
                    <SegmentedListItem sprite="tube" title={`${preview.labs}`} subtitle={t('lab.title')} />
                </SegmentedList>
                {(preview.legacyLabs ?? 0) > 0 && (
                    <SegmentedList>
                        <div className="li" style={{ cursor: 'default' }}>
                            <span className="ic p"><Icon icon={TestTube2} size={22} /></span>
                            <div className="t">
                                <b>{t('import.legacy_analyte').replace('{n}', String(preview.legacyLabs))}</b>
                                <span className="s" style={{ whiteSpace: 'normal' }}>{t('import.legacy_analyte_hint')}</span>
                            </div>
                            <Switch
                                checked={legacyCompat}
                                onChange={setLegacyCompat}
                                label={t('import.legacy_analyte').replace('{n}', String(preview.legacyLabs))}
                            />
                        </div>
                    </SegmentedList>
                )}

                {/* The mode is the switch; the card below only exists while it is on. Not
                    signed in means there is no cloud to name, so the line stays mode-only. */}
                <SegmentedList>
                    <div className="li" style={{ cursor: canOverwrite ? 'pointer' : 'default', minHeight: 56 }}>
                        <span className="ic"><SpriteIcon id="db" /></span>
                        <div className="t" onClick={() => canOverwrite && setOverwrite(v => !v)}>
                            <b>{overwrite ? t('import.mode_overwrite_current') : t('import.mode_merge_current')}</b>
                        </div>
                        <Switch
                            checked={overwrite}
                            onChange={setOverwrite}
                            disabled={!canOverwrite}
                            label={t('import.mode_switch_label')}
                        />
                    </div>
                </SegmentedList>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={resetReview} className="btn x" style={{ flex: 1 }}>
                        {t('btn.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={() => (overwrite && canOverwrite ? setConfirmOpen(true) : void confirm())}
                        className="btn"
                        style={{
                            flex: 1,
                            ...(overwrite && canOverwrite ? { background: 'var(--errc)', color: 'var(--onerrc)' } : {}),
                        }}
                    >
                        <Icon icon={Check} size={16} />
                        {t(overwrite && canOverwrite ? 'import.overwrite_action' : 'import.merge_action')}
                    </button>
                </div>

                {/* The warning itself, not another entry: 覆盖导入 is the button that
                    opens the dialog, so this card only has to say what will happen. */}
                {overwrite && canOverwrite && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        width: '100%',
                        marginTop: 6,
                        padding: 14,
                        borderRadius: 26,
                        border: '1px solid color-mix(in srgb, var(--err) 18%, transparent)',
                        background: 'var(--errc)',
                        textAlign: 'left',
                    }}
                >
                    <span
                        aria-hidden="true"
                        style={{
                            display: 'grid',
                            placeItems: 'center',
                            flex: 'none',
                            width: 42,
                            height: 42,
                            borderRadius: '50%',
                            background: 'color-mix(in srgb, var(--err) 15%, transparent)',
                            color: 'var(--err)',
                        }}
                    >
                        <Icon icon={TriangleWarning} size={20} />
                    </span>
                    <span style={{ minWidth: 0, display: 'block' }}>
                        <span style={{ display: 'block', fontSize: 14.5, fontWeight: 600, lineHeight: 1.3, color: 'var(--onerrc)' }}>
                            {t('restore.entry_title')}
                        </span>
                        <span className="s" style={{ display: 'block', margin: 0, whiteSpace: 'normal' }}>
                            {restoring ? t('restore.busy') : t('restore.entry_body')}
                        </span>
                    </span>
                </div>
                )}

                <RestoreConfirmDialog
                    open={confirmOpen}
                    onClose={() => setConfirmOpen(false)}
                    load={loadRestorePreview}
                    onConfirm={async () => {
                        if (pending === null) return false;
                        const data = pending;
                        setRestoring(true);
                        const ok = await onImportJson(data, {
                            legacyAnalyteFromUnit: legacyCompat,
                            mode: 'overwrite',
                        });
                        setRestoring(false);
                        resetReview();
                        return ok;
                    }}
                />
            </div>
        );
    }

    return (
        <div className="d-col" style={{ gap: 12 }}>
            <p className="sub">{t('import.merge_note')}</p>
            <SegmentedList>
                <div className="li" style={{ cursor: 'default' }}>
                    <span className="ic p"><SpriteIcon id="upload" /></span>
                    <div className="t">
                        <b>{t('import.file')}</b>
                        <span className="s" style={{ whiteSpace: 'normal' }}>{t('import.file_desc')}</span>
                    </div>
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy}
                        className="btn t"
                        style={{ minWidth: 72, opacity: busy ? .45 : 1 }}
                    >
                        {t('import.file_btn')}
                    </button>
                </div>
                <div
                    className="li tap"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setShowPaste(v => !v)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowPaste(v => !v); } }}
                >
                    <span className="ic"><SpriteIcon id="code" /></span>
                    <div className="t">
                        <b>{t('import.text')}</b>
                        <span className="s" style={{ whiteSpace: 'normal' }}>{t('import.paste_hint')}</span>
                    </div>
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setShowPaste(v => !v); }}
                        aria-expanded={showPaste}
                        aria-label={t('import.text')}
                        className="btn x"
                        style={{ minWidth: 0 }}
                    >
                        <Icon icon={showPaste ? ChevronUp : ChevronDown} size={18} />
                    </button>
                </div>
            </SegmentedList>

            <input
                ref={fileInputRef}
                type="file"
                accept=".json,.hrtbackup,application/json,application/octet-stream"
                style={{ display: 'none' }}
                onChange={handleFileChange}
            />

            {showPaste && (
                <div className="card anim-in" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <textarea
                        className="fld"
                        style={{ height: 128, padding: 14, fontFamily: 'ui-monospace, monospace', resize: 'none' }}
                        placeholder={t('import.paste_hint')}
                        value={text}
                        onChange={e => setText(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                    />
                    <div className="hrow" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <button
                            type="button"
                            onClick={async () => {
                                try {
                                    const clip = await navigator.clipboard.readText();
                                    if (clip) setText(clip);
                                } catch {
                                    // clipboard unavailable
                                }
                            }}
                            className="btn t"
                            style={{ minWidth: 90 }}
                        >
                            <Icon icon={Copy} size={15} />
                            <span>{t('import.btn_paste')}</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => void begin(text)}
                            disabled={!text.trim() || busy}
                            className="btn"
                            style={{ minWidth: 80, opacity: text.trim() && !busy ? 1 : .4 }}
                        >
                            <Icon icon={Check} size={16} />
                            <span>{t('drawer.import')}</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ImportSection;
