import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import {
    GEL_SITE_ORDER,
    GEL_PRODUCT_OPTIONS,
    GEL_COVERAGE_OPTIONS,
    GEL_COAPPLICATION_OPTIONS,
} from '../../../logic';
import { useHRTMode } from '../../contexts/HRTModeContext';
import CustomSelect from '../CustomSelect';

/**
 * The gel route's fields.
 *
 * Two layers, on purpose. Site and applied dose are what the built-in engine reads.
 * Product, coverage and co-application are what the Transmtf engine additionally
 * needs; they are written whichever engine is selected, because a record should not
 * mean different things depending on a setting that can change later. The built-in
 * engine simply ignores them.
 *
 * The product list is ids and name keys only — the kinetics for each id stay in the
 * engine chunk, which is what keeps this form from dragging that chunk into a first
 * visit (see `GEL_PRODUCT_OPTIONS`).
 */
interface GelFieldsProps {
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
    const { isTransmasc } = useHRTMode();
    const equivLabelKey = isTransmasc ? 'field.dose_t' : 'field.dose_e2';

    const appliedVal = parseFloat(e2Dose);
    const hasDose = Number.isFinite(appliedVal) && appliedVal > 0;
    const absorbed = hasDose && bioMultiplier ? appliedVal * bioMultiplier : null;
    const bioPct = bioMultiplier ? (bioMultiplier * 100) : null;

    const labelClass = 'block text-xs font-semibold text-cos-on-surface-variant  pl-1';

    return (
        <div className="space-y-4">
            {/* Product. Named rather than measured: the strength and the labelled
                application area belong to the product, and the engine resolves them
                from the id at simulation time. */}
            <div className="space-y-1.5">
                <label className={labelClass}>{t('field.gel_product')}</label>
                <CustomSelect
                    value={String(gelProductId)}
                    onChange={(val) => setGelProductId(parseInt(val, 10))}
                    options={GEL_PRODUCT_OPTIONS.map(p => ({
                        value: String(p.id),
                        label: t(p.nameKey),
                    }))}
                />
            </div>

            {/* Application site */}
            <div className="space-y-1.5">
                <label className={labelClass}>{t('field.gel_site')}</label>
                <CustomSelect
                    value={String(gelSite)}
                    onChange={(val) => setGelSite(parseInt(val, 10))}
                    options={GEL_SITE_ORDER.map((siteKey, idx) => ({
                        value: String(idx),
                        label: t(`gel.site.${siteKey}`)
                    }))}
                />
            </div>

            {/* Applied dose */}
            <div className="space-y-1.5">
                <label className={labelClass}>
                    {t(equivLabelKey)}
                </label>
                <input
                    type="number" inputMode="decimal"
                    min="0"
                    step="0.001"
                    value={e2Dose} onChange={e => onE2Change(e.target.value)}
                    className="w-full p-3 bg-cos-surface-container  border border-cos-outline  rounded-md focus:ring-1 focus:ring-[var(--color-m3-primary)]/30 focus:border-[var(--color-m3-primary)] outline-none text-cos-on-surface  font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="0.0"
                    style={{ fontSize: '16px' }}
                />
                {/* Absorbed estimate from site bioavailability */}
                {bioPct !== null && (
                    <p className="text-xs text-[var(--color-m3-on-surface-variant)]  pl-1">
                        {t('gel.bioavailability')}: {bioPct.toFixed(0)}%
                        {absorbed !== null && (
                            <> · {t('gel.absorbed')} ≈ {absorbed.toFixed(3).replace(/\.?0+$/, '')} mg</>
                        )}
                    </p>
                )}
            </div>

            {/* How much skin the dose went over. Absorbed fraction depends on the
                dose density, so the same milligrams over a palm and over both arms
                are not the same exposure. */}
            <div className="space-y-1.5">
                <label className={labelClass}>{t('field.gel_coverage')}</label>
                <CustomSelect
                    value={String(gelCoverage)}
                    onChange={(val) => setGelCoverage(parseInt(val, 10))}
                    options={GEL_COVERAGE_OPTIONS.map((key, idx) => ({
                        value: String(idx),
                        label: t(`gel.coverage.${key}`)
                    }))}
                />
            </div>

            {/* What else was on the skin. Sunscreen cuts absorption, a moisturiser
                raises it — the same dose reads differently depending on this. */}
            <div className="space-y-1.5">
                <label className={labelClass}>{t('field.gel_coapplied')}</label>
                <CustomSelect
                    value={String(gelCoApplied)}
                    onChange={(val) => setGelCoApplied(parseInt(val, 10))}
                    options={GEL_COAPPLICATION_OPTIONS.map((key, idx) => ({
                        value: String(idx),
                        label: t(`gel.coapplied.${key}`)
                    }))}
                />
            </div>

            {/* Wash-off. Optional, because most applications are not washed on a
                schedule — an empty field means the site was left alone. */}
            <div className="space-y-1.5">
                <label className={labelClass}>{t('field.gel_wash')}</label>
                <input
                    type="number" inputMode="decimal"
                    min="0"
                    step="0.5"
                    value={gelWashHours} onChange={e => setGelWashHours(e.target.value)}
                    className="w-full p-3 bg-cos-surface-container  border border-cos-outline  rounded-md focus:ring-1 focus:ring-[var(--color-m3-primary)]/30 focus:border-[var(--color-m3-primary)] outline-none text-cos-on-surface  font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder={t('field.gel_wash_none')}
                    style={{ fontSize: '16px' }}
                />
            </div>
        </div>
    );
};

export default GelFields;
