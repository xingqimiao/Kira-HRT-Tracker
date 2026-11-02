import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { openExternalUrl } from '../utils/externalLinks';
import ImportSection from '../components/ImportSection';
import { HeaderBack } from '../ui/proto';

interface ImportSettingsProps {
    /** Accepts bytes too — see `ImportSection` for why (Featherline is binary). */
    onImportJson: (
        data: string | ArrayBuffer,
        opts?: { legacyAnalyteFromUnit?: boolean; mode?: import('../components/ImportSection').ImportMode },
    ) => boolean | Promise<boolean>;
    /** Whether the signed-in session allows replacing the cloud, not just merging. */
    canOverwrite?: boolean;
    /** Why the replace action is unavailable, when it is. */
    restoreDisabledReason?: 'signed-out' | 'server-off';
    /** Reads the account and describes what replacing it would delete. */
    onRestorePreview?: (data: string | ArrayBuffer) => Promise<import('../hooks/useCoreSync').RestorePreview | null>;
    /** Counts the payload before it is merged — see `ImportSection`. */
    onPreview?: (data: string | ArrayBuffer) => Promise<import('../components/ImportSection').ImportPreview | null>;
    /** Plaintext that only became readable after a password step. */
    review?: { data: string; nonce: number } | null;
    onReviewConsumed?: () => void;
    onBack: () => void;
}

const ImportSettings: React.FC<ImportSettingsProps> = ({
    onImportJson,
    canOverwrite = false,
    restoreDisabledReason,
    onRestorePreview,
    onPreview,
    review,
    onReviewConsumed,
    onBack,
}) => {
    const { t } = useTranslation();

    return (
        <div className="pg on long" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }}>
            <HeaderBack title={t('import.title')} onBack={onBack} backLabel={t('core.back')} />
            <ImportSection
                onImportJson={onImportJson}
                canOverwrite={canOverwrite}
                restoreDisabledReason={restoreDisabledReason}
                onRestorePreview={onRestorePreview}
                onPreview={onPreview}
                review={review}
                onReviewConsumed={onReviewConsumed}
            />

            {/* The Chinese guide carries the field tables, worked example code and a
                prompt to hand an assistant; the English spec stays the authority. */}
            <p className="sub" style={{ margin: '4px 6px 0', fontSize: 12, lineHeight: 1.6 }}>
                <button
                    type="button"
                    onClick={() => void openExternalUrl('https://github.com/xingqimiao/Kira-HRT-Tracker/blob/HEAD/docs/hrt-import-export-protocol.zh-CN.md')}
                    style={{
                        padding: 0,
                        border: 0,
                        background: 'none',
                        font: 'inherit',
                        color: 'var(--pri)',
                        textDecoration: 'underline',
                        textUnderlineOffset: 2,
                    }}
                >
                    {t('import.format_link')} ↗
                </button>
            </p>
        </div>
    );
};

export default ImportSettings;
