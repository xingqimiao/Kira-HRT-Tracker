import React from 'react';
import Icon from '../components/Icon';
import { Info, Share2, AlertTriangle, TriangleWarning } from '../icons';
import { DoseEvent, SimulationResult, LabResult, AntiandrogenChartMode, getDoseAdvisory, getHormoneLevelAdvisory, isT_LabUnit, isMonitoringOnlyLab, modelledEvents, antiandrogenReading, type PkEngineId } from '../../logic';
import ResultChart from '../components/ResultChart';
import DoseOrderBook from '../components/DoseOrderBook';
import EstimateInfoModal from '../components/EstimateInfoModal';
import NoticeModal from '../components/NoticeModal';
import DoseAdvisoryNotice from '../components/DoseAdvisory';
import HomeQuickAdd from '../components/HomeQuickAdd';
import DoseForm from '../components/DoseForm';
import { DoseTemplate } from '../components/DoseFormModal';
import { QuickDose } from '../components/dose_form/QuickDoseButtons';
import { createPortal } from 'react-dom';
import { useEscape } from '../hooks/useEscape';
import { useHRTMode } from '../contexts/HRTModeContext';
import { AppTheme, ChartStyle } from '../constants';
import { useTranslation } from '../contexts/LanguageContext';
import { getShareCopy } from '../i18n/share';
import { Tooltip } from '../components/ui';
import { formatRelativeParts } from '../utils/helpers';
import { readMedPlans, planStatuses, planQuickEntries, type PlanStatus } from '../utils/medPlan';
import { usePresence } from '../hooks/usePresence';

interface HomeProps {
    t: (key: string) => string;
    currentLevel: number;
    currentT: number;
    currentStatus: { label: string, color: string, bg: string, border: string } | null;
    /** The peak concentration each dose produces alone — the order book's bar basis. */
    dosePeaks: Record<string, number>;
    events: DoseEvent[];
    simulation: SimulationResult | null;
    labResults: LabResult[];
    onEditEvent: (e: DoseEvent) => void;
    calibrationFn: (timeH: number) => number;
    theme: AppTheme;
    onNavigateToHistory: () => void;
    onNavigateToLab: () => void;
    onNavigateToShare: () => void;
    authToken: string | null;
    onAuthRequired: () => void;
    /** Saved doses the overview can log in one tap — see HomeQuickAdd. */
    doseTemplates: DoseTemplate[];
    onAddEvent: (e: DoseEvent) => void;
    /** The undo for a one-tap add, once the notice has closed. */
    onRemoveEvent: (id: string) => void;
    /** Which reading the anti-androgen column shows — see antiandrogenReading. */
    aaChartMode: AntiandrogenChartMode;
    /** "Now" for that reading, so "today" rolls over when the day does. */
    nowMs: number;
    /** Line or candles for the chart — the same personalization setting. */
    chartStyle: ChartStyle;
    /** Whether E2/T readings show a decimal place. Default off (whole numbers). */
    readingDecimals: boolean;
    /** Whether the overview hides the anti-androgen reading entirely. */
    hideAA: boolean;
    /** Passthroughs for the inline dose form the terminal embeds. */
    onSaveTemplate: (t: DoseTemplate) => void;
    onDeleteTemplate: (id: string) => void;
    quickDoses: QuickDose[];
    onAddQuickDose: (d: QuickDose) => void;
    onDeleteQuickDose: (id: string) => void;
    activeEngine: PkEngineId;
}

/**
 * The overview: a market-style terminal.
 *
 * One layout, not two. It used to be a reading card (with a drawn blood-vial) for
 * the line chart and a three-pane terminal (price strip | chart | order book |
 * record form) for the candles. The terminal is what a person reads at a glance —
 * the modelled estimate as a "last price", the recent doses as an order book, and
 * a one-tap record form — so it is now the overview for both chart styles, and the
 * chart itself is the personalization: the line curve by default, candles on request.
 * The vial and the big readings card are gone with the second layout; the price
 * strip carries the same two readings.
 */
const Home: React.FC<HomeProps> = ({
    t,
    currentLevel,
    currentT,
    currentStatus,
    dosePeaks,
    events,
    simulation,
    labResults,
    onEditEvent,
    calibrationFn,
    theme,
    onNavigateToHistory,
    onNavigateToLab,
    onNavigateToShare,
    authToken,
    onAuthRequired,
    doseTemplates,
    onAddEvent,
    onRemoveEvent,
    aaChartMode,
    nowMs,
    chartStyle,
    readingDecimals,
    hideAA,
    onSaveTemplate,
    onDeleteTemplate,
    quickDoses,
    onAddQuickDose,
    onDeleteQuickDose,
    activeEngine,
}) => {
    const isDarkMode = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const [isEstimateInfoOpen, setIsEstimateInfoOpen] = React.useState(false);
    const [isAbsurdOpen, setIsAbsurdOpen] = React.useState(false);
    // The record the inline form is pre-filled from, when a dose row was clicked
    // in the order book ("record this again"). Null leaves the form at its defaults
    // for a plain new dose. Bumped key remounts the form so its fields take the
    // prefill (its state initialises once, at mount).
    const [repeatFrom, setRepeatFrom] = React.useState<DoseEvent | null>(null);
    const [formSeq, setFormSeq] = React.useState(0);
    const { isTransmasc } = useHRTMode();
    const { lang } = useTranslation();
    const shareCopy = getShareCopy(lang);

    // Warn on how much medication was actually logged (a hard fact), and nudge
    // toward calibration when there's no lab yet to anchor the estimate.
    const doseAdvisory = React.useMemo(() => getDoseAdvisory(events), [events]);
    const hormoneAdvisory = React.useMemo(() => getHormoneLevelAdvisory(labResults), [labResults]);
    // Only the compounds the model simulates reach the chart; an anti-androgen
    // record keeps its row in the order book without adding a curve or an axis.
    const chartEvents = React.useMemo(() => modelledEvents(events), [events]);
    // The chart and the "have you calibrated" nudge only read hormone labs; a
    // monitoring-only record carries a placeholder 0/pg-mL and would be plotted as
    // an estradiol of zero. See LabResult.monitoringOnly.
    const hormoneLabs = React.useMemo(() => labResults.filter(l => !isMonitoringOnlyLab(l)), [labResults]);
    const hasLabForMode = hormoneLabs.some(l => (isTransmasc ? isT_LabUnit(l.unit) : !isT_LabUnit(l.unit)));
    const showCalibrate = events.length > 0 && !hasLabForMode;
    // Five figures of pg/mL, or of ng/dL, is not a high reading — it is a typo. A
    // dose entered with an extra digit, a mg figure read as µg, a stray lab result
    // that dragged the curve: the model will happily report any of them, and the
    // number then looks like a fact. Says so once per crossing rather than on every
    // render, so the notice does not become the thing that gets ignored.
    const absurdLevel = isTransmasc ? currentT : currentLevel;
    const absurd = absurdLevel > 10000;
    const absurdNoticed = React.useRef(false);
    React.useEffect(() => {
        if (absurd && !absurdNoticed.current) {
            absurdNoticed.current = true;
            setIsAbsurdOpen(true);
        } else if (!absurd) {
            // Re-arm below the threshold: a reading corrected by 100 gets to be
            // reported again if it goes back up, which is the point of the notice.
            absurdNoticed.current = false;
        }
    }, [absurd]);
    // Anti-androgens are recorded, not modelled, so their "current concentration"
    // is structurally zero. What the strip shows is derived from the records
    // instead: the drug the user actually logs, and either today's mg or the time
    // since the last dose — see antiandrogenReading.
    const antiandrogen = React.useMemo(
        () => antiandrogenReading(events, nowMs / 3_600_000, aaChartMode),
        [events, nowMs, aaChartMode],
    );
    // Names the drug the reading is about. 'none' keeps the old CPA heading, and
    // 'grams' is CPA by definition; the rest carry their own compound.
    const aaHeading = antiandrogen.kind === 'grams'
        ? t('ester.CPA')
        : antiandrogen.kind === 'none'
            ? t('label.cpa_chart')
            : t(`ester.${antiandrogen.ester}`);
    // mg doses are whole numbers (25, 50, 100) far more often than not, and this
    // trims without losing the quarter-tablet sizes (12.5, 6.25).
    const mgDecimals = (v: number) => (Number.isInteger(v) ? 0 : Number.isInteger(v * 10) ? 1 : 2);
    const nowSec = nowMs / 1000;

    // The medication plan, read on-device and checked against the doses on record.
    // This is what drives the overdue badge and the quick-record entries generated
    // for plans the user's own saved templates do not already cover. Recomputed when
    // the log or the clock moves; a plan edited in settings re-reads on the next visit.
    const [showOverdue, setShowOverdue] = React.useState(false);
    const planState = React.useMemo(() => {
        const plans = readMedPlans();
        if (plans.length === 0) return { overdue: false, statuses: [] as PlanStatus[], entries: [] };
        const tz = new Date().getTimezoneOffset();
        const refs = events.map(e => ({ ester: e.ester, route: e.route, timeH: e.timeH }));
        const statuses = planStatuses(plans, refs, nowMs, tz);
        const covered = new Set(doseTemplates.map(d => `${d.ester}:${d.route}`));
        return {
            overdue: statuses.some(s => s.overdue),
            statuses,
            entries: planQuickEntries(plans, covered, t('plan.quick_suffix')),
        };
    }, [events, nowMs, doseTemplates, t]);

    // E2 and the transmasc testosterone reading show a decimal place only when the
    // setting asks (whole numbers by default).
    const primaryDecimals = readingDecimals ? 1 : 0;

    // The compact price strip. The model's current estimate in the theme's accent
    // colour (like a market price), the anti-androgen in plain on-surface (it is not
    // a concentration and has no curve to be coloured by). Each is a labelled
    // value-plus-unit pair.
    const pricePair = isTransmasc
        ? { label: t('label.total_t'), value: currentT.toFixed(0), unit: 'ng/dl' }
        : { label: t('label.e2'), value: currentLevel.toFixed(primaryDecimals), unit: 'pg/ml' };
    // The "N 小时前" reading is a number plus its words, like every other reading
    // in this strip: the digits keep the display size and the words ("小时前") drop
    // to the small muted unit size — the same split "pg/ml" gets beside the
    // estradiol value. `formatRelative` returns the whole phrase as one string, so
    // using it here put "23 小时前" all at display size; `formatRelativeParts` does
    // the split ("23" + "小时前"), exactly as the older day-ago reading did.
    const sinceParts = antiandrogen.kind === 'since'
        ? formatRelativeParts(nowSec - antiandrogen.sinceH * 3600, nowSec, t)
        : null;
    const aaPair = {
        label: aaHeading,
        value: antiandrogen.kind === 'grams' ? antiandrogen.grams.toFixed(2)
            : antiandrogen.kind === 'dose' ? antiandrogen.mgToday.toFixed(mgDecimals(antiandrogen.mgToday))
                : antiandrogen.kind === 'since' ? (sinceParts?.value ?? '')
                    : '--',
        // "刚刚" has no number, so it renders small on its own (an empty value span).
        unit: antiandrogen.kind === 'grams' ? 'g' : antiandrogen.kind === 'dose' ? 'mg'
            : antiandrogen.kind === 'since' ? (sinceParts?.unit ?? t('time.just_now'))
                : '',
    };

    const on = "text-[var(--color-m3-on-surface)] ";
    const muted = "text-[var(--color-m3-on-surface-variant)] ";

    return (
        <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 md:px-8">
            <EstimateInfoModal isOpen={isEstimateInfoOpen} onClose={() => setIsEstimateInfoOpen(false)} />
            <NoticeModal
                isOpen={isAbsurdOpen}
                onClose={() => setIsAbsurdOpen(false)}
                titleKey="modal.absurd.title"
                bodyKey="modal.absurd.body"
                icon={<Icon icon={AlertTriangle} weight="Filled" size={28} className="text-[var(--color-m3-vial-warn)]" />}
            />
            <OverdueModal statuses={planState.statuses} isOpen={showOverdue} onClose={() => setShowOverdue(false)} t={t} />

            <header className="pt-5 pb-4">
                {/* The terminal's price strip. No card: the overview is a chart with
                    the current estimate as its "last price". Sits above the chart the
                    way a market header sits above its candles, and keeps the share /
                    quick-add actions to its right. */}
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                    <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
                        <div className="min-w-0">
                            <p className={`text-xs font-semibold ${muted}`}>{pricePair.label}</p>
                            <p className="flex items-baseline gap-1.5 leading-none">
                                <span className="text-[2.5rem] font-semibold tabular-nums text-[var(--color-m3-primary)]">{pricePair.value}</span>
                                <span className={`text-sm lowercase ${muted}`}>{pricePair.unit}</span>
                            </p>
                        </div>
                        {/* The anti-androgen column shows only when there is something to
                            report. With no anti-androgen on record `kind` is 'none', and
                            the old behaviour drew a "--" placeholder — an empty column
                            taking the space of a real reading. Hidden unless the user
                            explicitly turned it off, this reads as "no anti-androgen
                            logged yet", which is the truth. */}
                        {!hideAA && antiandrogen.kind !== 'none' && (
                        <div className="min-w-0">
                            <p className={`text-xs font-semibold ${muted}`}>{aaPair.label}</p>
                            <p className="flex items-baseline gap-1.5 leading-none">
                                {aaPair.value && <span className={`font-semibold tabular-nums ${on} ${aaPair.value.length > 6 ? 'text-2xl' : 'text-[2.5rem]'}`}>{aaPair.value}</span>}
                                {aaPair.unit && <span className={`text-sm lowercase ${muted}`}>{aaPair.unit}</span>}
                            </p>
                        </div>
                        )}
                    </div>
                    <div className="flex items-center gap-3">
                        <Tooltip label={t('status.read_me')}>
                            <button
                                onClick={() => setIsEstimateInfoOpen(true)}
                                className={`${muted} hover:text-[var(--color-m3-on-surface)] `}
                                aria-label={t('status.read_me')}
                            >
                                <Icon icon={Info} size={13} />
                            </button>
                        </Tooltip>
                        {currentStatus && (
                            <span className={`text-xs font-medium ${currentStatus.color}`}>
                                {t(currentStatus.label)}
                            </span>
                        )}
                        <button
                            type="button"
                            disabled={!events.length}
                            aria-label={shareCopy.action}
                            onClick={() => {
                                if (!authToken) { onAuthRequired(); return; }
                                onNavigateToShare();
                            }}
                            className={`${muted} inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:text-[var(--color-m3-on-surface)] hover:bg-[var(--color-m3-surface-container)] disabled:cursor-not-allowed disabled:opacity-40`}
                            title={events.length ? shareCopy.modalDescription : shareCopy.noData}
                        >
                            <Icon icon={Share2} size={14} strokeWidth={1.75} />
                            <span className="hidden sm:inline">{shareCopy.action}</span>
                        </button>
                        <HomeQuickAdd
                            templates={doseTemplates}
                            onAddEvent={onAddEvent}
                            onRemoveEvent={onRemoveEvent}
                            planTemplates={planState.entries}
                            overdue={planState.overdue}
                            onOverdueClick={() => setShowOverdue(true)}
                        />
                    </div>
                    {/* The advisories stay in the terminal too — a "doses running
                        high" notice must not be lost just because the layout
                        changed. They sit under the price strip, full width. */}
                    <div className="w-full">
                        <DoseAdvisoryNotice advisory={doseAdvisory} hormoneAdvisory={hormoneAdvisory} showCalibrate={showCalibrate} onCalibrate={onNavigateToLab} t={t} />
                    </div>
                </div>
            </header>

            {/* The three-pane terminal: chart | order book | record. Stretch so the
                three panes end together; stacked below `lg`, where the form is gone
                (recording happens on the History page on a phone). Only widened once
                there's data — the empty state centres itself in the narrow column. */}
            <main className="w-full pb-24">
                {events.length === 0 ? (
                    <div className="m3-card flex flex-col items-center justify-center text-center !py-20">
                        <p className={`text-base font-semibold ${on} mb-1`}>{t('home.empty_title')}</p>
                        <p className={`text-sm ${muted} mb-6 max-w-xs`}>{t('home.empty_subtitle')}</p>
                        <button
                            onClick={onNavigateToHistory}
                            className="m3-btn m3-btn-filled"
                        >
                            {t('home.empty_cta')}
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
                        <div className="min-w-0 lg:flex-[4]">
                            <ResultChart
                                sim={simulation}
                                events={chartEvents}
                                onPointClick={onEditEvent}
                                labResults={hormoneLabs}
                                calibrationFn={calibrationFn}
                                isDarkMode={isDarkMode}
                                // The chart is the personalization: the line curve by
                                // default, candles on request. The layout around it is
                                // the same either way.
                                chartStyle={chartStyle}
                                tall
                            />
                        </div>
                        <DoseOrderBook
                            events={events}
                            dosePeaks={dosePeaks}
                            onRepeat={(e) => { setRepeatFrom(e); setFormSeq(s => s + 1); }}
                            // Shrinks first when the row is tight, so a desktop
                            // stays a row instead of collapsing.
                            className="min-w-0 lg:flex-[2] lg:min-w-[9rem]"
                        />
                        <div className="m3-card hidden min-w-0 p-4 lg:flex lg:flex-[2] lg:min-w-[17rem] lg:flex-col">
                            <DoseForm
                                key={`${repeatFrom?.id ?? 'new'}-${formSeq}`}
                                eventToEdit={repeatFrom}
                                addMode={!!repeatFrom}
                                hideTime
                                hideTemplates
                                onSave={(e) => onAddEvent(e as DoseEvent)}
                                onCancel={() => { setRepeatFrom(null); setFormSeq(s => s + 1); }}
                                onDelete={() => {}}
                                templates={doseTemplates}
                                onSaveTemplate={onSaveTemplate}
                                onDeleteTemplate={onDeleteTemplate}
                                quickDoses={quickDoses}
                                onAddQuickDose={onAddQuickDose}
                                onDeleteQuickDose={onDeleteQuickDose}
                                isInline
                                accentSubmit
                                events={events}
                                activeEngine={activeEngine}
                            />
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
};

/**
 * Today's missed doses, listed from the plan the user wrote.
 *
 * The same portal/escape/presence shell `NoticeModal` uses, but with a list rather
 * than a paragraph: this answers "what am I behind on" with the plans themselves,
 * each due time the app is still waiting on, and what the user said to take. It
 * offers no logging of its own — the quick-record button beside the badge is what
 * clears a dose, and hitting it from the list would be a second path to the same
 * write with none of the undo the button carries.
 */
const OverdueModal: React.FC<{
    statuses: PlanStatus[];
    isOpen: boolean;
    onClose: () => void;
    t: (key: string) => string;
}> = ({ statuses, isOpen, onClose, t }) => {
    useEscape(onClose, isOpen);
    const { mounted, state } = usePresence(isOpen, 200);
    const missed = statuses.filter(s => s.overdue);

    if (!mounted) return null;

    const timeOf = (ms: number) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    return createPortal(
        // Centred on every width, unlike the shared `.modal-overlay` (a bottom sheet
        // below 768px): this is a short status list with one action, not a sheet, and
        // a dialog pinned to the bottom edge of a tall phone reads as unanchored. The
        // inline style overrides the unlayered `.modal-overlay` alignment, which a
        // Tailwind utility could not (unlayered CSS wins over the utility layer here).
        <div className="modal-overlay z-[60]" data-state={state} style={{ alignItems: 'center', padding: '1rem' }}>
            <div className="modal-shell">
                <div className="modal-card">
                    <div className="flex justify-center mb-3">
                        <Icon icon={TriangleWarning} weight="Filled" size={28} className="text-[var(--color-m3-warning)]" />
                    </div>
                    <h3 className="modal-title text-center">{t('plan.overdue_title')}</h3>
                    <div className="text-sm text-[var(--color-m3-on-surface)] space-y-3 mb-5 leading-relaxed text-center">
                        {missed.length === 0 ? (
                            <p className="text-[var(--color-m3-on-surface-variant)]">{t('plan.overdue_none')}</p>
                        ) : missed.map(s => (
                            <div key={s.plan.id} className="border-b border-[var(--color-m3-outline-variant)] pb-2.5 last:border-b-0 last:pb-0">
                                <p className="font-medium">
                                    {s.plan.alias || t(`ester.${s.plan.ester}`)}
                                    {s.plan.dose ? <span className="text-[var(--color-m3-on-surface-variant)]"> · {s.plan.dose}</span> : null}
                                </p>
                                <p className="text-xs text-[var(--color-m3-on-surface-variant)] mt-0.5">
                                    {t('plan.overdue_missed_at')}: {s.missed.map(timeOf).join(' · ')}
                                </p>
                            </div>
                        ))}
                    </div>
                    <button onClick={onClose} className="btn-primary w-full">
                        {t('btn.ok')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default Home;
