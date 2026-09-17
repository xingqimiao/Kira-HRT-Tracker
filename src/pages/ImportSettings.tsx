import React from 'react';
import Icon from '../components/Icon';
import { ArrowLeft } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import ImportSection from '../components/ImportSection';

interface ImportSettingsProps {
    onImportJson: (text: string) => boolean | Promise<boolean>;
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
            </div>
        </div>
    );
};

export default ImportSettings;
