import React, { useState, useEffect } from 'react';
import Icon from '../components/Icon';
import { ArrowLeft } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';

interface WeightSettingsProps {
    weight: number;
    onSave: (weight: number) => void;
    onBack: () => void;
}

const WeightSettings: React.FC<WeightSettingsProps> = ({ weight, onSave, onBack }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const [weightStr, setWeightStr] = useState(weight.toString());

    useEffect(() => {
        setWeightStr(weight.toString());
    }, [weight]);

    const handleSave = () => {
        const val = parseFloat(weightStr);
        if (!isNaN(val) && val > 0) {
            onSave(val);
            onBack();
        } else {
            showDialog('alert', t('error.nonPositive'));
        }
    };

    const divider = "border-b border-[var(--color-m3-outline-variant)] ";

    return (
        <div className="relative pb-32">
            <div className="sticky top-0 z-20 bg-[var(--color-m3-surface-dim)]  px-6 md:px-8 pt-8 pb-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] "
                >
                    <Icon icon={ArrowLeft} size={18} className="text-[var(--color-m3-on-surface-variant)]  shrink-0" />
                    <span className="text-xl font-semibold text-[var(--color-m3-on-surface)] ">
                        {t('status.weight')}
                    </span>
                </button>
            </div>

            <div className="mx-auto w-full px-6 md:px-8 mt-4 max-w-2xl">
                <div className={`flex items-center justify-between py-5 ${divider}`}>
                    <div className="flex items-end gap-2">
                        <input
                            type="number"
                            inputMode="decimal"
                            value={weightStr}
                            onChange={(e) => setWeightStr(e.target.value)}
                            className="text-m3-display-large tabular-nums text-[var(--color-m3-on-surface)]  w-28 bg-transparent border-b-2 border-[var(--color-m3-outline-variant)]  focus:border-[var(--color-m3-primary)] outline-none pb-1 text-center"
                            placeholder="0.0"
                            style={{ fontSize: '40px' }}
                            autoFocus
                        />
                        <span className="text-lg font-medium text-[var(--color-m3-on-surface-variant)]  pb-1">kg</span>
                    </div>
                    <p className="text-xs text-[var(--color-m3-on-surface-variant)]  max-w-[140px] text-right">
                        {t('modal.weight.desc')}
                    </p>
                </div>

                <button
                    onClick={handleSave}
                    className={`w-full flex items-center py-[18px] ${divider} text-start`}
                >
                    <span className="text-m3-body-medium font-medium text-[var(--color-m3-primary)] ">
                        {t('btn.save')}
                    </span>
                </button>
            </div>
        </div>
    );
};

export default WeightSettings;
