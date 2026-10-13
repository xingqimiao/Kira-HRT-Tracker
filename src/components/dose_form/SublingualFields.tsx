import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Route, Ester, SL_TIER_ORDER, SublingualTierParams, isAntiandrogen } from '../../../logic';
import { FieldRow, ChipRow } from './FormControls';
import { FieldIcon } from '../compoundIcons';
import DoseAmountInput, { type AmountField } from './DoseAmountInput';

interface SublingualFieldsProps {
    ester: Ester;
    rawDose: string;
    e2Dose: string;
    onRawChange: (val: string) => void;
    onE2Change: (val: string) => void;
    slTier: number;
    setSlTier: (val: number) => void;
    useCustomTheta: boolean;
    setUseCustomTheta: (val: boolean) => void;
    customHoldInput: string;
    setCustomHoldInput: (val: string) => void;
    customHoldValue: number;
    setCustomHoldValue: (val: number) => void;
    thetaFromHold: (hold: number) => number;
    route: Route;
}

/**
 * The sublingual route: an absorption-tier chip row (or a custom hold time), then the
 * dose rows. The tier row is the reference's five chips — four presets plus 自訂, which
 * reveals the hold-time field.
 */
const SublingualFields: React.FC<SublingualFieldsProps> = ({
    ester, rawDose, e2Dose, onRawChange, onE2Change,
    slTier, setSlTier, useCustomTheta, setUseCustomTheta,
    customHoldInput, setCustomHoldInput, customHoldValue, setCustomHoldValue,
    thetaFromHold, route
}) => {
    const { t } = useTranslation();
    const antiandrogen = isAntiandrogen(ester);

    const tiers = SL_TIER_ORDER.map((k) => `${t(`pill.tier.${k}`)} ${SublingualTierParams[k].hold}${t('unit.min_short')}`);
    const chipValue = useCustomTheta ? tiers.length : slTier;
    const onTier = (i: number): void => {
        if (i === tiers.length) { setUseCustomTheta(true); return; }
        setUseCustomTheta(false);
        setSlTier(i);
    };

    const fields: AmountField[] = [];
    if (ester !== Ester.E2) {
        fields.push({ key: 'raw', label: t('field.dose_raw'), value: rawDose, onChange: onRawChange });
    }
    if (ester === Ester.EV && route === Route.sublingual) {
        fields[0].hint = `${t('field.dose_e2')}: ${e2Dose ? `${e2Dose} mg` : '--'}`;
    } else if (!antiandrogen) {
        fields.push({ key: 'e2', label: t('field.dose_e2'), value: e2Dose, onChange: onE2Change });
    }

    return (
        <div className="space-y-2.5">
            <FieldRow icon={FieldIcon.glass} label={t('field.sl_absorption')}>
                <ChipRow options={[...tiers, t('pill.tier.custom')]} value={chipValue} onChange={onTier} />
            </FieldRow>

            {useCustomTheta && (
                <FieldRow icon={FieldIcon.clock} label={t('sl.hold_time_min')}>
                    <div className="flex items-center gap-3">
                        <input
                            type="number" inputMode="decimal"
                            min="1" max="60"
                            value={customHoldInput}
                            onChange={(e) => {
                                setCustomHoldInput(e.target.value);
                                const v = parseFloat(e.target.value);
                                if (Number.isFinite(v) && v >= 1) setCustomHoldValue(v);
                            }}
                            className="hrt-num w-20"
                            style={{ fontSize: '16px' }}
                        />
                        <input
                            type="range" min="1" max="60"
                            value={customHoldValue}
                            onChange={(e) => {
                                const v = parseInt(e.target.value);
                                setCustomHoldValue(v);
                                setCustomHoldInput(v.toString());
                            }}
                            className="flex-1 h-1 accent-[var(--color-m3-primary)]"
                        />
                        <span className="text-xs text-[var(--color-m3-on-surface-variant)] shrink-0">
                            θ {thetaFromHold(customHoldValue).toFixed(3)}
                        </span>
                    </div>
                </FieldRow>
            )}

            {fields.map((fld, i) => (
                <FieldRow key={fld.key} icon={fld.key === 'e2' ? FieldIcon.drop : FieldIcon.weight} label={fld.label} delay={i + (useCustomTheta ? 2 : 1)}>
                    <DoseAmountInput field={fld} />
                </FieldRow>
            ))}
        </div>
    );
};

export default SublingualFields;
