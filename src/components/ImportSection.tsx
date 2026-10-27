import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Switch from './Switch';
import { useTranslation } from '../contexts/LanguageContext';
import { ChevronDown, ChevronUp, Check, Copy, TestTube2 } from '../icons';
import { SegmentedList, SegmentedListItem } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';

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
     */
    onImportJson: (
        data: string | ArrayBuffer,
        opts?: { legacyAnalyteFromUnit?: boolean },
    ) => boolean | Promise<boolean>;
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
        return (
            <div className="d-col" style={{ gap: 12 }}>
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
                <div style={{ display: 'flex', gap: 8 }}>
                    <button
                        type="button"
                        onClick={() => { setPreview(null); setPending(null); setLegacyCompat(false); }}
                        className="btn x"
                        style={{ flex: 1 }}
                    >
                        {t('btn.cancel')}
                    </button>
                    <button type="button" onClick={() => void confirm()} className="btn" style={{ flex: 1 }}>
                        <Icon icon={Check} size={16} />
                        {t('btn.confirm')}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="d-col" style={{ gap: 12 }}>
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
