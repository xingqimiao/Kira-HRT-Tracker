import React, { useState, useCallback } from 'react';
import Icon from '../components/Icon';
import { RotateCcw, AlertTriangle, Info, Check } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { Tooltip } from '../components/ui';
import { PKCustomParams, DEFAULT_PK_PARAMS, type PkEngineId } from '../../logic';
import { ConnectedButtonGroup, HeaderBack } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';

interface PKParamsPageProps {
    pkParams: PKCustomParams | null;
    onSave: (params: PKCustomParams) => void;
    onReset: () => void;
    onBack: () => void;
    /** The engine actually in force (`engineInUse`), not the raw preference. */
    engine: PkEngineId;
}

type SectionKey = 'e2_inj' | 'e2_oral_sl' | 'e2_gel' | 'e2_core' | 't_inj' | 't_other';

interface FieldDef {
    key: keyof PKCustomParams;
    labelKey: string;
    min: number;
    max: number;
    step: number;
    precision: number;
}

const SECTIONS: { key: SectionKey; titleKey: string; fields: FieldDef[] }[] = [
    {
        key: 'e2_inj',
        titleKey: 'pk.group.e2_inj',
        fields: [
            { key: 'e2_ff_EB', labelKey: 'pk.e2_ff.EB', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 'e2_ff_EV', labelKey: 'pk.e2_ff.EV', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 'e2_ff_EC', labelKey: 'pk.e2_ff.EC', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 'e2_ff_EN', labelKey: 'pk.e2_ff.EN', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 'e2_ff_EU', labelKey: 'pk.e2_ff.EU', min: 0, max: 1, step: 0.001, precision: 4 },
        ],
    },
    {
        key: 'e2_oral_sl',
        titleKey: 'pk.group.e2_oral_sl',
        fields: [
            { key: 'e2_oral_bio', labelKey: 'pk.e2_oral_bio', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 'e2_sl_quick', labelKey: 'pk.sl_theta.quick', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 'e2_sl_casual', labelKey: 'pk.sl_theta.casual', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 'e2_sl_standard', labelKey: 'pk.sl_theta.standard', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 'e2_sl_strict', labelKey: 'pk.sl_theta.strict', min: 0, max: 1, step: 0.001, precision: 4 },
        ],
    },
    {
        key: 'e2_gel',
        titleKey: 'pk.group.e2_gel',
        fields: [
            { key: 'e2_gel_arm', labelKey: 'pk.e2_gel.arm', min: 0, max: 1, step: 0.001, precision: 3 },
            { key: 'e2_gel_thigh', labelKey: 'pk.e2_gel.thigh', min: 0, max: 1, step: 0.001, precision: 3 },
            { key: 'e2_gel_scrotal', labelKey: 'pk.e2_gel.scrotal', min: 0, max: 1, step: 0.001, precision: 3 },
        ],
    },
    {
        key: 'e2_core',
        titleKey: 'pk.group.e2_core',
        fields: [
            { key: 'e2_kClear', labelKey: 'pk.e2_kClear', min: 0.001, max: 5, step: 0.001, precision: 4 },
            { key: 'e2_kClearInj', labelKey: 'pk.e2_kClearInj', min: 0.001, max: 1, step: 0.001, precision: 4 },
        ],
    },
    {
        key: 't_inj',
        titleKey: 'pk.group.t_inj',
        fields: [
            { key: 't_ff_TC', labelKey: 'pk.t_ff.TC', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 't_ff_TE', labelKey: 'pk.t_ff.TE', min: 0, max: 1, step: 0.001, precision: 4 },
            { key: 't_ff_TU', labelKey: 'pk.t_ff.TU', min: 0, max: 1, step: 0.001, precision: 4 },
        ],
    },
    {
        key: 't_other',
        titleKey: 'pk.group.t_other',
        fields: [
            { key: 't_gel_arm', labelKey: 'pk.t_gel.arm', min: 0, max: 1, step: 0.001, precision: 3 },
            { key: 't_gel_thigh', labelKey: 'pk.t_gel.thigh', min: 0, max: 1, step: 0.001, precision: 3 },
            { key: 't_gel_scrotal', labelKey: 'pk.t_gel.scrotal', min: 0, max: 1, step: 0.001, precision: 3 },
            { key: 't_kClear', labelKey: 'pk.t_kClear', min: 0.001, max: 5, step: 0.001, precision: 4 },
            { key: 't_kClearInj', labelKey: 'pk.t_kClearInj', min: 0.001, max: 1, step: 0.001, precision: 4 },
        ],
    },
];

const PKParamsPage: React.FC<PKParamsPageProps> = ({ pkParams, onSave, onReset, onBack, engine }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();

    // The Transmtf engine cannot take these overrides, so the whole page is read-only
    // while it is in force.
    const disabled = engine === 'transmtf';

    const [draft, setDraft] = useState<PKCustomParams>(() =>
        pkParams ? { ...DEFAULT_PK_PARAMS, ...pkParams } : { ...DEFAULT_PK_PARAMS },
    );
    const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(['e2_inj']));
    const [saved, setSaved] = useState(false);

    const toggleSection = (key: SectionKey) => {
        setOpenSections(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const updateField = useCallback((key: keyof PKCustomParams, rawValue: string, min: number, max: number) => {
        const num = parseFloat(rawValue);
        if (!Number.isFinite(num)) return;
        setDraft(prev => ({ ...prev, [key]: Math.max(min, Math.min(max, num)) }));
    }, []);

    const handleSave = () => {
        if (disabled) return;
        onSave(draft);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    };

    const handleReset = () => {
        if (disabled) return;
        showDialog('confirm', t('pk.reset_confirm'), () => {
            setDraft({ ...DEFAULT_PK_PARAMS });
            onReset();
        });
    };

    const isCustomized = (key: keyof PKCustomParams) => draft[key] !== DEFAULT_PK_PARAMS[key];

    const hasAnyCustom = (Object.keys(DEFAULT_PK_PARAMS) as (keyof PKCustomParams)[]).some(
        key => Math.abs(Number(draft[key]) - Number(DEFAULT_PK_PARAMS[key])) >= 1e-9,
    );

    const resetToDefault = () => {
        if (disabled) return;
        const next = { ...DEFAULT_PK_PARAMS };
        setDraft(next);
        onSave(next);
    };

    return (
        <div className="pg on long" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }}>
            <HeaderBack title={t('pk.title')} onBack={onBack} backLabel={t('core.back')} />

            {/* 2026 Literature standard baseline - sole authoritative foundation */}
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div>
                        <b style={{ fontSize: 15 }}>{t('pk.preset.title')}</b>
                        <p className="sub" style={{ margin: '4px 0 0', fontSize: 12.5, lineHeight: 1.5 }}>
                            {t('pk.preset.desc')}
                        </p>
                    </div>
                    {hasAnyCustom && (
                        <button
                            type="button"
                            className="btn-tonal"
                            onClick={resetToDefault}
                            disabled={disabled}
                            style={{ padding: '6px 14px', fontSize: 12, borderRadius: 16, whiteSpace: 'nowrap', flexShrink: 0 }}
                        >
                            {t('action.reset')}
                        </button>
                    )}
                </div>
                {hasAnyCustom && (
                    <p className="sub" style={{ margin: 0, fontSize: 12, color: 'var(--pri)' }}>
                        {t('pk.preset.custom')}
                    </p>
                )}
            </div>

            <div className={`card`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: disabled ? 'var(--sch)' : 'var(--warnc)', color: disabled ? 'var(--var)' : 'var(--onterc)' }}>
                <Icon icon={disabled ? Info : AlertTriangle} size={18} />
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{disabled ? t('pk.unsupported') : t('pk.warn')}</p>
            </div>

            {SECTIONS.map(section => {
                const open = openSections.has(section.key);
                return (
                    <div key={section.key} className="list">
                        <button
                            type="button"
                            onClick={() => toggleSection(section.key)}
                            className="li"
                            style={{ width: '100%', border: 0, font: 'inherit', color: 'inherit', textAlign: 'left' }}
                            aria-expanded={open}
                        >
                            <div className="t"><b>{t(section.titleKey)}</b></div>
                            <SpriteIcon id="down" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .28s cubic-bezier(.3,1.7,.5,1)' }} />
                        </button>

                        {open && section.fields.map(field => {
                            const defVal = DEFAULT_PK_PARAMS[field.key] as number;
                            const curVal = draft[field.key] as number;
                            const changed = isCustomized(field.key);
                            return (
                                <div key={field.key} className="li" style={{ cursor: 'default' }}>
                                    <div className="t">
                                        <b>
                                            {t(field.labelKey)}
                                            {changed && (
                                                <Tooltip label={t('pk.modified')}>
                                                    <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--pri)' }} />
                                                </Tooltip>
                                            )}
                                        </b>
                                        <span className="s">{t('pk.default')}: {defVal.toFixed(field.precision)}</span>
                                    </div>
                                    <input
                                        type="number"
                                        inputMode="decimal"
                                        min={field.min}
                                        max={field.max}
                                        step={field.step}
                                        value={curVal}
                                        disabled={disabled}
                                        onChange={e => updateField(field.key, e.target.value, field.min, field.max)}
                                        className="num-pill tabular-nums"
                                        style={{ width: 96, opacity: disabled ? .4 : 1 }}
                                    />
                                </div>
                            );
                        })}
                    </div>
                );
            })}

            <p className="sub" style={{ margin: '0 6px', fontSize: 12, lineHeight: 1.55 }}>{disabled ? t('pk.unsupported.note') : t('pk.note')}</p>

            <button type="button" onClick={handleSave} disabled={disabled} className="btn" style={{ height: 52, opacity: disabled ? .4 : 1 }}>
                <Icon icon={Check} size={18} />
                {saved ? t('pk.saved') : t('btn.save')}
            </button>
            <button type="button" onClick={handleReset} disabled={disabled} className="btn danger-wide" style={{ marginTop: 0, opacity: disabled ? .4 : 1 }}>
                <Icon icon={RotateCcw} size={19} />
                {t('pk.reset')}
            </button>
        </div>
    );
};

export default PKParamsPage;
