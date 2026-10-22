import React from 'react';
import Icon from '../components/Icon';
import { Info, Share2, AlertTriangle, TriangleWarning, X, Bookmark } from '../icons';
import { DoseEvent, SimulationResult, LabResult, AntiandrogenChartMode, Route, getDoseAdvisory, getHormoneLevelAdvisory, isT_LabUnit, isMonitoringOnlyLab, modelledEvents, antiandrogenReading } from '../../logic';
import ResultChart from '../components/ResultChart';
import FitText from '../components/FitText';
import EstimateInfoModal from '../components/EstimateInfoModal';
import NoticeModal from '../components/NoticeModal';
import { DoseTemplate } from '../components/DoseFormModal';
import { rememberTransformSource } from '../ui/ContainerTransform';
import { useHRTMode } from '../contexts/HRTModeContext';
import { AppTheme, ChartStyle } from '../constants';
import { useTranslation } from '../contexts/LanguageContext';
import { getShareCopy } from '../i18n/share';
import { formatRelativeParts } from '../utils/helpers';
import { readMedPlans, planStatuses, planQuickEntries, plansForMode, activePatches, patchRemovalEvent, type PlanStatus } from '../utils/medPlan';
import { templateToEvent } from '../utils/templateToEvent';
import {
    AdaptiveSheet,
    SegmentedList,
    SegmentedListItem,
    Snackbar,
    type LeadingTone,
} from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import { categoryForEster, modeOf } from '../components/dose_form/catalog';

interface HomeProps {
    t: (key: string) => string;
    currentLevel: number;
    currentT: number;
    currentStatus: { label: string, color: string, bg: string, border: string, tone?: 'ok' | 'warn' | 'err' | 'mute' } | null;
    /** The peak concentration each dose produces alone — kept for the page's callers. */
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
    /** Saved doses the overview can log in one tap. */
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
    /** The shell's FAB opens this sheet; the page owns its content. */
    quickRecordOpen: boolean;
    onQuickRecordClose: () => void;
}

/** Route → the sprite icon on a dose row. */
const ROUTE_ICON_ID: Record<string, string> = {
    oral: 'pill',
    sublingual: 'tongue',
    gel: 'gel',
    injection: 'syr',
    patchApply: 'patch',
    patchRemove: 'peel',
};

/**
 * The overview, as an M3 Expressive dashboard.
 *
 * Two columns from 1024px: the readings and the curve on the left, the doses on
 * record on the right (1.15fr / 1fr, 24px). Below that they stack, and the tiles
 * keep their 1.6fr / 1fr tension at every width because that asymmetry is what
 * makes the estradiol reading the subject of the page.
 *
 * The two tiles are the page's only pressable objects: the estradiol reading
 * gives into a 46/14 wedge under the finger, and the companion tile is either the
 * anti-androgen reading (a 26px secondary tile) or — when a patch is actually
 * being worn — a leaf-shaped tertiary tile that reports how long it has been on
 * and removes it in one tap.
 */
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
    chartStyle,
    readingDecimals,
    hideAA,
    quickRecordOpen,
    onQuickRecordClose,
}) => {
    const isDarkMode = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const [isEstimateInfoOpen, setIsEstimateInfoOpen] = React.useState(false);
    const [isAbsurdOpen, setIsAbsurdOpen] = React.useState(false);
    const [undo, setUndo] = React.useState<{ id: string; name: string } | null>(null);
    const { isTransmasc } = useHRTMode();
    const { lang } = useTranslation();
    const shareCopy = getShareCopy(lang);

    const doseAdvisory = React.useMemo(() => getDoseAdvisory(events), [events]);
    const hormoneAdvisory = React.useMemo(() => getHormoneLevelAdvisory(labResults), [labResults]);
    const chartEvents = React.useMemo(() => modelledEvents(events), [events]);
    const hormoneLabs = React.useMemo(() => labResults.filter(l => !isMonitoringOnlyLab(l)), [labResults]);
    const hasLabForMode = hormoneLabs.some(l => (isTransmasc ? isT_LabUnit(l.unit) : !isT_LabUnit(l.unit)));
    const showCalibrate = events.length > 0 && !hasLabForMode;

    const absurdLevel = isTransmasc ? currentT : currentLevel;
    const absurd = absurdLevel > 10000;
    const absurdNoticed = React.useRef(false);
    React.useEffect(() => {
        if (absurd && !absurdNoticed.current) {
            absurdNoticed.current = true;
            setIsAbsurdOpen(true);
        } else if (!absurd) {
            absurdNoticed.current = false;
        }
    }, [absurd]);

    const antiandrogen = React.useMemo(
        () => antiandrogenReading(events, nowMs / 3_600_000, aaChartMode),
        [events, nowMs, aaChartMode],
    );
    // The heading is the tile's own slot, not the drug's full name: half a tile
    // cannot hold "Cyproterone Acetate (CPA)" in English, and the value below it
    // is the reading anyway. `label.aa_short.*` is the abbreviated label.
    const aaHeading = antiandrogen.kind === 'none'
        ? t('label.cpa_chart')
        : t(`label.aa_short.${antiandrogen.kind === 'grams' ? 'CPA' : antiandrogen.ester}`);
    const mgDecimals = (v: number) => (Number.isInteger(v) ? 0 : Number.isInteger(v * 10) ? 1 : 2);
    const nowSec = nowMs / 1000;

    const [showOverdue, setShowOverdue] = React.useState(false);
    const planState = React.useMemo(() => {
        const plans = plansForMode(readMedPlans(), isTransmasc ? 'transmasc' : 'transfem');
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
    }, [events, nowMs, doseTemplates, t, isTransmasc]);

    const patches = React.useMemo(() => activePatches(events, nowMs / 3_600_000), [events, nowMs]);
    const removePatch = (patch: DoseEvent): void => {
        onAddEvent(patchRemovalEvent(patch, crypto.randomUUID(), nowMs / 3_600_000));
    };
    const elapsedPatch = (patch: DoseEvent): string => {
        const elapsedHours = Math.max(0, Math.floor(nowMs / 3_600_000 - patch.timeH));
        if (elapsedHours === 0) return t('time.just_now');
        return elapsedHours >= 24
            ? t('home.patch.elapsed_days').replace('{n}', String(Math.floor(elapsedHours / 24)))
            : t('home.patch.elapsed_hours').replace('{n}', String(elapsedHours));
    };

    const primaryDecimals = readingDecimals ? 1 : 0;

    const pricePair = isTransmasc
        ? { label: t('label.total_t'), value: currentT.toFixed(0), unit: 'ng/dl' }
        : { label: t('label.e2'), value: currentLevel.toFixed(primaryDecimals), unit: 'pg/ml' };

    const sinceParts = antiandrogen.kind === 'since'
        ? formatRelativeParts(nowSec - antiandrogen.sinceH * 3600, nowSec, t)
        : null;
    const aaPair = {
        label: aaHeading,
        value: antiandrogen.kind === 'grams' ? antiandrogen.grams.toFixed(2)
            : antiandrogen.kind === 'dose' ? antiandrogen.mgToday.toFixed(mgDecimals(antiandrogen.mgToday))
                : antiandrogen.kind === 'since' ? (sinceParts?.value ?? '')
                    : '--',
        unit: antiandrogen.kind === 'grams' ? 'g' : antiandrogen.kind === 'dose' ? 'mg'
            : antiandrogen.kind === 'since' ? (sinceParts?.unit ?? t('time.just_now'))
                : '',
    };

    const recent = React.useMemo(
        () => [...events].sort((a, b) => b.timeH - a.timeH).slice(0, 5),
        [events],
    );

    // Elapsed since the last recorded dose: hours below a day, whole days from
    // 24h up. The hidden-AA tile uses this, and so does the patch row's caption.
    const lastDoseHours = recent.length
        ? Math.max(0, Math.floor(nowMs / 3_600_000 - recent[0].timeH))
        : null;
    // Split the elapsed time into a big number and a small unit. The old tile
    // ran "12 小时前" as one 32px string, so the number could not dominate.
    const lastDoseValue = lastDoseHours === null
        ? '—'
        : lastDoseHours === 0
            ? t('time.just_now')
            : lastDoseHours >= 24
                ? String(Math.floor(lastDoseHours / 24))
                : String(lastDoseHours);
    const lastDoseUnit = lastDoseHours === null || lastDoseHours === 0
        ? ''
        : lastDoseHours >= 24
            ? t('home.last_dose.days').replace('{n}', '').trim()
            : t('home.last_dose.hours').replace('{n}', '').trim();

    // The status chip follows the clinical band, not one fixed colour: in-target
    // is green, follicular/luteal is amber, out-of-range is red.
    const statusTone = currentStatus?.tone ?? 'ok';
    const statusChipStyle = statusTone === 'ok'
        ? { background: 'var(--okc)', color: 'var(--ok)' }
        : statusTone === 'warn'
            ? { background: 'var(--warnc)', color: 'var(--warn)' }
            : statusTone === 'err'
                ? { background: 'var(--errc)', color: 'var(--err)' }
                : { background: 'var(--sch)', color: 'var(--var)' };

    const orderedTemplates = React.useMemo(
        () => [...doseTemplates, ...planState.entries].sort((a, b) => b.createdAt - a.createdAt),
        [doseTemplates, planState.entries],
    );

    const logTemplate = (template: DoseTemplate) => {
        const event = templateToEvent(template, crypto.randomUUID(), Date.now() / 3600000);
        onAddEvent(event);
        onQuickRecordClose();
        setUndo({ id: event.id, name: template.name });
    };

    const timeLabel = (timeH: number): string =>
        new Date(timeH * 3_600_000).toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    return (
        <div className="pg on long" id="p0">
            <EstimateInfoModal isOpen={isEstimateInfoOpen} onClose={() => setIsEstimateInfoOpen(false)} />
            <NoticeModal
                isOpen={isAbsurdOpen}
                onClose={() => setIsAbsurdOpen(false)}
                titleKey="modal.absurd.title"
                bodyKey="modal.absurd.body"
                icon={<span style={{ color: 'var(--warn)', display: 'inline-flex' }}><Icon icon={AlertTriangle} weight="Filled" size={28} /></span>}
            />
            <OverdueSheet statuses={planState.statuses} isOpen={showOverdue} onClose={() => setShowOverdue(false)} t={t} />

            <AdaptiveSheet open={quickRecordOpen} onClose={onQuickRecordClose} title={t('quickadd.button')}>
                {orderedTemplates.length === 0 ? (
                    <div
                        className="d-col"
                        style={{
                            minHeight: 220,
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            textAlign: 'center',
                        }}
                    >
                        <span className="ic" style={{ width: 48, height: 48, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--sch)', color: 'var(--var)' }}>
                            <Icon icon={Bookmark} size={22} />
                        </span>
                        <p className="sub" style={{ margin: 0, maxWidth: 280 }}>{t('quickadd.empty_hint')}</p>
                    </div>
                ) : (
                    <SegmentedList label={t('quickadd.button')}>
                        {orderedTemplates.map(template => {
                            const category = categoryForEster(modeOf(isTransmasc), template.ester);
                            const tone: LeadingTone = category === 'aa' || category === 'cycle'
                                ? 'amber'
                                : category === 'progest' || category === 'hair'
                                    ? 'secondary'
                                    : 'primary';
                            return (
                                <SegmentedListItem
                                    key={template.id}
                                    sprite={ROUTE_ICON_ID[template.route] ?? 'pill'}
                                    leadingTone={tone}
                                    title={template.name}
                                    subtitle={`${t(`route.${template.route}`)} · ${template.doseMG.toFixed(2)} mg`}
                                    onClick={() => logTemplate(template)}
                                />
                            );
                        })}
                    </SegmentedList>
                )}
            </AdaptiveSheet>

            <Snackbar
                open={undo !== null}
                message={t('quickadd.done').replace('{name}', undo?.name ?? '')}
                actionLabel={t('quickadd.undo')}
                onAction={() => {
                    if (undo) onRemoveEvent(undo.id);
                    setUndo(null);
                }}
                onClose={() => setUndo(null)}
            />

            <h1>{t('nav.home')}</h1>

            {planState.overdue && (
                <div
                    className="card tap anim-in"
                    onClick={() => setShowOverdue(true)}
                    role="button"
                    tabIndex={0}
                    style={{
                        background: 'var(--errc)',
                        color: 'var(--err)',
                        padding: '12px 18px',
                        borderRadius: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        cursor: 'pointer',
                        marginBottom: 10,
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ display: 'inline-flex', flex: 'none' }}>
                            <Icon icon={AlertTriangle} weight="Filled" size={20} />
                        </span>
                        <div>
                            <b style={{ display: 'block', fontSize: 14 }}>{t('plan.overdue_title')}</b>
                            <span style={{ fontSize: 12, opacity: 0.9 }}>
                                {t('plan.badge_hint')}
                            </span>
                        </div>
                    </div>
                    <span className="chip" style={{ background: 'rgba(255,255,255,0.18)', color: 'inherit', flex: 'none' }}>
                        {t('plan.overdue_view')}
                    </span>
                </div>
            )}

            {events.length === 0 ? (
                <div className="card">
                    <div className="empty" style={{ padding: '42px 0 34px' }}>
                        <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--on)' }}>{t('home.empty_title')}</p>
                        <p style={{ margin: '6px auto 18px', maxWidth: 280 }}>{t('home.empty_subtitle')}</p>
                        <button type="button" className="btn" onClick={onNavigateToHistory}>{t('home.empty_cta')}</button>
                    </div>
                </div>
            ) : (
                <div className="d-grid">
                    <div className="d-col">
                        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 10 }}>
                            <div
                                className="tile"
                                data-m
                                style={{ ['--mo' as string]: '46px 14px 46px 14px', background: 'var(--pric)', color: 'var(--onpric)', borderRadius: 28, minHeight: 136 }}
                            >
                                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                    <span className="l">{pricePair.label}</span>
                                    <button
                                        type="button"
                                        className="chip"
                                        style={{ background: 'rgba(255,255,255,.16)', color: 'inherit', padding: '5px 10px' }}
                                        aria-label={t('status.read_me')}
                                        onClick={() => setIsEstimateInfoOpen(true)}
                                    >
                                        <Icon icon={Info} size={13} />
                                    </button>
                                </span>
                                <div style={{ fontSize: 52, fontWeight: 800, letterSpacing: '-1.5px', lineHeight: 1, minWidth: 0 }}>
                                    <FitText minRatio={0.44}>
                                        <span>{pricePair.value}</span>
                                        <span style={{ fontSize: '.3em', fontWeight: 800, marginLeft: 4, letterSpacing: 0 }}>{pricePair.unit}</span>
                                    </FitText>
                                </div>
                                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                    {currentStatus ? (
                                        <span className="chip" style={statusChipStyle}>{t(currentStatus.label)}</span>
                                    ) : <span />}
                                    <button
                                        type="button"
                                        disabled={!events.length}
                                        aria-label={shareCopy.action}
                                        title={events.length ? shareCopy.modalDescription : shareCopy.noData}
                                        onClick={() => {
                                            if (!authToken) { onAuthRequired(); return; }
                                            onNavigateToShare();
                                        }}
                                        className="chip"
                                        style={{ background: 'rgba(255,255,255,.16)', color: 'inherit', padding: '5px 10px', opacity: events.length ? 1 : .45 }}
                                    >
                                        <Icon icon={Share2} size={13} />
                                    </button>
                                </span>
                            </div>

                            {/* The companion slot is the anti-androgen reading. It is a
                                tertiary leaf tile (`.tile.b`, `--terc`): the reading is a
                                category, not a feminizing level, and it must stay visible
                                even while a patch is being worn. Patches get their own
                                rows below instead of displacing it. */}
                            {!hideAA && antiandrogen.kind !== 'none' ? (
                                <div className="tile b" data-m style={{ ['--mo' as string]: '28px', minHeight: 136 }}>
                                    <span className="l">{aaPair.label}</span>
                                    <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1, letterSpacing: '-.5px', minWidth: 0 }}>
                                        <FitText minRatio={0.42}>
                                            <span>{aaPair.value || '--'}</span>
                                            {aaPair.unit ? (
                                                <span style={{ fontSize: '.34em', fontWeight: 800, marginLeft: 4, letterSpacing: 0 }}>{aaPair.unit}</span>
                                            ) : null}
                                        </FitText>
                                    </div>
                                </div>
                            ) : (
                                <div className="tile b" data-m style={{ ['--mo' as string]: '28px', minHeight: 136 }}>
                                    <span className="l">{t('home.last_dose.label')}</span>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                                        <span style={{ fontSize: 48, fontWeight: 800, lineHeight: .92, letterSpacing: '-1.5px', minWidth: 0 }}>
                                            <FitText minRatio={0.42}>{lastDoseValue}</FitText>
                                        </span>
                                        {lastDoseUnit ? (
                                            <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.1, opacity: .82, whiteSpace: 'nowrap' }}>
                                                {lastDoseUnit}
                                            </span>
                                        ) : null}
                                    </div>
                                    {/* The worn patch is the strip below, never a third line
                                        in this tile: "wearing … for 10 days" reflowed the
                                        label and the reading into a block that no longer fit
                                        half a tile, and the strip says it once already. */}
                                    <span />
                                </div>
                            )}
                        </div>

                        {/* A worn patch is a status strip, not another card. It sits
                            directly under the two hero tiles so it is read in the
                            same glance and survives both the E2 + AA layout and the
                            hidden-AA one. No `.list` wrapper: the banner is a line of
                            text with one action, not a destination. */}
                        {patches.length > 0 && (
                            <div className="patch-strip">
                                {patches.map(patch => (
                                    <div className="patch-line" key={patch.id}>
                                        <span className="ic am"><SpriteIcon id="patch" /></span>
                                        <div className="t">
                                            <b>{t(`ester.${patch.ester}`)}</b>
                                            <span className="s">{t('home.patch.wearing').replace('{drug}', t(`ester.${patch.ester}`))} {elapsedPatch(patch)}</span>
                                        </div>
                                        <button type="button" className="btn x" style={{ minWidth: 0, color: 'var(--pri)' }} onClick={() => removePatch(patch)}>
                                            <Icon icon={X} size={13} />{t('home.patch.remove_action')}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {(doseAdvisory || hormoneAdvisory || showCalibrate) && (
                            <div className="d-col" style={{ gap: 4 }}>
                                {doseAdvisory && (
                                    <p className="sub" style={{ margin: '0 6px', color: 'var(--warn)' }}>{t(`advisory.${doseAdvisory.kind}.body`)}</p>
                                )}
                                {hormoneAdvisory && (
                                    <p className="sub" style={{ margin: '0 6px', color: 'var(--warn)' }}>{t(`advisory.hormone_${hormoneAdvisory.kind}.body`)}</p>
                                )}
                                {showCalibrate && (
                                    <button type="button" className="btn x" style={{ alignSelf: 'flex-start', color: 'var(--var)' }} onClick={onNavigateToLab}>
                                        <Icon icon={Info} size={13} />{t('advisory.calibrate.cta')}
                                    </button>
                                )}
                            </div>
                        )}

                        <div className="card">
                            <ResultChart
                                sim={simulation}
                                events={chartEvents}
                                onPointClick={onEditEvent}
                                labResults={hormoneLabs}
                                calibrationFn={calibrationFn}
                                isDarkMode={isDarkMode}
                                chartStyle={chartStyle}
                                tall
                            />
                        </div>
                    </div>

                    <div className="d-col">
                        <div className="lab" style={{ marginTop: 2 }}>{t('orderbook.title')}</div>
                        <div className="list bigic">
                            {recent.map(event => {
                                const category = categoryForEster(modeOf(isTransmasc), event.ester);
                                const tone = category === 'aa' || category === 'cycle' ? 'am' : category === 'progest' || category === 'hair' ? 'sec' : 'p';
                                return (
                                    <button
                                        type="button"
                                        className="li"
                                        key={event.id}
                                        onClick={(e) => {
                                            // The shell-level dose editor is a
                                            // container transform too; without this
                                            // the Home edit opened with a plain fade
                                            // while the History row unfolded from the
                                            // row it was tapped on.
                                            rememberTransformSource(e.currentTarget);
                                            onEditEvent(event);
                                        }}
                                        style={{ width: '100%', border: 0, textAlign: 'left', font: 'inherit', color: 'var(--on)' }}
                                    >
                                        <span className={`ic ${tone}`}><SpriteIcon id={ROUTE_ICON_ID[event.route] ?? 'pill'} /></span>
                                        <div className="t">
                                            <b>{t(`ester.${event.ester}`)}</b>
                                            <span className="s">{t(`route.${event.route}`)} · {timeLabel(event.timeH)}</span>
                                        </div>
                                        <div className="r"><b>{event.doseMG.toFixed(2)} mg</b><br />{timeLabel(event.timeH)}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
/**
 * Today's missed doses, in the same adaptive sheet the rest of the app uses.
 *
 * It offers no logging of its own — the quick-record FAB is what clears a dose —
 * because a second write path from a status list would be a destructive-looking
 * shortcut with none of the undo the FAB's records carry.
 */
const OverdueSheet: React.FC<{
    statuses: PlanStatus[];
    isOpen: boolean;
    onClose: () => void;
    t: (key: string) => string;
}> = ({ statuses, isOpen, onClose, t }) => {
    const missed = statuses.filter(s => s.overdue);
    const timeOf = (ms: number) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    return (
        <AdaptiveSheet open={isOpen} onClose={onClose} title={t('plan.overdue_title')}>
            <div className="mb-4 flex justify-center" style={{ color: 'var(--warn)' }}>
                <Icon icon={TriangleWarning} weight="Filled" size={30} />
            </div>
            {missed.length === 0 ? (
                <p className="py-4 text-center text-sm muted">{t('plan.overdue_none')}</p>
            ) : (
                <SegmentedList>
                    {missed.map(s => (
                        <SegmentedListItem
                            key={s.plan.id}
                            icon={TriangleWarning}
                            leadingTone="amber"
                            title={s.plan.alias || t(`ester.${s.plan.ester}`)}
                            subtitle={`${t('plan.overdue_missed_at')}: ${s.missed.map(timeOf).join(' · ')}`}
                            trailing={s.plan.dose ? <span>{s.plan.dose}</span> : undefined}
                        />
                    ))}
                </SegmentedList>
            )}
        </AdaptiveSheet>
    );
};

export default Home;



