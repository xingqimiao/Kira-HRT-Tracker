import React from 'react';
import Icon from '../components/Icon';
import { ArrowLeft, Check } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useHRTMode } from '../contexts/HRTModeContext';

interface HRTModeSettingsProps {
    onBack: () => void;
}

const HRTModeSettings: React.FC<HRTModeSettingsProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const { mode, setMode } = useHRTMode();

    const options = [
        { value: 'transfem', labelKey: 'mode.transfem' },
        { value: 'transmasc', labelKey: 'mode.transmasc' },
    ] as const;

    return (
        <div className="relative pb-32">
            <div className="sticky top-0 md:top-[var(--m3-navbar-height)] z-20 bg-[var(--color-m3-surface-dim)]  px-6 md:px-8 pt-8 pb-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] "
                >
                    <Icon icon={ArrowLeft} size={18} className="text-[var(--color-m3-on-surface-variant)]  shrink-0" />
                    <span className="text-xl font-semibold text-[var(--color-m3-on-surface)] ">
                        {t('settings.hrt_mode')}
                    </span>
                </button>
            </div>

            <div className="px-6 md:px-8 mt-4 max-w-2xl">
                {options.map(({ value, labelKey }) => (
                    <button
                        key={value}
                        onClick={() => setMode(value)}
                        className="w-full flex items-center justify-between py-4 border-b border-[var(--color-m3-outline-variant)]  last:border-b-0 text-start"
                    >
                        <span className={`text-[0.9375rem] ${mode === value
                            ? 'font-semibold text-[var(--color-m3-on-surface)] '
                            : 'text-[var(--color-m3-on-surface)] '
                        }`}>
                            {t(labelKey)}
                        </span>
                        {mode === value && (
                            <Icon icon={Check} size={16} className="text-[var(--color-m3-primary)]  shrink-0" />
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
};

export default HRTModeSettings;
