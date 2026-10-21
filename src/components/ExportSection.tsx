import React, { useState } from 'react';
import Icon from './Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { DoseEvent, LabResult } from '../../logic';
import { Lock, Copy, Check } from '../icons';
import { exportToCSV, exportToPDF } from '../services/export';
import { saveTextFile } from '../utils/saveFile';
import { SegmentedList } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';

interface ExportSectionProps {
    events: DoseEvent[];
    labResults: LabResult[];
    weight: number;
    onExport: (encrypt: boolean, password?: string) => Promise<string | null>;
    onQuickExport?: () => void;
}

const ExportSection: React.FC<ExportSectionProps> = ({ events, labResults, weight, onExport, onQuickExport }) => {
    const { t, lang } = useTranslation();
    const [showEncrypted, setShowEncrypted] = useState(false);
    const [password, setPassword] = useState('');
    const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [jsonCopied, setJsonCopied] = useState(false);

    const hasData = events.length > 0 || labResults.length > 0;

    const handleJsonExport = async () => {
        await onExport(false);
    };

    const handleEncryptedExport = async () => {
        const pw = await onExport(true, password || undefined);
        if (pw) setGeneratedPassword(pw);
    };

    const handleCopyPassword = () => {
        if (!generatedPassword) return;
        navigator.clipboard.writeText(generatedPassword);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleCopyJson = () => {
        if (onQuickExport) {
            onQuickExport();
            setJsonCopied(true);
            setTimeout(() => setJsonCopied(false), 2000);
        }
    };

    const handleCsvExport = () => {
        const csv = exportToCSV({ events, labResults, weight, lang, t });
        saveTextFile(
            `hrt-data-${new Date().toISOString().split('T')[0]}.csv`,
            'text/csv;charset=utf-8;',
            csv,
        );
    };

    if (!hasData) {
        return (
            <div className="card">
                <div className="empty">
                    <SpriteIcon id="db" />
                    <p style={{ marginTop: 8 }}>{t('drawer.empty_export')}</p>
                </div>
            </div>
        );
    }

    /** One export format: icon, label, description, and its own action. */
    const row = (icon: string, label: string, desc: string, action: React.ReactNode) => (
        <div className="li" style={{ alignItems: 'flex-start', cursor: 'default' }}>
            <span className="ic p"><SpriteIcon id={icon} /></span>
            <div className="t">
                <b>{label}</b>
                <span className="s" style={{ whiteSpace: 'normal' }}>{desc}</span>
            </div>
            {action}
        </div>
    );

    return (
        <div className="d-col" style={{ gap: 12 }}>
            <SegmentedList>
                {row('db', 'JSON', t('drawer.save_hint'), (
                    <button type="button" onClick={handleJsonExport} className="btn t" style={{ minWidth: 72 }}>
                        {t('export.btn_json')}
                    </button>
                ))}
                {onQuickExport ? row('download', t('export.btn_copy_json'), t('export.copy_desc'), (
                    <button type="button" onClick={handleCopyJson} className="btn t" style={{ minWidth: 72 }}>
                        <Icon icon={jsonCopied ? Check : Copy} size={15} />
                        {jsonCopied ? t('export.copied') : t('btn.copy')}
                    </button>
                )) : null}
                {row('shield', `JSON (${t('export.encrypt_label')})`, t('export.encrypt_ask_desc'), (
                    <button
                        type="button"
                        onClick={() => { setShowEncrypted(v => !v); setGeneratedPassword(null); }}
                        className="btn t"
                        style={{ minWidth: 72 }}
                    >
                        {showEncrypted ? t('btn.cancel') : t('export.btn_encrypted')}
                    </button>
                ))}
            </SegmentedList>

            {showEncrypted && (
                <div className="card anim-in" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label className="sub" htmlFor="export-password" style={{ margin: 0 }}>{t('export.password_placeholder')}</label>
                    <div style={{ position: 'relative' }}>
                        <input
                            id="export-password"
                            type="password"
                            name="export-encryption-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t('export.password_placeholder')}
                            className="fld"
                            style={{ width: '100%', paddingLeft: 40 }}
                            autoComplete="new-password"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                        />
                        <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', color: 'var(--var)' }}>
                            <Icon icon={Lock} size={15} />
                        </span>
                    </div>
                    <p className="sub" style={{ margin: 0, fontSize: 12 }}>{t('export.password_hint_random')}</p>
                    <button type="button" onClick={handleEncryptedExport} className="btn">
                        {t('export.btn_encrypted')}
                    </button>

                    {generatedPassword && (
                        <div className="list" style={{ marginTop: 4 }}>
                            <div className="li" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, cursor: 'default' }}>
                                <b>{t('export.password_title')}</b>
                                <span className="s" style={{ whiteSpace: 'normal' }}>{t('export.password_desc')}</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', borderRadius: 14, padding: '10px 12px' }}>
                                    <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 13, wordBreak: 'break-all', userSelect: 'all' }}>
                                        {generatedPassword}
                                    </span>
                                    <button type="button" onClick={handleCopyPassword} aria-label={t('btn.copy')} className="btn x" style={{ minWidth: 0 }}>
                                        <Icon icon={copied ? Check : Copy} size={15} />
                                    </button>
                                </div>
                                <button type="button" onClick={() => { setGeneratedPassword(null); setShowEncrypted(false); }} className="btn x" style={{ alignSelf: 'flex-end' }}>
                                    {t('btn.ok')}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            <SegmentedList>
                {row('db', 'CSV', t('export.csv_desc'), (
                    <button type="button" onClick={handleCsvExport} className="btn t" style={{ minWidth: 72 }}>
                        {t('export.btn_csv')}
                    </button>
                ))}
                {row('note', 'PDF', t('export.pdf_desc'), (
                    <button
                        type="button"
                        onClick={() => exportToPDF({ events, labResults, weight, lang, t })}
                        className="btn t"
                        style={{ minWidth: 72 }}
                    >
                        {t('export.btn_pdf')}
                    </button>
                ))}
            </SegmentedList>
        </div>
    );
};

export default ExportSection;
