import React from 'react';
import Icon from '../components/Icon';
import { ArrowLeft } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import ImportSection from '../components/ImportSection';

interface ImportSettingsProps {
    /** Accepts bytes too — see `ImportSection` for why (Featherline is binary). */
    onImportJson: (data: string | ArrayBuffer) => boolean | Promise<boolean>;
    onBack: () => void;
}

const ImportSettings: React.FC<ImportSettingsProps> = ({ onImportJson, onBack }) => {
    const { t } = useTranslation();

    return (
        <div className="relative space-y-4 pb-32">
            <div className="sticky top-0 z-20 bg-[var(--color-m3-surface-dim)]  px-6 md:px-8 pt-8 pb-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] "
                >
                    <Icon icon={ArrowLeft} size={18} className="text-[var(--color-m3-on-surface-variant)]  shrink-0" />
                    <span className="text-xl font-semibold text-[var(--color-m3-on-surface)] ">
                        {t('import.title')}
                    </span>
                </button>
            </div>

            <div className="mx-auto w-full px-6 md:px-8 max-w-2xl">
                <ImportSection onImportJson={onImportJson} />

                {/* The protocol is published so another tracker can write a file this
                    app reads. Linked here rather than only in the README because this
                    is the screen someone implementing that would be looking at, and a
                    spec nobody can find is not a published spec.

                    The Chinese guide, not the English spec: it carries the same field
                    tables plus worked example code, a self-test list and a prompt to
                    hand an AI assistant — and it links on to the English spec, which
                    stays the authority on field definitions. */}
                <p className="mt-6 text-xs leading-relaxed text-[var(--color-m3-on-surface-variant)]">
                    {t('import.format_doc')}{' '}
                    <button
                        type="button"
                        /* `blob/HEAD`, not a branch name: HEAD follows the repository's
                           default branch, so the link survives the branch being renamed
                           or the work being merged. A hard-coded `rewrite` would rot the
                           day it moved. */
                        onClick={() => window.open('https://github.com/xingqimiao/Kira-HRT-Tracker/blob/HEAD/docs/hrt-import-export-protocol.zh-CN.md', '_blank', 'noopener,noreferrer')}
                        className="text-[var(--color-m3-primary)] underline underline-offset-2"
                    >
                        docs/hrt-import-export-protocol.zh-CN.md
                    </button>
                </p>
            </div>
        </div>
    );
};

export default ImportSettings;
