import { isPlausibleBodyWeightKG } from '../../logic';
import React, { useState, useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { HeaderBack } from '../ui/proto';

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
        if (isPlausibleBodyWeightKG(val)) {
            onSave(val);
            onBack();
        } else {
            showDialog('alert', t('error.nonPositive'));
        }
    };

    return (
        <div className="pg on long" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }}>
            <HeaderBack title={t('status.weight')} onBack={onBack} backLabel={t('core.back')} />

            <div className="lf-hero" style={{ gap: 6 }}>
                <span className="l">{t('status.weight')}</span>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <input
                        type="number"
                        inputMode="decimal"
                        value={weightStr}
                        onChange={(e) => setWeightStr(e.target.value)}
                        className="lf-num"
                        style={{ width: 170 }}
                        placeholder="0.0"
                        aria-label={t('status.weight')}
                        autoFocus
                    />
                    <span style={{ fontSize: 20, fontWeight: 800, opacity: .85 }}>kg</span>
                </span>
                <span className="s" style={{ fontSize: 12.5, opacity: .8 }}>{t('modal.weight.desc')}</span>
            </div>

            <button type="button" onClick={handleSave} className="btn" style={{ height: 52 }}>
                {t('btn.save')}
            </button>
        </div>
    );
};

export default WeightSettings;
