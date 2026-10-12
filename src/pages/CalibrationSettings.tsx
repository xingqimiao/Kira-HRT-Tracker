import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon';
import { ArrowLeft, Check, Minus, CircleOff, Gauge, Radar, Wind, Rewind, FastForward } from '../icons';
import type { IconComponent } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { CalibrationMethod, CalibrationHistoryMode, CalibrationResult, type DoseEvent, type LabResult, type SimulationResult } from '../../logic';
import ModelPreviewCanvas from '../components/ModelPreviewCanvas';
import {
    applyFactor, buildRealData, buildSampleData, sampleModelCurve,
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
    icon: IconComponent;
    recommended?: boolean;
    pros: string[];
    cons: string[];
}

// The three learning estimators mirror the calibration models on
// hrt.transmtf.com (EKF parameter learning, OU-Kalman dynamic calibration,
// Hybrid-MIPD Bayesian fit), reimplemented over this engine's two identifiable
// parameters: a personal amplitude and a personal clearance.
const METHODS: MethodDef[] = [
    { value: 'off', icon: CircleOff, pros: ['cal.off.pro.1'], cons: ['cal.off.con.1'] },
    { value: 'mipd', icon: Gauge, recommended: true, pros: ['cal.mipd.pro.1', 'cal.mipd.pro.2'], cons: ['cal.mipd.con.1'] },
    { value: 'ekf', icon: Radar, pros: ['cal.ekf.pro.1', 'cal.ekf.pro.2'], cons: ['cal.ekf.con.1'] },
    { value: 'ou_kalman', icon: Wind, pros: ['cal.ou_kalman.pro.1', 'cal.ou_kalman.pro.2'], cons: ['cal.ou_kalman.con.1'] },
];

// Only EKF and MIPD fit a personal clearance; OU-Kalman corrects amplitude only.
const fitsClearance = (m: CalibrationMethod) => m === 'ekf' || m === 'mipd';

const HISTORY_MODES: { value: CalibrationHistoryMode; icon: IconComponent }[] = [
    { value: 'retrospective', icon: Rewind },
    { value: 'forward', icon: FastForward },
];

// Shared selectable card (icon + title + radio) used for both the estimator
// methods and the history modes so the two lists render identically.
const OptionCard: React.FC<{
    selected: boolean;
    icon: IconComponent;
    title: string;
    badge?: string;
    onClick: () => void;
    children?: React.ReactNode;
}> = ({ selected, icon, title, badge, onClick, children }) => (
    <button
        onClick={onClick}
        className="w-full text-start rounded-2xl border p-4 outline-none focus:outline-none focus-visible:outline-none transition-colors"
        style={{
            borderColor: selected ? 'var(--color-m3-primary)' : 'var(--color-m3-outline-variant)',
            background: selected ? 'color-mix(in srgb, var(--color-m3-primary) 6%, transparent)' : 'transparent',
        }}
    >
        <div className="flex items-start gap-3">
            <div
                className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: 'color-mix(in srgb, var(--color-m3-primary) 10%, transparent)' }}
            >
                <Icon icon={icon} size={17} className="text-[var(--color-m3-primary)]" />
            </div>

            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className={`text-m3-body-medium ${selected ? `font-semibold ${on}` : on}`}>{title}</span>
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
                style={{ borderColor: selected ? 'var(--color-m3-primary)' : 'var(--color-m3-outline)' }}
            >
                {selected && <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-m3-primary)]" />}
            </span>
        </div>
    </button>
);

/**
 * The curves each card shows, computed lazily.
 *
 * The selected card's curve is free (its `calibration` is already on the page). Any
 * other card is only computed once it has been visited, and one at a time in an effect
 * so the selecting tap paints first — the EKF fit is about a second of work, and doing
 * it during render would freeze the tap. Until a card's curve exists it shows the
 * population curve and the labs, which is still a truthful "what you have".
 */
function useCardCurves(
    data: PreviewData,
    requested: ReadonlySet<string>,
    calibrateFor: CalibrationSettingsProps['calibrateFor'],
    selectedKey: string,
    selectedFactor: (timeH: number) => number,
): Record<string, Pt[]> {
    const [curves, setCurves] = useState<Record<string, Pt[]>>({});
    const cacheKey = data.source + '|' + data.base.length + '|' + data.labs.length;

    useEffect(() => {
        // The sample fallback draws a pure-maths curve, computed in `curveFor`; there is
        // nothing to fit here, and setting state would loop.
        if (data.source !== 'real') return;
        const missing = [...requested].filter((k) => !(k in curves));
        if (missing.length === 0) return;
        let cancelled = false;
        // One per tick: the effect re-runs when `curves` grows, so a heavy fit never
        // blocks the whole list.
        const key = missing[0];
        const [m, hm] = key.split('|') as [CalibrationMethod, CalibrationHistoryMode];
        const id = window.setTimeout(() => {
            if (cancelled) return;
            try {
                const fn = key === selectedKey ? selectedFactor : calibrateFor(m, hm).factorFn;
                setCurves((prev) => ({ ...prev, [key]: applyFactor(data.base, fn) }));
            } catch {
                // A fit that throws simply leaves the card on the population curve.
                setCurves((prev) => ({ ...prev, [key]: [] }));
            }
        }, 0);
        return () => { cancelled = true; window.clearTimeout(id); };
        // `cacheKey` stands in for the data; a new account rebuilds the cache.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requested, curves, cacheKey, calibrateFor, selectedKey]);

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

    // Which (method, historyMode) curves have been asked for. The one selected now is
    // added on mount and on every change; the rest accumulate as cards are tapped.
    const selectedKey = `${method}|${historyMode}`;
    const [requested, setRequested] = useState<ReadonlySet<string>>(() => new Set([selectedKey]));
    useEffect(() => {
        setRequested((prev) => (prev.has(selectedKey) ? prev : new Set(prev).add(selectedKey)));
    }, [selectedKey]);

    const curves = useCardCurves(data, requested, calibrateFor, selectedKey, calibration.factorFn);

    /** The curve for one key: instant for the fallback, computed/cached for real data. */
    const curveFor = (m: CalibrationMethod, hm: CalibrationHistoryMode): Pt[] | null => {
        if (data.source === 'sample') return sampleModelCurve(m);
        return curves[`${m}|${hm}`] ?? null;
    };

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
                {/* Method cards. Each carries a small preview that plays while it is the
                    selected model — see ModelPreviewCanvas. */}
                <div className="space-y-2.5">
                    {METHODS.map(({ value, icon, recommended, pros, cons }) => (
                        <OptionCard
                            key={value}
                            selected={method === value}
                            icon={icon}
                            title={t(`cal.${value}`)}
                            badge={recommended ? t('cal.recommended') : undefined}
                            onClick={() => setMethod(value)}
                        >
                            <p className={`text-m3-body-compact leading-snug ${muted} mt-1`}>
                                {t(`cal.desc.${value}`)}
                            </p>

                            <ul className="mt-3 space-y-1.5">
                                {pros.map(k => (
                                    <li key={k} className="flex items-start gap-2 m3-text-2xs leading-snug">
                                        <Icon icon={Check} size={13} className="mt-[3px] shrink-0 text-cos-success/80 " />
                                        <span className={muted}>{t(k)}</span>
                                    </li>
                                ))}
                                {cons.map(k => (
                                    <li key={k} className="flex items-start gap-2 m3-text-2xs leading-snug">
                                        <Icon icon={Minus} size={13} className={`mt-[3px] shrink-0 ${muted}`} />
                                        <span className={muted}>{t(k)}</span>
                                    </li>
                                ))}
                            </ul>

                            <ModelPreviewCanvas
                                active={method === value}
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
                            {HISTORY_MODES.map(({ value: hm, icon }) => (
                                <OptionCard
                                    key={hm}
                                    selected={historyMode === hm}
                                    icon={icon}
                                    title={t(`cal.${hm}`)}
                                    onClick={() => setHistoryMode(hm)}
                                >
                                    <p className={`text-m3-body-compact leading-snug ${muted} mt-1`}>
                                        {t(`cal.desc.${hm}`)}
                                    </p>
                                    <ModelPreviewCanvas
                                        active={historyMode === hm}
                                        method={method}
                                        data={data}
                                        model={curveFor(method, hm)}
                                    />
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

                {/* Attribution: the learning models mirror those on hrt.transmtf.com. */}
                <p className={`m3-text-2xs leading-snug ${muted} mt-8`}>
                    {t('cal.source')}
                </p>
            </div>
        </div>
    );
};

export default CalibrationSettings;
