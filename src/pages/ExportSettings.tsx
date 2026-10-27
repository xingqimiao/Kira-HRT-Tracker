import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import ExportSection from '../components/ExportSection';
import { DoseEvent, LabResult } from '../../logic';
import { HeaderBack } from '../ui/proto';

interface ExportSettingsProps {
    events: DoseEvent[];
    labResults: LabResult[];
    weight: number;
    /** `legacy` writes the pre-2.3.0 shape — see `toLegacyExport`. */
    onExport: (encrypt: boolean, password?: string, legacy?: boolean) => Promise<string | null>;
    onQuickExport: (legacy?: boolean) => void;
    onBack: () => void;
}

const ExportSettings: React.FC<ExportSettingsProps> = ({ events, labResults, weight, onExport, onQuickExport, onBack }) => {
    const { t } = useTranslation();

    return (
        <div className="pg on long" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }}>
            <HeaderBack title={t('export.title')} onBack={onBack} backLabel={t('core.back')} />
            <ExportSection
                events={events}
                labResults={labResults}
                weight={weight}
                onExport={onExport}
                onQuickExport={onQuickExport}
            />
        </div>
    );
};

export default ExportSettings;
