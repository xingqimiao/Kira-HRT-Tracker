import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { ArrowLeft, Check, Minus } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { CalibrationMethod, CalibrationHistoryMode, CalibrationResult, type DoseEvent, type LabResult, type SimulationResult } from '../../logic';
import ModelPreviewCanvas from '../components/ModelPreviewCanvas';
import {
    applyFactor, buildRealData, buildSampleData, sampleModelCurve, MODEL_COLOR_VAR,
    type PreviewData, type Pt,
} from '../utils/modelPreview';

interface CalibrationSettingsProps {
    method: CalibrationMethod;
    setMethod: (m: CalibrationMethod) => void;
    historyMode: CalibrationHistoryMode;
    setHistoryMode: (m: CalibrationHistoryMode) => void;
    calibration: CalibrationResult;
    /** The user's data, for the card previews. */
    events: DoseEvent[];
    labResults: LabResult[];
    simulation: SimulationResult | null;
    /** Fit one (method, historyMode) with the engine in use — same call the page's own
     *  `calibration` came from, so a preview cannot disagree with the real fit. */
    calibrateFor: (m: CalibrationMethod, hm: CalibrationHistoryMode) => CalibrationResult;
    onBack: () => void;
}

const muted = 'text-[var(--color-m3-on-surface-variant)] ';
const on = 'text-[var(--color-m3-on-surface)] ';
const divider = 'border-b border-[var(--color-m3-outline-variant)] ';

interface MethodDef {
    value: CalibrationMethod;
    recommended?: boolean;
    pros: string[];
    cons: string[];
}

// The three learning estimators mirror the calibration models on
// hrt.transmtf.com (EKF parameter learning, OU-Kalman dynamic calibration,
// Hybrid-MIPD Bayesian fit), reimplemented over this engine's two identifiable
// parameters: a personal amplitude and a personal clearance.
const METHODS: MethodDef[] = [
    { value: 'off', pros: ['cal.off.pro.1'], cons: ['cal.off.con.1'] },
    { value: 'mipd', recommended: true, pros: ['cal.mipd.pro.1', 'cal.mipd.pro.2'], cons: ['cal.mipd.con.1'] },
    { value: 'ekf', pros: ['cal.ekf.pro.1', 'cal.ekf.pro.2'], cons: ['cal.ekf.con.1'] },
    { value: 'ou_kalman', pros: ['cal.ou_kalman.pro.1', 'cal.ou_kalman.pro.2'], cons: ['cal.ou_kalman.con.1'] },
];

// Only EKF and MIPD fit a personal clearance; OU-Kalman corrects amplitude only.
const fitsClearance = (m: CalibrationMethod) => m === 'ekf' || m === 'mipd';

const HISTORY_MODES: { value: CalibrationHistoryMode }[] = [
    { value: 'retrospective' },
    { value: 'forward' },
];

// Shared selectable card (title + radio) used for both the estimator methods
// and the history modes so the two lists render identically.
const OptionCard: React.FC<{
    selected: boolean;
    title: string;
    /** The model's identity hue — the name and radio take it, so a card reads as
     *  *that* model before the small preview is even looked at. */
    accent?: string;
    badge?: string;
    onClick: () => void;
    children?: React.ReactNode;
}> = ({ selected, title, accent, badge, onClick, children }) => (
    <button
        onClick={onClick}
        className="w-full text-start rounded-2xl border p-4 outline-none focus:outline-none focus-visible:outline-none transition-colors"
        style={{
            borderColor: selected ? (accent ?? 'var(--color-m3-primary)') : 'var(--color-m3-outline-variant)',
            background: selected ? `color-mix(in srgb, ${accent ?? 'var(--color-m3-primary)'} 6%, transparent)` : 'transparent',
        }}
    >
        <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className={`text-m3-body-medium ${on}`} style={{ fontWeight: 700, ...(accent ? { color: accent } : {}) }}>{title}</span>
                    {badge && (
                        <span className="m3-text-2xs font-medium px-1.5 py-0.5 rounded-full text-[var(--color-m3-primary)]  border border-[var(--color-m3-primary)]/30">
                            {badge}
                        </span>
                    )}
                </div>
                {children}
            </div>

            {/* Radio */}
            <span
                className="shrink-0 mt-0.5 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center"
                style={{ borderColor: selected ? (accent ?? 'var(--color-m3-primary)') : 'var(--color-m3-outline)' }}
            >
                {selected && <span className="w-2.5 h-2.5 rounded-full" style={{ background: accent ?? 'var(--color-m3-primary)' }} />}
            </span>
        </div>
    </button>
);

/**
 * Every card's own curve.
 *
 * Each card shows *its own model's* fitted line even when it is not selected, so the
 * four curves can be compared side by side. That means every card's curve is computed,
 * not just the selected one — so the fits run one per tick in an effect (the EKF fit is
 * about a second), letting the page paint before the work lands. Results are cached;
 * the cache is dropped when the underlying data changes.
 */
function useCardCurves(
    data: PreviewData,
    keys: readonly string[],
    calibrateFor: CalibrationSettingsProps['calibrateFor'],
): Record<string, Pt[]> {
    const [curves, setCurves] = useState<Record<string, Pt[]>>({});
    const cacheKey = data.source + '|' + data.base.length + '|' + data.labs.length;

    // Reset the cache when the data changes (new account / new labs).
    const keyRef = useRef(cacheKey);
    if (keyRef.current !== cacheKey) { keyRef.current = cacheKey; if (Object.keys(curves).length) setCurves({}); }

    useEffect(() => {
        // The sample fallback draws pure-maths curves in `curveFor`; nothing to fit.
        if (data.source !== 'real') return;
        const missing = keys.filter((k) => !(k in curves));
        if (missing.length === 0) return;
        let cancelled = false;
        const key = missing[0];
        const [m, hm] = key.split('|') as [CalibrationMethod, CalibrationHistoryMode];
        const id = window.setTimeout(() => {
            if (cancelled) return;
            try {
                setCurves((prev) => ({ ...prev, [key]: applyFactor(data.base, calibrateFor(m, hm).factorFn) }));
            } catch {
                // A fit that throws simply leaves the card on the population curve.
                setCurves((prev) => ({ ...prev, [key]: [] }));
            }
        }, 0);
        return () => { cancelled = true; window.clearTimeout(id); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keys, curves, cacheKey, calibrateFor]);

    return curves;
}

const CalibrationSettings: React.FC<CalibrationSettingsProps> = ({
    method, setMethod, historyMode, setHistoryMode, calibration,
    events, labResults, simulation, calibrateFor, onBack,
}) => {
    const { t } = useTranslation();

    const showFit = method !== 'off' && calibration.points.length > 0;
    const signedPct = (p: number) => `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`;

    // The shared preview data: the user's own curve + labs, or the built-in fallback
    // when there is too little to draw.
    const data = useMemo<PreviewData>(
        () => buildRealData(events, labResults, simulation, calibration.points) ?? buildSampleData(),
        [events, labResults, simulation, calibration.points],
    );

    // Every card shows its own model's curve, so ask for all of them: the four methods
    // at the current history mode, plus the selected method at both history modes.
    // Deduped so the selected combination is only fitted once.
    const keys = useMemo(() => {
        const set = new Set<string>();
        for (const m of METHODS) set.add(`${m.value}|${historyMode}`);
        for (const h of HISTORY_MODES) set.add(`${method}|${h.value}`);
        return [...set];
    }, [method, historyMode]);

    const curves = useCardCurves(data, keys, calibrateFor);

    /** A model card's curve: instant for the fallback, computed/cached for real data. */
    const curveFor = (m: CalibrationMethod, hm: CalibrationHistoryMode): Pt[] | null => {
        if (data.source === 'sample') return sampleModelCurve(m);
        return curves[`${m}|${hm}`] ?? null;
    };

    /** A model's identity hue as a CSS value, for the card name and border. */
    const accentOf = (m: CalibrationMethod): string => `var(${MODEL_COLOR_VAR[m]})`;

    const stats: { label: string; value: string }[] = showFit
        ? [
            { label: t('cal.amplitude'), value: `×${calibration.scale.toFixed(2)}` },
            ...(fitsClearance(method)
                ? [{ label: t('cal.halflife'), value: signedPct(calibration.halfLifeDeltaPct) }]
                : []),
            ...(calibration.fitErrPct !== null
                ? [{ label: t('cal.fit'), value: `±${calibration.fitErrPct.toFixed(0)}%` }]
                : []),
            { label: t('cal.labs'), value: String(calibration.n) },
        ]
        : [];

    return (
        <div className="relative pb-32">
            <div className="sticky top-0 z-20 bg-[var(--color-m3-surface-dim)]  px-6 md:px-8 pt-8 pb-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg outline-none focus:outline-none focus-visible:outline-none hover:bg-[var(--color-m3-surface-container)] "
                >
                    <Icon icon={ArrowLeft} size={18} className={`${muted} shrink-0`} />
                    <span className={`text-xl font-semibold ${on}`}>{t('cal.settings')}</span>
                </button>
            </div>

            <div className="mx-auto w-full px-6 md:px-8 mt-4 max-w-2xl">
                {/* Method cards. A title, the one-line description from the reference
                    table, and the model's own finished curve — nothing else. The long
                    write-up lives in the details block at the foot of the page. */}
                <div className="space-y-2.5">
                    {METHODS.map(({ value, recommended }) => (
                        <OptionCard
                            key={value}
                            selected={method === value}
                            accent={accentOf(value)}
                            title={t(`cal.${value}`)}
                            badge={recommended ? t('cal.recommended') : undefined}
                            onClick={() => setMethod(value)}
                        >
                            <p className={`text-m3-body-compact leading-snug ${muted} mt-1`}>
                                {t(`cal.short.${value}`)}
                            </p>
                            <ModelPreviewCanvas
                                method={value}
                                data={data}
                                model={curveFor(value, historyMode)}
                            />
                        </OptionCard>
                    ))}
                </div>

                {/* History mode — how a new lab is allowed to act on the past curve.
                    Only meaningful once a learning method is selected. */}
                {method !== 'off' && (
                    <div className="mt-8">
            <p className={`text-m3-title-small ${muted} mb-2`}>
                            {t('cal.history')}
                        </p>
                        <div className="space-y-2.5">
                            {HISTORY_MODES.map(({ value: hm }) => (
                                <OptionCard
                                    key={hm}
                                    selected={historyMode === hm}
                                    accent={accentOf(method)}
                                    title={t(`cal.${hm}`)}
                                    onClick={() => setHistoryMode(hm)}
                                >
                                    <p className={`text-m3-body-compact leading-snug ${muted} mt-1`}>
                                        {t(`cal.short.${hm}`)}
                                    </p>
                                    <ModelPreviewCanvas method={method} history={hm} />
                                </OptionCard>
                            ))}
                        </div>
                    </div>
                )}

                {/* Current fit */}
                {showFit && (
                    <div className="mt-8">
            <p className={`text-m3-title-small ${muted} mb-1`}>
                            {t('cal.current')}
                        </p>
                        {stats.map(({ label, value }) => (
                            <div key={label} className={`flex items-center justify-between py-3 ${divider}`}>
                                <span className={`text-sm ${muted}`}>{label}</span>
                                <span className={`text-sm font-medium tabular-nums ${on}`}>{value}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* The full write-up, kept small and out of the way: the cards above
                    show only the one-liner, so the reasoning behind each model lives
                    here rather than crowding the list. */}
                <div className="mt-10">
                    <p className={`text-m3-title-small ${muted} mb-3`}>{t('cal.details')}</p>
                    <div className="space-y-4">
                        {METHODS.map(({ value, pros, cons }) => (
                            <div key={value}>
                                <p className="text-m3-body-compact" style={{ fontWeight: 700, color: accentOf(value) }}>
                                    {t(`cal.${value}`)}
                                </p>
                                <p className={`m3-text-2xs leading-snug ${muted} mt-1`}>{t(`cal.desc.${value}`)}</p>
                                <ul className="mt-1.5 space-y-1">
                                    {pros.map(k => (
                                        <li key={k} className="flex items-start gap-2 m3-text-2xs leading-snug">
                                            <Icon icon={Check} size={12} className="mt-[3px] shrink-0 text-cos-success/80 " />
                                            <span className={muted}>{t(k)}</span>
                                        </li>
                                    ))}
                                    {cons.map(k => (
                                        <li key={k} className="flex items-start gap-2 m3-text-2xs leading-snug">
                                            <Icon icon={Minus} size={12} className={`mt-[3px] shrink-0 ${muted}`} />
                                            <span className={muted}>{t(k)}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                        {method !== 'off' && (
                            <div>
                                <p className={`m3-text-2xs leading-snug mt-4 ${muted}`}>{t('cal.desc.retrospective')}</p>
                                <p className={`m3-text-2xs leading-snug ${muted}`}>{t('cal.desc.forward')}</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Attribution: the learning models mirror those on hrt.transmtf.com. */}
                <p className={`m3-text-2xs leading-snug ${muted} mt-8`}>
                    {t('cal.source')}
                </p>
            </div>
        </div>
    );
};

export default CalibrationSettings;
