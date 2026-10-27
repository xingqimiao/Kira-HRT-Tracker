import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { openExternalUrl } from '../utils/externalLinks';
import ImportSection from '../components/ImportSection';
import { HeaderBack } from '../ui/proto';

interface ImportSettingsProps {
    /** Accepts bytes too — see `ImportSection` for why (Featherline is binary). */
    onImportJson: (data: string | ArrayBuffer, opts?: { legacyAnalyteFromUnit?: boolean }) => boolean | Promise<boolean>;
    /** Counts the payload before it is merged — see `ImportSection`. */
    onPreview?: (data: string | ArrayBuffer) => Promise<import('../components/ImportSection').ImportPreview | null>;
    /** Plaintext that only became readable after a password step. */
    review?: { data: string; nonce: number } | null;
    onReviewConsumed?: () => void;
    onBack: () => void;
}

const ImportSettings: React.FC<ImportSettingsProps> = ({
    onImportJson,
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
                onPreview={onPreview}
                review={review}
                onReviewConsumed={onReviewConsumed}
            />

            {/* The Chinese guide carries the field tables, worked example code and a
                prompt to hand an assistant; the English spec stays the authority. */}
            <p className="sub" style={{ margin: '4px 6px 0', fontSize: 12, lineHeight: 1.6 }}>
                {t('import.format_doc')}{' '}
                <button
                    type="button"
                    onClick={() => void openExternalUrl('https://github.com/xingqimiao/Kira-HRT-Tracker/blob/HEAD/docs/hrt-import-export-protocol.zh-CN.md')}
                    style={{ color: 'var(--pri)', textDecoration: 'underline', textUnderlineOffset: 2 }}
                >
                    docs/hrt-import-export-protocol.zh-CN.md
                </button>
            </p>
        </div>
    );
};

export default ImportSettings;
