import React from 'react';
import FitText from '../components/FitText';
import Icon from '../components/Icon';
import { Info, Share2, AlertTriangle } from '../icons';
import { DoseEvent, SimulationResult, LabResult, AntiandrogenChartMode, getDoseAdvisory, getHormoneLevelAdvisory, isT_LabUnit, isMonitoringOnlyLab, modelledEvents, antiandrogenReading } from '../../logic';
import ResultChart from '../components/ResultChart';
import DoseHeatmap from '../components/DoseHeatmap';
import EstimateInfoModal from '../components/EstimateInfoModal';
import NoticeModal from '../components/NoticeModal';
import DoseAdvisoryNotice from '../components/DoseAdvisory';
import HomeQuickAdd from '../components/HomeQuickAdd';
import { DoseTemplate } from '../components/DoseFormModal';
import AnimatedNumber from '../components/AnimatedNumber';
import BloodVial from '../components/BloodVial';
import { useHRTMode } from '../contexts/HRTModeContext';
import { AppTheme } from '../constants';
import { useTranslation } from '../contexts/LanguageContext';
import { getShareCopy } from '../i18n/share';
import { Tooltip } from '../components/ui';
import { formatRelative } from '../utils/helpers';

/** Drawn width of the vial, in px. Height follows the canvas' 18:42. */
const VIAL_SIZE = 44;

/**
 * A blood-level reading: the number, its unit, and the size it has to be.
 *
 * The card's display role is sized for four digits and a point — "112.8", the width
 * the card was built around. A calibrated estimate can read 23184.5, which at the
 * full role drew straight past the card and off a phone. So the size is capped
 * against the lane the reading actually has: it steps down as far as the digits
 * need, and never grows past the display role.
 *
 * Per-character width is measured, not chosen. `tabular-nums` at this size runs
 * 0.47em per digit at four digits and settles at 0.49 by six; 0.5 is the safe end
 * of that range, so a long reading never overruns the lane it was fitted to.
 *
 * The lane arrives as a CSS custom property rather than a prop because the space a
 * reading gets is a fact about its own row, not about the viewport — below `sm` the
 * vial shares the column with it, so a caller sets `--reading-lane` on the row.
 */
const Reading: React.FC<{
    value: number;
    decimals: number;
    unit: string;
    className: string;
    muted: string;
    /** Set when this reading's digits are a droplet target for the vial. */
    sprayable?: boolean;
}> = ({ value, decimals, unit, className, muted, sprayable = false }) => {
    const text = value.toFixed(decimals);
    return (
        <>
            <span
                data-vial-sprayable={sprayable ? true : undefined}
                className={`leading-none tabular-nums ${className}`}
                style={{
                    fontSize: `min(var(--md-sys-typescale-display-large-size), calc(var(--reading-lane) / ${text.length} / 0.5))`,
                }}
            ><AnimatedNumber value={value} decimals={decimals} /></span>
            <span className={`text-xs lowercase ${muted}`}>{unit}</span>
        </>
    );
};

interface HomeProps {
    t: (key: string) => string;
    currentLevel: number;
    currentT: number;
    currentStatus: { label: string, color: string, bg: string, border: string } | null;
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
}

const Home: React.FC<HomeProps> = ({
    t,
    currentLevel,
    currentT,
    currentStatus,
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
}) => {
    const isDarkMode = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const [isEstimateInfoOpen, setIsEstimateInfoOpen] = React.useState(false);
    const [isAbsurdOpen, setIsAbsurdOpen] = React.useState(false);
    const { isTransmasc } = useHRTMode();
    const { lang } = useTranslation();
    const shareCopy = getShareCopy(lang);

    // Warn on how much medication was actually logged (a hard fact), and nudge
    // toward calibration when there's no lab yet to anchor the estimate.
    const doseAdvisory = React.useMemo(() => getDoseAdvisory(events), [events]);
    const hormoneAdvisory = React.useMemo(() => getHormoneLevelAdvisory(labResults), [labResults]);
    // Only the compounds the model simulates reach the chart; an anti-androgen
    // record keeps its row in the timeline below without adding a curve or an axis.
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
    // is structurally zero. What the column shows is derived from the records
    // instead: the drug the user actually logs, and either today's mg or the time
    // since the last dose — see antiandrogenReading. Cumulative CPA grams, the
    // figure the ≥10 g monitoring notice quotes, is one of the settings rather
    // than the only reading.
    const antiandrogen = React.useMemo(
        () => antiandrogenReading(events, nowMs / 3_600_000, aaChartMode),
        [events, nowMs, aaChartMode],
    );
    // Names the drug the reading is about. 'none' keeps the column's old CPA
    // heading, and 'grams' is CPA by definition; the rest carry their own compound.
    const aaHeading = antiandrogen.kind === 'grams'
        ? t('ester.CPA')
        : antiandrogen.kind === 'none'
            ? t('label.cpa_chart')
            : t(`ester.${antiandrogen.ester}`);
    // mg doses are whole numbers (25, 50, 100) far more often than not, and this
    // trims without losing the quarter-tablet sizes (12.5, 6.25).
    const mgDecimals = (v: number) => (Number.isInteger(v) ? 0 : Number.isInteger(v * 10) ? 1 : 2);
    const nowSec = nowMs / 1000;

    // The vial stands in the gap between the two readings, so it has to be
    // rendered inside whichever mode branch is active. It shows the current
    // estimate, which is the number printed directly beside it — the drawing is a
    // second reading of one value, not a summary of two.
    //
    // Sits on the number's own line and hangs from its top edge: the row above is a
    // label, and centring the tube against a 40-53px number floated it too low, so
    // its rim read as belonging to the gap underneath rather than to the reading.
    //
    // Six of the canvas' 42 rows, which is what puts the glass rim level with the top
    // of the digits beside it: rows 0..2 are empty, 3..5 are dome headroom above the
    // rim. Measured at both type sizes (36px and 52.8px) — with `leading-none` on the
    // number the rim lands within a pixel of the box top at each.
    //
    // It only gives up its place beside the reading when the reading cannot fit
    // next to it. Below `sm` the column is ~146px and the vial takes 52, which is
    // enough for four digits and a point — the width this card was built around, and
    // the case the layout must not disturb. A longer reading steps down in size
    // *and* drops the vial to its own line, so a corrected record looks exactly as
    // it always did and only the pathological ones move anything.
    const vialOffset = -(VIAL_SIZE * 6) / 42;
    // Five characters is "1234.5" — the widest reading that still fits the 94px
    // lane beside the vial at the display role, which is why it is the line between
    // "sits as it always did" and "moves things". When it drops, the row gains
    // `flex-wrap` so the tube can actually reach its own line, and centres itself
    // under the digits.
    const vialDrops = (isTransmasc ? currentT.toFixed(0) : currentLevel.toFixed(1)).length > 5;
    const vial = (events.length > 0 || hormoneLabs.length > 0) ? (
        <span
            className={`flex shrink-0 self-start ${vialDrops ? 'w-full justify-center [--vial-drop:14px]' : ''}`}
            style={{ marginTop: `calc(${vialOffset}px + var(--vial-drop, 0px))` }}
        >
            {/* Sized against the reading beside it. The canvas is 26 wide but the tube is
                only 14 of those columns (the rest is spill room), so the drawn vial is
                about half the nominal size — at 30 the spill stops being legible, which is
                the whole reason for drawing it. */}
            <BloodVial
                level={isTransmasc ? currentT : currentLevel}
                mode={isTransmasc ? 'transmasc' : 'transfem'}
                size={VIAL_SIZE}
                // Moves the warning badge off the tube's top, where the unit label
                // now sits — see `.vial-badge-aside`.
                className={vialDrops ? 'vial-badge-aside' : ''}
            />
        </span>
    ) : null;

    const on = "text-[var(--color-m3-on-surface)] ";
    const muted = "text-[var(--color-m3-on-surface-variant)] ";
    const dim = "text-[var(--color-m3-on-surface-variant)] opacity-35 ";

    return (
        <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-6 md:px-8">
            <EstimateInfoModal isOpen={isEstimateInfoOpen} onClose={() => setIsEstimateInfoOpen(false)} />
            <NoticeModal
                isOpen={isAbsurdOpen}
                onClose={() => setIsAbsurdOpen(false)}
                titleKey="modal.absurd.title"
                bodyKey="modal.absurd.body"
                icon={<Icon icon={AlertTriangle} weight="Filled" size={28} className="text-[var(--color-m3-vial-warn)]" />}
            />

            <header className="pt-8 pb-6">
                <div className="m3-card mb-2">
                {/* Title row */}
                <div className="flex items-center justify-between mb-5">
                    <div className="flex items-center gap-1.5">
                        <h1 className="m3-card-title">{t('status.estimate')}</h1>
                        <Tooltip label={t('status.read_me')}>
                            <button
                                onClick={() => setIsEstimateInfoOpen(true)}
                                className={`${muted} hover:text-[var(--color-m3-on-surface)] `}
                                aria-label={t('status.read_me')}
                            >
                                <Icon icon={Info} size={13} />
                            </button>
                        </Tooltip>
                    </div>
                    <div className="flex items-center gap-3">
                        {currentStatus && (
                            <span className={`hidden sm:inline text-xs font-medium ${currentStatus.color}`}>
                                {t(currentStatus.label)}
                            </span>
                        )}
                        <button
                            type="button"
                            disabled={!events.length}
                            aria-label={shareCopy.action}
                            onClick={() => {
                                if (!authToken) {
                                    onAuthRequired();
                                    return;
                                }
                                onNavigateToShare();
                            }}
                            className={`${muted} inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:text-[var(--color-m3-on-surface)] hover:bg-[var(--color-m3-surface-container)]   disabled:cursor-not-allowed disabled:opacity-40`}
                            title={events.length ? shareCopy.modalDescription : shareCopy.noData}
                        >
                            <Icon icon={Share2} size={14} strokeWidth={1.75} />
                            {/* Same as the quick-add control beside it: the word is what
                                overflows a 390px card, so it waits for `sm`. */}
                            <span className="hidden sm:inline">{shareCopy.action}</span>
                        </button>
                        {/* The card's corner slot. It reads as the card's own action here
                            rather than as a page control, which is what it is — it adds to
                            the same readings the card is showing. */}
                        <HomeQuickAdd
                            templates={doseTemplates}
                            onAddEvent={onAddEvent}
                            onRemoveEvent={onRemoveEvent}
                        />
                    </div>
                </div>

                {/* Blood level grid — two readings, each centred in its own half so the
                    pair is symmetric instead of one column hugging the left edge and the
                    other the right. The container stays narrow (max-w-xl) and centred:
                    stretched across the card, the two numbers sit ~700px apart on a
                    desktop and stop reading as a pair.
                    On a 375px screen the vial plus two four-digit readings don't fit
                    across, hence the wrapping number lines. */}
                <div className={`mx-auto grid w-full grid-cols-2 gap-4 text-center sm:gap-8 ${isTransmasc ? 'max-w-md' : 'max-w-xl'}`}>
                    {isTransmasc ? (
                        <>
                            <div className="min-w-0">
                                <p className={`text-xs font-semibold ${muted} mb-2`}>
                                    {t('label.total_t')} <span className="opacity-60">(ng/dL)</span>
                                </p>
                                <div className={`flex items-start justify-center gap-x-2 ${vialDrops ? 'flex-wrap' : ''} [--reading-lane:146px] sm:[--reading-lane:272px]`}>
                                    <span className="flex flex-wrap items-baseline justify-center gap-x-1.5 gap-y-1">
                                        {currentT > 0 ? (
                                            <Reading value={currentT} decimals={0} unit="ng/dl" className={on} muted={muted} sprayable />
                                        ) : (
                                            <span className={`text-m3-display-large leading-none ${dim}`}>--</span>
                                        )}
                                    </span>
                                    {vial}
                                </div>
                            </div>
                            <div className="min-w-0">
                                <p className={`text-xs font-semibold ${muted} mb-2`}>
                                    {t('label.total_t')} <span className="opacity-60">(nmol/L)</span>
                                </p>
                                <div className="flex min-w-0 flex-wrap items-baseline justify-center gap-x-1.5 gap-y-1 [--reading-lane:146px] sm:[--reading-lane:272px]">
                                    {currentT > 0 ? (
                                        <Reading value={currentT / 28.842} decimals={1} unit="nmol/l" className={on} muted={muted} />
                                    ) : (
                                        <span className={`text-m3-display-large leading-none ${dim}`}>--</span>
                                    )}
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="min-w-0">
                                <p className={`text-xs font-semibold ${muted} mb-2`}>{t('label.e2')}</p>
                                <div className={`flex items-start justify-center gap-x-2 ${vialDrops ? 'flex-wrap' : ''} [--reading-lane:146px] sm:[--reading-lane:272px]`}>
                                    {/* `leading-none` is what makes "the top of the number" a
                                        real edge: at the shared 1.4 line-height the box top sat
                                        a few px above the ink, and the vial had nothing precise
                                        to hang from. */}
                                    <span className="flex flex-wrap items-baseline justify-center gap-x-1.5 gap-y-1">
                                        {currentLevel > 0 ? (
                                            <Reading value={currentLevel} decimals={1} unit="pg/ml" className={on} muted={muted} sprayable />
                                        ) : (
                                            <span className={`text-m3-display-large leading-none ${dim}`}>--</span>
                                        )}
                                    </span>
                                    {vial}
                                </div>
                            </div>
                            <div className="min-w-0">
                                <p className={`text-xs font-semibold ${muted} mb-2`}>{aaHeading}</p>
                                {/* The column has no vial in it, so the whole track is the
                                    reading's lane at every width — unlike the E2 column, whose
                                    smaller `sm` value is the vial's share taken out. */}
                                <div className="flex min-w-0 flex-wrap items-baseline justify-center gap-x-1.5 gap-y-1 [--reading-lane:146px] sm:[--reading-lane:272px]">
                                    {antiandrogen.kind === 'grams' && (
                                        // Cumulative grams, not a concentration: CPA has no
                                        // curve, and the monitoring notice quotes the same
                                        // figure against the ≥10 g threshold. Two decimals
                                        // because a 12.5 mg tablet is 0.0125 g — and the
                                        // figure only ever grows, so a few years of records
                                        // reaches five figures and would have run off the card.
                                        <Reading value={antiandrogen.grams} decimals={2} unit="g" className={on} muted={muted} sprayable />
                                    )}
                                    {antiandrogen.kind === 'dose' && (
                                        // Today's total, the reading the daily-dosed
                                        // anti-androgens use and CPA uses on a dose day.
                                        <Reading value={antiandrogen.mgToday} decimals={mgDecimals(antiandrogen.mgToday)} unit="mg" className={on} muted={muted} sprayable />
                                    )}
                                    {antiandrogen.kind === 'since' && (
                                        // How long ago the last dose was, in the reader's own
                                        // relative-time wording — the honest reading for a drug
                                        // taken every few days, where a mg count says nothing.
                                        // Relative time is words, not a number: "2 天前" is
                                        // four glyphs, "2 个月前" is five, "12 个月前" is six.
                                        // One fixed role is wrong for most of its own values —
                                        // big enough for the shortest overflows on the next,
                                        // small enough for the longest makes the common case
                                        // look half-empty — so the size is measured against
                                        // the slot instead. It keeps the display role the
                                        // numeric readings use, and only steps down as far as
                                        // the text needs.
                                        <FitText className={`text-m3-display-large leading-none ${on}`}>
                                            {formatRelative(nowSec - antiandrogen.sinceH * 3600, nowSec, t)}
                                        </FitText>
                                    )}
                                    {antiandrogen.kind === 'none' && (
                                        // E2's placeholder is `text-m3-display-large
                                        // leading-none ${dim}`; this one matches it now. The
                                        // old cumulative reading used a smaller size and the
                                        // *muted text* role, so the two dashes read as different
                                        // states rather than as the same absence.
                                        <span className={`text-m3-display-large leading-none ${dim}`}>--</span>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                <div className="mt-3">
                    <DoseAdvisoryNotice advisory={doseAdvisory} hormoneAdvisory={hormoneAdvisory} showCalibrate={showCalibrate} onCalibrate={onNavigateToLab} t={t} />
                </div>
                </div>
            </header>

            {/* The chart column keeps its reading width; on a wide desktop the
                dose heatmap takes the space left over beside it rather than
                letting it sit empty, and drops underneath when there isn't any.
                Only widened once there's data — the empty state centres itself
                on this container and should stay in the narrow column. */}
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
                    <div className="flex flex-col gap-8 2xl:flex-row 2xl:items-start 2xl:gap-6">
                        <div className="min-w-0 2xl:flex-[3]">
                            <ResultChart
                                sim={simulation}
                                events={chartEvents}
                                onPointClick={onEditEvent}
                                labResults={hormoneLabs}
                                calibrationFn={calibrationFn}
                                isDarkMode={isDarkMode}
                            />
                        </div>
                        <DoseHeatmap
                            events={events}
                            className="min-w-0 2xl:flex-[2] 2xl:min-w-[16rem]"
                        />
                    </div>
                )}
            </main>
        </div>
    );
};

export default Home;
