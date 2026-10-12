import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import {
    GEL_SITE_ORDER,
    GEL_PRODUCT_OPTIONS,
    GEL_COVERAGE_OPTIONS,
    GEL_COAPPLICATION_OPTIONS,
} from '../../../logic';
import { FieldRow, ChipRow } from './FormControls';
import { FieldIcon } from '../compoundIcons';

/**
 * The gel route's fields.
 *
 * Two layers, on purpose. Site and applied dose are what the built-in engine reads.
 * Product, coverage, co-application and wash-off are what the Transmtf engine
 * additionally needs; they are written whichever engine is selected, because a record
 * should not mean different things depending on a setting that can change later. The
 * built-in engine simply ignores them.
 *
 * `showEngineDetail` is therefore about what is *shown*, not what is stored: with the
 * built-in engine selected the four ignored fields are hidden, because a control that
 * changes nothing is worse than no control. The values already on the record are
 * untouched by hiding them, and switching engines brings them back.
 */
interface GelFieldsProps {
    /** True when the engine in use reads the four detail fields below. */
    showEngineDetail: boolean;
    gelSite: number;
    setGelSite: (val: number) => void;
    gelProductId: number;
    setGelProductId: (val: number) => void;
    gelCoverage: number;
    setGelCoverage: (val: number) => void;
    gelCoApplied: number;
    setGelCoApplied: (val: number) => void;
    /** Hours until the site was washed, as typed. Empty means not washed. */
    gelWashHours: string;
    setGelWashHours: (val: string) => void;
    e2Dose: string;
    onE2Change: (val: string) => void;
    bioMultiplier?: number;
}

const GelFields: React.FC<GelFieldsProps> = ({
    showEngineDetail,
    gelSite,
    setGelSite,
    gelProductId,
    setGelProductId,
    gelCoverage,
    setGelCoverage,
    gelCoApplied,
    setGelCoApplied,
    gelWashHours,
    setGelWashHours,
    e2Dose,
    onE2Change,
    bioMultiplier
}) => {
    const { t } = useTranslation();

    const appliedVal = parseFloat(e2Dose);
    const hasDose = Number.isFinite(appliedVal) && appliedVal > 0;
    const absorbed = hasDose && bioMultiplier ? appliedVal * bioMultiplier : null;
    const bioPct = bioMultiplier ? (bioMultiplier * 100) : null;

    return (
        <div className="space-y-2.5">
            <FieldRow icon={FieldIcon.pin} label={t('field.gel_site')}>
                <ChipRow options={GEL_SITE_ORDER.map((k) => t(`pill.site.${k}`))} value={gelSite} onChange={setGelSite} />
            </FieldRow>

            {/* Applied dose — a bar like the rest, with the absorbed estimate below. */}
            <FieldRow icon={FieldIcon.drop} label={t('field.dose_e2')}>
                <div className="flex items-center gap-2">
                    <input
                        type="number" inputMode="decimal" min="0" step="0.001"
                        value={e2Dose} onChange={(e) => onE2Change(e.target.value)}
                        placeholder="0.0"
                        className="w-full bg-transparent text-[15px] font-medium tabular-nums text-[var(--color-m3-on-surface)] outline-none border-b border-[var(--color-m3-outline-variant)] py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        style={{ fontSize: '16px' }}
                    />
                    <span className="text-xs text-[var(--color-m3-on-surface-variant)] shrink-0">mg</span>
                </div>
                {bioPct !== null && (
                    <p className="text-xs text-[var(--color-m3-on-surface-variant)] mt-1">
                        {t('gel.bioavailability')}: {bioPct.toFixed(0)}%
                        {absorbed !== null && <> · {t('gel.absorbed')} ≈ {absorbed.toFixed(3).replace(/\.?0+$/, '')} mg</>}
                    </p>
                )}
            </FieldRow>

            {showEngineDetail && (
                <>
                    <FieldRow icon={FieldIcon.gel} label={t('field.gel_product')} engineOnly>
                        <ChipRow options={GEL_PRODUCT_OPTIONS.map((p) => t(p.nameKey))} value={gelProductId - 1} onChange={(i) => setGelProductId(GEL_PRODUCT_OPTIONS[i].id)} />
                    </FieldRow>
                    <FieldRow icon={FieldIcon.area} label={t('field.gel_coverage')} engineOnly>
                        <ChipRow options={GEL_COVERAGE_OPTIONS.map((k) => t(`gel.coverage.${k}`))} value={gelCoverage} onChange={setGelCoverage} />
                    </FieldRow>
                    <FieldRow icon={FieldIcon.layers} label={t('field.gel_coapplied')} engineOnly>
                        <ChipRow options={GEL_COAPPLICATION_OPTIONS.map((k) => t(`gel.coapplied.${k}`))} value={gelCoApplied} onChange={setGelCoApplied} />
                    </FieldRow>
                    <FieldRow icon={FieldIcon.drop} label={t('field.gel_wash')} engineOnly>
                        <div className="flex items-center gap-2">
                            <input
                                type="number" inputMode="decimal" min="0" step="0.5"
                                value={gelWashHours} onChange={(e) => setGelWashHours(e.target.value)}
                                placeholder={t('field.gel_wash_none')}
                                className="w-full bg-transparent text-[15px] font-medium tabular-nums text-[var(--color-m3-on-surface)] outline-none border-b border-[var(--color-m3-outline-variant)] py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                style={{ fontSize: '16px' }}
                            />
                            <span className="text-xs text-[var(--color-m3-on-surface-variant)] shrink-0">{t('unit.hour_short')}</span>
                        </div>
                    </FieldRow>
                </>
            )}
        </div>
    );
};

export default GelFields;
