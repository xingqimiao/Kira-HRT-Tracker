import React, { useMemo, useState } from 'react';
import Icon from '../components/Icon';
import { ArrowLeft, Check, Minus } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { CalibrationMethod, CalibrationHistoryMode, CalibrationResult } from '../../logic';
import ModelPreviewCanvas from '../components/ModelPreviewCanvas';
import { MODEL_COLOR_VAR } from '../utils/modelPreview';

interface CalibrationSettingsProps {
    method: CalibrationMethod;
    setMethod: (m: CalibrationMethod) => void;
    historyMode: CalibrationHistoryMode;
    setHistoryMode: (m: CalibrationHistoryMode) => void;
    calibration: CalibrationResult;
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

const CalibrationSettings: React.FC<CalibrationSettingsProps> = ({
    method, setMethod, historyMode, setHistoryMode, calibration, onBack,
}) => {
    const { t } = useTranslation();

    const showFit = method !== 'off' && calibration.points.length > 0;
    const signedPct = (p: number) => `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`;

    /** A model's identity hue as a CSS value, for the card name and border. */
    const accentOf = (m: CalibrationMethod): string => `var(${MODEL_COLOR_VAR[m]})`;

    // Replay counters. Cards play once on mount (value 0); tapping bumps the tapped card's
    // counter, which replays only that one.
    const [playTick, setPlayTick] = useState<Record<string, number>>({});
    const replay = (k: string): void => setPlayTick((p) => ({ ...p, [k]: (p[k] ?? 0) + 1 }));

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
                            onClick={() => { setMethod(value); replay(value); }}
                        >
                            <p className={`text-m3-body-compact leading-snug ${muted} mt-1`}>
                                {t(`cal.short.${value}`)}
                            </p>
                            <ModelPreviewCanvas
                                method={value}
                                replay={playTick[value] ?? 0}
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
                                    onClick={() => { setHistoryMode(hm); replay(`h:${hm}`); }}
                                >
                                    <p className={`text-m3-body-compact leading-snug ${muted} mt-1`}>
                                        {t(`cal.short.${hm}`)}
                                    </p>
                                    <ModelPreviewCanvas
                                        method={method}
                                        history={hm}
                                        replay={playTick[`h:${hm}`] ?? 0}
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
