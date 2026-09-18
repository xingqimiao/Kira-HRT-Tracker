import React from 'react';
import Icon from '../components/Icon';
import { Info, Share2 } from '../icons';
import { DoseEvent, SimulationResult, LabResult, getDoseAdvisory, getHormoneLevelAdvisory, isT_LabUnit } from '../../logic';
import ResultChart from '../components/ResultChart';
import DoseHeatmap from '../components/DoseHeatmap';
import EstimateInfoModal from '../components/EstimateInfoModal';
import DoseAdvisoryNotice from '../components/DoseAdvisory';
import AnimatedNumber from '../components/AnimatedNumber';
import BloodVial from '../components/BloodVial';
import { useHRTMode } from '../contexts/HRTModeContext';
import { AppTheme } from '../constants';
import { useTranslation } from '../contexts/LanguageContext';
import { getShareCopy } from '../i18n/share';

interface HomeProps {
    t: (key: string) => string;
    currentLevel: number;
    currentCPA: number;
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
}

const Home: React.FC<HomeProps> = ({
    t,
    currentLevel,
    currentCPA,
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
}) => {
    const isDarkMode = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const [isEstimateInfoOpen, setIsEstimateInfoOpen] = React.useState(false);
    const { isTransmasc } = useHRTMode();
    const { lang } = useTranslation();
    const shareCopy = getShareCopy(lang);

    // Warn on how much medication was actually logged (a hard fact), and nudge
    // toward calibration when there's no lab yet to anchor the estimate.
    const doseAdvisory = React.useMemo(() => getDoseAdvisory(events), [events]);
    const hormoneAdvisory = React.useMemo(() => getHormoneLevelAdvisory(labResults), [labResults]);
    const hasLabForMode = labResults.some(l => (isTransmasc ? isT_LabUnit(l.unit) : !isT_LabUnit(l.unit)));
    const showCalibrate = events.length > 0 && !hasLabForMode;

    // The vial stands in the gap between the two readings, so it has to be
    // rendered inside whichever mode branch is active. It shows the current
    // estimate, which is the number printed directly beside it — the drawing is a
    // second reading of one value, not a summary of two.
    // Inline right after the reading so it costs a bit of the number's own line
    // rather than a block of its own; on a narrow screen the line wraps and the
    // vial drops under the number rather than shoving the second reading off.
    const vial = (events.length > 0 || labResults.length > 0) ? (
        <span className="flex shrink-0 items-end self-end pb-1">
            {/* Sized against the reading beside it. The canvas is 26 wide but the tube is
                only 14 of those columns (the rest is spill room), so the drawn vial is
                about half the nominal size — at 30 the spill stops being legible, which is
                the whole reason for drawing it. */}
            <BloodVial
                level={isTransmasc ? currentT : currentLevel}
                mode={isTransmasc ? 'transmasc' : 'transfem'}
                size={44}
            />
        </span>
    ) : null;

    const on = "text-[var(--color-m3-on-surface)] ";
    const muted = "text-[var(--color-m3-on-surface-variant)] ";
    const dim = "text-[var(--color-m3-outline-variant)] ";

    return (
        <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-6 md:px-8">
            <EstimateInfoModal isOpen={isEstimateInfoOpen} onClose={() => setIsEstimateInfoOpen(false)} />

            <header className="pt-8 pb-6">
                <div className="m3-card mb-2">
                {/* Title row */}
                <div className="flex items-center justify-between mb-5">
                    <div className="flex items-center gap-1.5">
                        <h1 className="m3-card-title">{t('status.estimate')}</h1>
                        <button
                            onClick={() => setIsEstimateInfoOpen(true)}
                            className={`${muted} hover:text-[var(--color-m3-on-surface)] `}
                            title={t('status.read_me')}
                        >
                            <Icon icon={Info} size={13} />
                        </button>
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
                            {shareCopy.action}
                        </button>
                    </div>
                </div>

                {/* Blood level grid — first reading left, second flush right.
                    On a 375px screen the vial plus two four-digit readings don't
                    fit across, and the second column was being pushed clean off
                    the right edge. The left column is the one that gives: min-w-0
                    lets it shrink and its number line wraps, so the vial drops
                    under the reading. The right column is shrink-0 so it keeps its
                    number and unit together on one line instead of both sides
                    wrapping at once. */}
                <div className="grid max-w-lg grid-cols-2 gap-4 sm:gap-8 md:gap-12">
                    {isTransmasc ? (
                        <>
                            <div className="min-w-0">
                <p className={`text-xs font-semibold ${muted} mb-2`}>
                                    {t('label.total_t')} <span className="opacity-60">(ng/dL)</span>
                                </p>
                                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                                    {currentT > 0 ? (
                                        <>
                                            <span data-vial-sprayable className={`text-4xl md:text-5xl font-light tabular-nums ${on}`}><AnimatedNumber value={currentT} decimals={0} /></span>
                                            <span className={`text-xs lowercase ${muted}`}>ng/dl</span>
                                        </>
                                    ) : (
                                        <span className={`text-4xl md:text-5xl font-light ${dim}`}>--</span>
                                    )}
                                    {vial}
                                </div>
                            </div>
                            <div className="shrink-0 text-right">
                <p className={`text-xs font-semibold ${muted} mb-2`}>
                                    {t('label.total_t')} <span className="opacity-60">(nmol/L)</span>
                                </p>
                                <div className="flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-1">
                                    {currentT > 0 ? (
                                        <>
                                            <span data-vial-sprayable className={`text-4xl md:text-5xl font-light tabular-nums ${on}`}><AnimatedNumber value={currentT / 28.842} decimals={1} /></span>
                                            <span className={`text-xs lowercase ${muted}`}>nmol/l</span>
                                        </>
                                    ) : (
                                        <span className={`text-4xl md:text-5xl font-light ${dim}`}>--</span>
                                    )}
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="min-w-0">
                <p className={`text-xs font-semibold ${muted} mb-2`}>{t('label.e2')}</p>
                                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                                    {currentLevel > 0 ? (
                                        <>
                                            <span data-vial-sprayable className={`text-4xl md:text-5xl font-light tabular-nums ${on}`}><AnimatedNumber value={currentLevel} decimals={1} /></span>
                                            <span className={`text-xs lowercase ${muted}`}>pg/ml</span>
                                        </>
                                    ) : (
                                        <span className={`text-4xl md:text-5xl font-light ${dim}`}>--</span>
                                    )}
                                    {vial}
                                </div>
                            </div>
                            <div className="shrink-0 text-right">
                <p className={`text-xs font-semibold ${muted} mb-2`}>{t('label.cpa_chart')}</p>
                                <div className="flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-1">
                                    {currentCPA > 0 ? (
                                        <>
                                            <span data-vial-sprayable className={`text-4xl md:text-5xl font-light tabular-nums ${on}`}><AnimatedNumber value={currentCPA} decimals={1} /></span>
                                            <span className={`text-xs lowercase ${muted}`}>ng/ml</span>
                                        </>
                                    ) : (
                                        <span className={`text-4xl md:text-5xl font-light ${dim}`}>--</span>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                <div className="mt-2">
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
                            className="btn-secondary"
                        >
                            {t('home.empty_cta')}
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-8 2xl:flex-row 2xl:items-start 2xl:gap-6">
                        <div className="min-w-0 2xl:flex-[3]">
                            <ResultChart
                                sim={simulation}
                                events={events}
                                onPointClick={onEditEvent}
                                labResults={labResults}
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
