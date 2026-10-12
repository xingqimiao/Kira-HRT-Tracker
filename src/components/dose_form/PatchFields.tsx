import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Route } from '../../../logic';
import { FieldRow, ChipRow } from './FormControls';
import { FieldIcon } from '../compoundIcons';

interface PatchFieldsProps {
    patchMode: "dose" | "rate";
    setPatchMode: (val: "dose" | "rate") => void;
    patchRate: string;
    setPatchRate: (val: string) => void;
    rawDose: string;
    onRawChange: (val: string) => void;
    patchWearDays: string;
    setPatchWearDays: (val: string) => void;
    route: Route;
}

// Common transdermal E2 patch nominal release rates (µg/day).
const RATE_PRESETS = ['25', '37.5', '50', '75', '100'];
// Common wear schedules, in days. Index 2 points past the presets at "until removed".
const WEAR_PRESETS = ['3.5', '7'];

const PatchFields: React.FC<PatchFieldsProps> = ({
    patchMode, setPatchMode, patchRate, setPatchRate,
    rawDose, onRawChange, patchWearDays, setPatchWearDays,
}) => {
    const { t } = useTranslation();
    const rateIdx = RATE_PRESETS.indexOf(patchRate);
    const wearIdx = patchWearDays.trim() === '' ? WEAR_PRESETS.length : WEAR_PRESETS.indexOf(patchWearDays);

    return (
        <div className="space-y-2.5">
            <FieldRow icon={FieldIcon.weight} label={t('field.patch_mode')}>
                <ChipRow options={[t('field.patch_rate'), t('field.patch_total')]} value={patchMode === 'rate' ? 0 : 1} onChange={(i) => setPatchMode(i ? 'dose' : 'rate')} />
            </FieldRow>

            {patchMode === 'rate' ? (
                <FieldRow icon={FieldIcon.gauge} label={t('field.patch_rate')} delay={1}>
                    <div className="flex items-center gap-2">
                        <input
                            type="number" inputMode="decimal" min="0" step="1"
                            value={patchRate} onChange={(e) => setPatchRate(e.target.value)}
                            placeholder={t('patch.rate_placeholder')}
                            className="w-full bg-transparent text-[15px] font-medium tabular-nums text-[var(--color-m3-on-surface)] outline-none border-b border-[var(--color-m3-outline-variant)] py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            style={{ fontSize: '16px' }}
                        />
                        <span className="text-xs text-[var(--color-m3-on-surface-variant)] shrink-0">µg/d</span>
                    </div>
                    <div className="mt-2"><ChipRow options={RATE_PRESETS} value={rateIdx} onChange={(i) => setPatchRate(RATE_PRESETS[i])} /></div>
                </FieldRow>
            ) : (
                <FieldRow icon={FieldIcon.drop} label={t('field.patch_total')} delay={1}>
                    <div className="flex items-center gap-2">
                        <input
                            type="number" inputMode="decimal" min="0" step="0.001"
                            value={rawDose} onChange={(e) => onRawChange(e.target.value)}
                            placeholder="0.0"
                            className="w-full bg-transparent text-[15px] font-medium tabular-nums text-[var(--color-m3-on-surface)] outline-none border-b border-[var(--color-m3-outline-variant)] py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            style={{ fontSize: '16px' }}
                        />
                        <span className="text-xs text-[var(--color-m3-on-surface-variant)] shrink-0">mg</span>
                    </div>
                </FieldRow>
            )}

            {/* Wear duration — applies to both modes. Empty means the patch stays on
                until a separate "remove" event is logged. */}
            <FieldRow icon={FieldIcon.cal} label={t('field.patch_wear')} delay={2}>
                <div className="flex items-center gap-2">
                    <input
                        type="number" inputMode="decimal" min="0" step="0.5"
                        value={patchWearDays} onChange={(e) => setPatchWearDays(e.target.value)}
                        placeholder={t('field.patch_wear_placeholder')}
                        className="w-full bg-transparent text-[15px] font-medium tabular-nums text-[var(--color-m3-on-surface)] outline-none border-b border-[var(--color-m3-outline-variant)] py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        style={{ fontSize: '16px' }}
                    />
                    <span className="text-xs text-[var(--color-m3-on-surface-variant)] shrink-0">{t('unit.day_short')}</span>
                </div>
                <div className="mt-2">
                    <ChipRow
                        options={[...WEAR_PRESETS.map((d) => `${d} ${t('unit.day_short')}`), t('field.patch_until_removed')]}
                        value={wearIdx}
                        onChange={(i) => setPatchWearDays(i < WEAR_PRESETS.length ? WEAR_PRESETS[i] : '')}
                    />
                </div>
                <p className="text-xs text-[var(--color-m3-on-surface-variant)] mt-1.5">{t('field.patch_wear_hint')}</p>
            </FieldRow>
        </div>
    );
};

export default PatchFields;
