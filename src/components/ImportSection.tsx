import React, { useState, useRef } from 'react';
import Icon from './Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { ChevronDown, ChevronUp, Check, Copy } from '../icons';
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
}

/**
 * Import, in two steps: read/count, then confirm. The file is never merged on
 * the same tap that chose it.
 */
const ImportSection: React.FC<ImportSectionProps> = ({ onImportJson, onPreview }) => {
    const { t } = useTranslation();
    const [showPaste, setShowPaste] = useState(false);
    const [text, setText] = useState('');
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [pending, setPending] = useState<string | ArrayBuffer | null>(null);
    const [busy, setBusy] = useState(false);
    const [legacyCompat, setLegacyCompat] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

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

    if (preview) {
        return (
            <div className="d-col" style={{ gap: 12 }}>
                <SegmentedList label={t('import.title')}>
                    <SegmentedListItem icon={undefined} sprite="code" title={preview.source} subtitle={t('import.title')} />
                    <SegmentedListItem sprite="db" title={`${preview.doses}`} subtitle={t('timeline.records')} />
                    <SegmentedListItem sprite="tube" title={`${preview.labs}`} subtitle={t('lab.title')} />
                </SegmentedList>
                {(preview.legacyLabs ?? 0) > 0 && (
                    <label
                        className="card"
                        style={{ display: 'flex', gap: 10, padding: 12, alignItems: 'flex-start', cursor: 'pointer' }}
                    >
                        <input
                            type="checkbox"
                            checked={legacyCompat}
                            onChange={e => setLegacyCompat(e.target.checked)}
                            style={{ marginTop: 3, flex: 'none' }}
                        />
                        <span>
                            <b style={{ display: 'block' }}>
                                {t('import.legacy_analyte').replace('{n}', String(preview.legacyLabs))}
                            </b>
                            <span className="sub" style={{ fontSize: 12, lineHeight: 1.5 }}>
                                {t('import.legacy_analyte_hint')}
                            </span>
                        </span>
                    </label>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                    <button
                        type="button"
                        onClick={() => { setPreview(null); setPending(null); setLegacyCompat(false); }}
                        className="btn t"
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
