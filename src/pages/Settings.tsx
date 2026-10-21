import React, { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import Icon from '../components/Icon';
import Switch from '../components/Switch';
import {
    Activity,
    CalendarDays,
    Check,
    ChevronRight,
    Clock3,
    CodeFile,
    Coffee,
    Database,
    Dna,
    Download,
    Gauge,
    Globe,
    Info,
    LockKeyhole,
    Monitor,
    MonitorSmartphone,
    RefreshCw,
    Rewind,
    Settings2,
    Shield,
    ShieldCheck,
    TestTube2,
    Trash2,
    TriangleWarning,
    Upload,
} from '../icons';
import type { IconComponent } from '../icons';
import type { Lang } from '../i18n/types';
import { AppTheme, APP_VERSION } from '../constants';
import {
    AntiandrogenChartMode,
    ANTIANDROGEN_CHART_MODES,
    DoseEvent,
    PKCustomParams,
    RecheckIntervals,
    OcrModelTier,
    PkEngineId,
    PK_ENGINES,
    CalibrationMethod,
    CalibrationHistoryMode,
    CalibrationResult,
    CALIBRATION_METHODS,
    CALIBRATION_HISTORY_MODES,
    getRecheckReminders,
    visibleRecheckReminders,
    recheckDueKey,
} from '../../logic';
import { useHRTMode } from '../contexts/HRTModeContext';
import { isNativeApp } from '../utils/platform';
import { openExternalUrl } from '../utils/externalLinks';
import MedPlanSettings from '../components/MedPlanSettings';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import { EngineGlyph } from '../components/compoundIcons';
import { CalibrationAnimation } from '../components/CalibrationAnimation';
import type { DoseTemplate } from '../components/DoseForm';
import { useBackHandler } from '../utils/nativeBack';
import { checkNativeUpdate, fetchLatestApkUrl, SELF_UPDATE_ENABLED } from '../utils/nativeUpdate';
import { openUpdateSheet } from '../utils/updateSheet';
import {
    confirmLockDisabled,
    disableLock,
    enableLock,
    isAppLockEnabled,
    isBackgroundLock,
    lockAvailable,
    lockStatus,
    onEnrollmentReturn,
    openBiometricEnrollment,
    setAppLockFlag,
    setBackgroundLock,
    type LockStatus,
} from '../utils/appLock';
import { readDataKeyBase64, removeDataKeyBase64, writeDataKeyBase64 } from '../utils/secureStore';
import {
    AdaptiveSheet,
    ConnectedButtonGroup,
    HeaderBack,
    SegmentedList,
    SegmentedListItem,
    useMediaQuery,
} from '../ui/proto';

interface SettingsProps {
    t: (key: string) => string;
    lang: Lang;
    setLang: (lang: Lang) => void;
    theme: AppTheme;
    setTheme: (theme: AppTheme) => void;
    /** Saved dose templates, so a plan can import a drug from one. */
    doseTemplates: DoseTemplate[];
    languageOptions: { value: Lang; label: string }[];
    onImportJson: (text: string) => boolean | Promise<boolean>;
    labResults: any[];
    onExport: (encrypt: boolean, password?: string) => Promise<string | null>;
    onQuickExport: () => void;
    onClearAllEvents: () => void;
    events: DoseEvent[];
    showDialog: (type: 'alert' | 'confirm', message: string, onConfirm?: () => void) => void;
    setIsDisclaimerOpen: (isOpen: boolean) => void;
    onShowIntro: () => void;
    /** Opens the open-source licence notice. */
    onOpenLicences?: () => void;
    /** Opens the tip jar (Buy Me a Coffee + crypto addresses). */
    onOpenDonate?: () => void;
    weight: number;
    setIsWeightModalOpen: (isOpen: boolean) => void;
    pkParams: PKCustomParams | null;
    onNavigateToPKParams: () => void;
    onNavigateToLanguage: () => void;
    onNavigateToAppearance: () => void;
    onNavigateToWeight: () => void;
    onNavigateToExport: () => void;
    onNavigateToImport: () => void;
    autoSync: boolean;
    setAutoSync: (v: boolean) => void;
    /** Whether anyone is signed in — the auto-sync toggle only means something then. */
    isLoggedIn: boolean;
    /** Which reading the Home card's anti-androgen column shows. */
    aaChartMode: AntiandrogenChartMode;
    setAaChartMode: (m: AntiandrogenChartMode) => void;
    /** Whether the overview hides the anti-androgen column entirely. */
    hideAA: boolean;
    setHideAA: (v: boolean) => void;
    /** The user's re-check intervals — each individually adjustable. */
    recheckIntervals: RecheckIntervals;
    setRecheckIntervals: (v: RecheckIntervals) => void;
    /** Due-date keys already dismissed on this device. */
    dismissedRechecks: Record<string, string>;
    /** Close the reminder for this due date. */
    onDismissRecheck: (kind: string, due: string) => void;
    /** Which OCR model tier the lab scan uses. */
    ocrModelTier: OcrModelTier;
    setOcrModelTier: (tier: OcrModelTier) => void;
    /** Which pharmacokinetic engine computes the curve. */
    pkEngine: PkEngineId;
    setPkEngine: (id: PkEngineId) => void;
    /** The engine actually in force — the Transmtf one cannot take PK overrides. */
    engineInUse: PkEngineId;
    /** Which estimator personalises the curve, and how it is applied to history. */
    calibrationMethod: CalibrationMethod;
    setCalibrationMethod: (m: CalibrationMethod) => void;
    calibrationHistoryMode: CalibrationHistoryMode;
    setCalibrationHistoryMode: (m: CalibrationHistoryMode) => void;
    /** The current fit, shown beside the choices as the live result. */
    calibration: CalibrationResult;
}

type SettingsCat = 'general' | 'algo' | 'plans' | 'reminders' | 'data' | 'about';
type MobileView = 'list' | SettingsCat;
/** The three choices that drill one level further inside the detail pane. */
type SubPanel = 'aa' | 'pk' | 'calib';

/** The master-detail breakpoint, the same one the M3E pages use for desktop. */
const DESKTOP_QUERY = '(min-width: 760px)';

/** Days → hours for the reminder ordering below (30.44 d/month, as logic.ts uses). */
const HOURS_PER_RECHECK_MONTH = 30.44 * 24;

let _savedCat: SettingsCat = 'general';
let _savedMobileView: MobileView = 'list';

/**
 * Settings, as an M3 Expressive master–detail page. AGENTS.md §2.4.
 *
 * Desktop is a 330px / 1fr split: the five categories are a persistent
 * SegmentedList with one detached, `--pric`-filled row, and the chosen category
 * is a 32px detail surface whose title is a heading rather than a back control.
 * Below 1024px only the hub exists; choosing a category swaps the hub for that
 * surface full-width, and the arrow comes back because that is the only way out.
 *
 * The two choices that used to expand inline (the anti-androgen readout and the
 * PK engine) are third-level panels inside the detail pane: their rows keep the
 * chosen value as a subtitle, and the panel keeps the HeaderBack arrow at every
 * width. Everything else is a real route and keeps its `onNavigateTo*` callback.
 */
const Settings: React.FC<SettingsProps> = ({
    t, lang, theme, languageOptions, onClearAllEvents, events,
    showDialog, setIsDisclaimerOpen, onShowIntro,
    onOpenLicences,
    onOpenDonate,
    weight, pkParams, onNavigateToPKParams,
    onNavigateToLanguage, onNavigateToAppearance, onNavigateToWeight,
    onNavigateToExport, onNavigateToImport, autoSync, setAutoSync, isLoggedIn,
    aaChartMode, setAaChartMode,
    hideAA, setHideAA,
    recheckIntervals, setRecheckIntervals,
    dismissedRechecks, onDismissRecheck,
    pkEngine, setPkEngine, engineInUse,
    calibrationMethod, setCalibrationMethod,
    calibrationHistoryMode, setCalibrationHistoryMode,
    calibration,
    doseTemplates, labResults,
}) => {
    const { mode, setMode } = useHRTMode();
    // Anti-androgens are a transfem concept: masculinising regimens use them never,
    // so both the entry row and the pane behind it are gated on the same value. The
    // pane needs its own gate — `sub` survives a mode switch, so opening the panel
    // and then flipping to masculinising used to leave it reachable.
    const aaAvailable = mode === 'transfem';
    // Bumped on every method change so the preview replays its morph instead of
    // sitting on the previous curve.
    const [calibrationReplay, setCalibrationReplay] = React.useState(0);
    const isDesktop = useMediaQuery(DESKTOP_QUERY);
    const [cat, setCat] = useState<SettingsCat>(_savedCat);
    const [mobileView, setMobileView] = useState<MobileView>(_savedMobileView);
    const [sub, setSub] = useState<SubPanel | null>(null);

    // ── App lock (Android only) ──────────────────────────────────────────────
    // `lockPresent` is false on web and on any build without the native bridge;
    // the rows simply do not exist there, which is also what keeps the Web/PWA
    // path untouched (app lock plan §12.9).
    const lockPresent = lockAvailable();
    const [lockOn, setLockOn] = useState(() => lockPresent && isAppLockEnabled());
    const [bgLock, setBgLock] = useState(() => lockPresent && isBackgroundLock());
    const [lockBusy, setLockBusy] = useState(false);
    const [lockNotice, setLockNotice] = useState<LockStatus | null>(null);

    const toggleAppLock = (next: boolean) => {
        if (next) void enableAppLock();
        else void disableAppLock();
    };

    const enableAppLock = async (status: LockStatus = lockStatus()) => {
        if (!lockPresent) return;
        if (status !== 'ok') {
            setLockNotice(status);
            return;
        }
        const key = await readDataKeyBase64();
        if (!key) {
            showDialog('alert', t('settings.app_lock.enable_failed'));
            return;
        }
        setLockBusy(true);
        const result = await enableLock(key, t('settings.app_lock.title'), t('btn.cancel'));
        setLockBusy(false);
        if (!result.ok) {
            if (result.error !== 'cancelled') showDialog('alert', t('settings.app_lock.enable_failed'));
            return;
        }
        setAppLockFlag(true);
        try {
            await removeDataKeyBase64();
        } catch {
            // The flag is already set; initSecureStoreWithKey retries this on the
            // next unlocked start. Nothing user-visible depends on it now.
        }
        setLockOn(true);
    };

    const disableAppLock = async () => {
        setLockBusy(true);
        const result = await disableLock(t('settings.app_lock.title'), t('btn.cancel'));
        setLockBusy(false);
        if (!result.ok || !result.key) {
            if (result.error !== 'cancelled') showDialog('alert', t('settings.app_lock.enable_failed'));
            return;
        }
        // Restore the plugin entry before dropping the envelope: if this write
        // fails, the lock must stay on rather than leaving the key nowhere.
        try {
            await writeDataKeyBase64(result.key);
        } catch {
            showDialog('alert', t('settings.app_lock.enable_failed'));
            return;
        }
        confirmLockDisabled();
        setAppLockFlag(false);
        setLockOn(false);
    };

    /** Coming back from the system enrolment screen continues the toggle. */
    useEffect(() => {
        if (!lockNotice) return undefined;
        return onEnrollmentReturn(status => {
            if (status === 'ok') {
                setLockNotice(null);
                void enableAppLock('ok');
            } else {
                showDialog('alert', t('settings.app_lock.still_missing'));
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lockNotice]);

    const lockNoticeDesc = (status: LockStatus): string => {
        switch (status) {
            case 'not_enrolled': return t('settings.app_lock.unavailable.not_enrolled');
            case 'weak_only': return t('settings.app_lock.unavailable.weak_only');
            case 'no_hardware': return t('settings.app_lock.unavailable.no_hardware');
            case 'hw_unavailable': return t('settings.app_lock.unavailable.hw_busy');
            default: return t('settings.app_lock.unavailable.not_enrolled');
        }
    };
    const canEnroll = lockNotice === 'not_enrolled' || lockNotice === 'weak_only';

    /**
     * Settings swaps whole panes in place. View Transitions give the outgoing
     * category/hub a real exit instead of letting React replace it on one frame;
     * reduced motion falls straight through.
     */
    const morphTo = (update: () => void) => {
        const go = () => flushSync(update);
        const transition = (document as Document & {
            startViewTransition?: (cb: () => void) => unknown;
        }).startViewTransition;
        // Desktop uses in-place master-detail panes; whole-page view transitions
        // cause full-screen shudder and are reserved for mobile full-screen drill-in.
        if (!isDesktop && transition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            transition.call(document, go);
        } else {
            go();
        }
    };

    const selectCat = (c: SettingsCat) => {
        _savedCat = c;
        morphTo(() => {
            setCat(c);
            setSub(null);
        });
    };

    const enterMobileCat = (c: SettingsCat) => {
        _savedCat = c;
        _savedMobileView = c;
        morphTo(() => {
            setCat(c);
            setMobileView(c);
            setSub(null);
        });
    };

    const exitMobileCat = () => {
        _savedMobileView = 'list';
        morphTo(() => {
            setMobileView('list');
            setSub(null);
        });
    };

    const openSub = (next: SubPanel) => morphTo(() => setSub(next));
    const closeSub = () => morphTo(() => setSub(null));

    // On mobile the category screen is an internal state below the `settings`
    // view, so system back must exit it before the view-level handler pops to
    // home. An open third-level panel is the topmost one and closes first.
    useBackHandler(mobileView !== 'list' || sub !== null, () => {
        if (sub !== null) {
            closeSub();
            return true;
        }
        exitMobileCat();
        return true;
    });

    const navTo = (fn: () => void, forCat: SettingsCat) => {
        _savedCat = forCat;
        _savedMobileView = forCat;
        fn();
    };

    const cats: { id: SettingsCat; label: string; icon: IconComponent; hint: string }[] = [
        { id: 'general', label: t('settings.group.general'), icon: Settings2, hint: [t('settings.app_lock.title'), t('drawer.lang'), t('settings.theme')].join(' · ') },
        { id: 'algo', label: t('settings.group.algorithm'), icon: Gauge, hint: [t('cal.settings'), t('settings.pk_engine')].join(' · ') },
        { id: 'plans', label: t('plan.title'), icon: Clock3, hint: t('plan.hint') },
        { id: 'reminders', label: t('settings.group.reminders'), icon: CalendarDays, hint: [t('settings.reminders.liver'), t('settings.reminders.estradiol')].join(' · ') },
        { id: 'data', label: t('settings.group.data'), icon: Database, hint: [t('export.title'), t('import.title')].join(' · ') },
        { id: 'about', label: t('settings.group.about'), icon: Info, hint: [t('drawer.algorithm_credits'), t('licence.title')].join(' · ') },
    ];

    const chevron = <Icon icon={ChevronRight} size={18} />;

    // ── General ───────────────────────────────────────────────────────────────
    const aaLabel = hideAA ? t('settings.aa_display.none') : t(`settings.aa_display.${aaChartMode}`);

    const renderGeneral = (): React.ReactNode => (
        <>
        <SegmentedList label={t('settings.group.general')}>
            <SegmentedListItem
                icon={Globe}
                title={t('drawer.lang')}
                subtitle={languageOptions.find(o => o.value === lang)?.label ?? lang}
                trailing={chevron}
                onClick={() => navTo(onNavigateToLanguage, 'general')}
            />
            <SegmentedListItem
                icon={Monitor}
                title={t('settings.theme')}
                subtitle={t(`theme.${theme}`)}
                trailing={chevron}
                onClick={() => navTo(onNavigateToAppearance, 'general')}
            />
            <SegmentedListItem
                icon={Activity}
                title={t('status.weight')}
                subtitle={`${weight} kg`}
                trailing={chevron}
                onClick={() => navTo(onNavigateToWeight, 'general')}
            />

            {isLoggedIn && (
                /* A switch is its own control, so this row is not a button: nesting
                   the switch inside one would leave two overlapping activation
                   targets and an invalid button-in-button tree. */
                <div className="li" style={{ cursor: 'default' }}>
                    <span className="ic"><Icon icon={RefreshCw} size={22} /></span>
                    <div className="t">
                        <b>{t('settings.auto_sync')}</b>
                        <span className="s" style={{ whiteSpace: 'normal' }}>{t('settings.auto_sync_desc')}</span>
                    </div>
                    <Switch checked={autoSync} onChange={setAutoSync} label={t('settings.auto_sync')} />
                </div>
            )}

            {lockPresent && (
                <>
                    <div className="li" style={{ cursor: 'default' }}>
                        <span className="ic"><Icon icon={LockKeyhole} size={22} /></span>
                        <div className="t">
                            <b>{t('settings.app_lock.title')}</b>
                            <span className="s" style={{ whiteSpace: 'normal' }}>{t('settings.app_lock.desc')}</span>
                        </div>
                        <Switch
                            checked={lockOn}
                            onChange={toggleAppLock}
                            disabled={lockBusy}
                            label={t('settings.app_lock.title')}
                        />
                    </div>
                    {lockOn && (
                        <div className="li" style={{ cursor: 'default' }}>
                            <span className="ic"><Icon icon={Clock3} size={22} /></span>
                            <div className="t">
                                <b>{t('settings.app_lock.relock_title')}</b>
                                <span className="s" style={{ whiteSpace: 'normal' }}>{t('settings.app_lock.relock_desc')}</span>
                            </div>
                            <Switch
                                checked={bgLock}
                                onChange={value => {
                                    setBackgroundLock(value);
                                    setBgLock(value);
                                }}
                                label={t('settings.app_lock.relock_title')}
                            />
                        </div>
                    )}
                </>
            )}
        </SegmentedList>

        <AdaptiveSheet
            open={lockNotice !== null}
            onClose={() => setLockNotice(null)}
            title={t('settings.app_lock.enroll_required_title')}
            closeLabel={t('btn.cancel')}
        >
            {lockNotice ? (
                <>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--color-m3-on-surface-variant)' }}>
                        {lockNoticeDesc(lockNotice)}
                    </p>
                    {canEnroll ? (
                        <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--color-m3-on-surface-variant)' }}>
                            {t('settings.app_lock.enroll_required_desc')}
                        </p>
                    ) : null}
                    {canEnroll ? (
                        <button
                            type="button"
                            className="btn mt-5 w-full"
                            onClick={() => {
                                openBiometricEnrollment();
                                setLockNotice(null);
                            }}
                        >
                            {t('settings.app_lock.enroll_cta')}
                        </button>
                    ) : null}
                </>
            ) : null}
        </AdaptiveSheet>
        {aaAvailable && (
            <>
                <div className="lab">{t('settings.group.display')}</div>
                <SegmentedList label={t('settings.group.display')}>
                    <SegmentedListItem
                        icon={Shield}
                        title={t('settings.aa_display')}
                        subtitle={aaLabel}
                        trailing={chevron}
                        onClick={() => openSub('aa')}
                    />
                </SegmentedList>
            </>
        )}
        </>
    );

    // ── Algorithm ─────────────────────────────────────────────────────────────
    // Two second-level entries, each drilling into a third level. They used to
    // live inside General, which both buried them and duplicated the calibration
    // controls that the checkup page also exposed.
    const renderAlgo = (): React.ReactNode => (
        <SegmentedList label={t('settings.group.algorithm')}>
            {/* Calibration is a model setting, not a transfem-only one. Hiding it in
                masculinising mode stranded anyone who switched modes with no way
                back to the estimator. */}
            <SegmentedListItem
                icon={Gauge}
                title={t('cal.settings')}
                subtitle={`${t(`cal.${calibrationMethod}`)} · ${t(`cal.${calibrationHistoryMode}`)}`}
                trailing={
                    <>
                        {calibration.n > 0 ? <span className="chip soft">{calibration.n} {t('cal.labs')}</span> : null}
                        {chevron}
                    </>
                }
                onClick={() => openSub('calib')}
            />
            {mode === 'transfem' && (
                <SegmentedListItem
                    icon={Dna}
                    title={t('settings.pk_engine')}
                    subtitle={t(`settings.pk_engine.${pkEngine}`)}
                    trailing={chevron}
                    onClick={() => openSub('pk')}
                />
            )}
            <SegmentedListItem
                icon={Gauge}
                title={t('settings.pk_params')}
                subtitle={engineInUse === 'transmtf' ? t('pk.unsupported.short') : undefined}
                trailing={
                    <>
                        {pkParams && engineInUse !== 'transmtf' && (
                            <span className="chip warn">{t('pk.customized')}</span>
                        )}
                        {chevron}
                    </>
                }
                onClick={() => navTo(onNavigateToPKParams, 'algo')}
            />
        </SegmentedList>
    );

    // ── Third level: anti-androgen readout ────────────────────────────────────
    const aaOptions: { value: AntiandrogenChartMode | 'none'; label: string }[] = [
        ...ANTIANDROGEN_CHART_MODES.map(m => ({ value: m, label: t(`settings.aa_display.${m}`) })),
        // Hiding is its own choice, not a fifth reading: it leaves the remembered
        // mode alone, so turning it back on restores whichever reading was shown.
        { value: 'none', label: t('settings.aa_display.none') },
    ];

    const renderAaPanel = (): React.ReactNode => (
        <div className="flex flex-col gap-4">
            <p className="muted text-sm leading-relaxed">{t('settings.aa_display_desc')}</p>
            <ConnectedButtonGroup
                options={aaOptions}
                value={hideAA ? 'none' : aaChartMode}
                onChange={(value) => {
                    if (value === 'none') {
                        setHideAA(true);
                        return;
                    }
                    setHideAA(false);
                    setAaChartMode(value);
                }}
                label={t('settings.aa_display')}
                className="wrap"
            />
        </div>
    );

    // ── Third level: PK engine ────────────────────────────────────────────────
    const renderPkPanel = (): React.ReactNode => (
        <div className="flex flex-col gap-4">
            <p className="muted text-sm leading-relaxed">{t('settings.pk_engine_desc')}</p>
            <SegmentedList label={t('settings.pk_engine')}>
                {PK_ENGINES.map(id => {
                    const active = pkEngine === id;
                    // The glyph table is keyed by the engine's model name (mihari),
                    // while the setting stores uiltin; the alias is what keeps the
                    // original model's icon from disappearing.
                    const glyph = EngineGlyph[id === 'builtin' ? 'mihari' : id];
                    const bullets = ['b1', 'b2', 'b3'] as const;
                    return (
                        <SegmentedListItem
                            key={id}
                            icon={glyph}
                            leadingTone={active ? 'primary' : 'default'}
                            aria-pressed={active}
                            title={t(`settings.pk_engine.${id}`)}
                            /* The note and its three bullets are part of the
                               choice: "Original" and "Transmtf" describe nothing
                               on their own, so the row grows instead of clipping. */
                            subtitle={
                                <span className="flex flex-col gap-1.5 pt-1" style={{ whiteSpace: 'normal' }}>
                                    <span>{t(`settings.pk_engine.${id}_note`)}</span>
                                    {bullets.map((b, i) => (
                                        <span key={b} className="flex gap-2 text-xs leading-relaxed">
                                            <span className="w-3 shrink-0" style={{ color: 'var(--pri)' }}>{i === 2 ? '—' : '✓'}</span>
                                            <span>{t(`settings.pk_engine.${id}.${b}`)}</span>
                                        </span>
                                    ))}
                                </span>
                            }
                            trailing={active ? (
                                <span style={{ display: 'inline-flex', color: 'var(--pri)' }}>
                                    <Icon icon={Check} size={20} />
                                </span>
                            ) : undefined}
                            onClick={() => setPkEngine(id)}
                        />
                    );
                })}
            </SegmentedList>
        </div>
    );

    // ── Third level: calibration ──────────────────────────────────────────────
    // The preview is the point of this panel: changing the estimator or the
    // history window re-draws the fitted curve above the choices, so the
    // difference between EKF and OU-Kalman is seen rather than read.
    const renderCalibPanel = (): React.ReactNode => (
        <div className="flex flex-col gap-4">
            <p className="muted text-sm leading-relaxed">{t(`cal.desc.${calibrationMethod}`)}</p>

            {/* The animation is per-algorithm, and "关闭" has nothing to draw: no
                estimator means no fitted curve, so the card is not rendered at all.
                The key carries the history mode too, so flipping 前向/回顾 replays
                the sweep instead of silently leaving the old picture up. */}
            {calibrationMethod !== 'off' && (
                <CalibrationAnimation
                    key={`${calibrationReplay}:${calibrationHistoryMode}`}
                    method={calibrationMethod}
                    history={calibrationHistoryMode}
                />
            )}

            <ConnectedButtonGroup
                options={CALIBRATION_METHODS.map(m => ({ value: m, label: t(`cal.${m}`) }))}
                value={calibrationMethod}
                onChange={(next) => {
                    setCalibrationMethod(next);
                    setCalibrationReplay(n => n + 1);
                }}
                label={t('cal.method')}
            />

            <div className="flex flex-col gap-2">
                <p className="section-title">{t('cal.history')}</p>
                <ConnectedButtonGroup
                    options={CALIBRATION_HISTORY_MODES.map(m => ({ value: m, label: t(`cal.${m}`) }))}
                    value={calibrationHistoryMode}
                    onChange={(next) => {
                        setCalibrationHistoryMode(next);
                        setCalibrationReplay(n => n + 1);
                    }}
                    label={t('cal.history')}
                />
                <p className="text-xs muted leading-relaxed">{t(`cal.desc.${calibrationHistoryMode}`)}</p>
            </div>

            <div className="card flex flex-wrap items-center gap-3">
                <span className="stat-label">{t('cal.current')}</span>
                <span className="font-semibold">{t(`cal.${calibrationMethod}`)}</span>
                <span className="chip soft">{t('cal.labs')} {calibration.n}</span>
                <span className="chip soft">{t('cal.fit')} {calibration.fitErrPct === null ? '—' : `±${calibration.fitErrPct.toFixed(0)}%`}</span>
                <span className="chip soft">{t('cal.halflife')} ×{calibration.scale.toFixed(2)}</span>
                {calibration.kMul !== 1 && (
                    <span className="chip warn">{calibration.kMul.toFixed(2)}×</span>
                )}
            </div>

            {/* `关闭` is already one of the four methods above, so the wide danger
                button that repeated it has gone. */}
        </div>
    );

    // ── Plans ─────────────────────────────────────────────────────────────────
    // HRT mode sits above the plan: which mode the app is in is what the plan is
    // a plan *for*, so the choice belongs with the schedule.
    const renderPlans = (): React.ReactNode => (
        <div>
            <div className="mb-6">
                <p className="section-title">{t('settings.hrt_mode')}</p>
                <p className="muted mt-1 text-xs leading-relaxed">{t('settings.hrt_mode_hint')}</p>
                <div className="mt-3">
                    <ConnectedButtonGroup
                        options={[
                            { value: 'transfem' as const, label: t('mode.transfem') },
                            { value: 'transmasc' as const, label: t('mode.transmasc') },
                        ]}
                        value={mode}
                        onChange={setMode}
                        label={t('settings.hrt_mode')}
                    />
                </div>
            </div>
            <MedPlanSettings muted="muted" on="text-m3e-on" doseTemplates={doseTemplates} />
        </div>
    );

    // ── Reminders ─────────────────────────────────────────────────────────────
    /** One interval as a label plus a bounded numeric pill. */
    const intervalRow = (label: string, value: number, onChange: (n: number) => void) => (
        <label className="li" style={{ cursor: 'default' }}>
            <div className="t">
                <b>{label}</b>
            </div>
            <input
                type="number"
                min={1}
                max={120}
                inputMode="numeric"
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="num-pill"
            />
        </label>
    );

    const intervalGroup = (title: string, rows: React.ReactNode): React.ReactNode => (
        <div className="flex flex-col gap-2">
            <p className="section-title px-1">{title}</p>
            <SegmentedList>{rows}</SegmentedList>
        </div>
    );

    const recheckKindLabel = (kind: string): string =>
        kind === 'potassium_spiro'
            ? t('settings.reminders.potassium')
            : kind === 'estradiol'
                ? t('settings.reminders.estradiol')
                : t('settings.reminders.liver');

    const renderReminders = (): React.ReactNode => {
        const isFtm = mode === 'transmasc';
        // The app's own schedule, which is also what the Lab page reminds from.
        // getRecheckReminders returns the boundaries already reached, so the
        // earliest one is the re-check to act on next. Masculinising therapy has
        // no estradiol/spironolactone schedule; showing those controls would be
        // advice for drugs the person is not taking.
        const due = visibleRecheckReminders(
            getRecheckReminders(events, Date.now() / 3_600_000, recheckIntervals, labResults),
            dismissedRechecks,
        ).filter(reminder => !isFtm || (reminder.kind !== 'estradiol' && reminder.kind !== 'potassium_spiro'));
        const next = [...due].sort(
            (a, b) => (a.startH + a.intervalMonths * HOURS_PER_RECHECK_MONTH)
                - (b.startH + b.intervalMonths * HOURS_PER_RECHECK_MONTH),
        )[0];
        const anchorDate = next
            ? new Date(next.startH * 3_600_000).toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' })
            : '';

        return (
            <div className="flex flex-col gap-6">
                {/* Leaf tile: the one suggestion on this page that is a state, not
                    a control, so it keeps the press shape without a click target. */}
                {/* The tile is a *state* — the next re-check that is due. With
                    nothing due there is no state to draw, so it is omitted rather
                    than filled with the help text the paragraph below already says. */}
                {next ? (
                <div className="tile b" style={{ cursor: 'default', minHeight: 104, position: 'relative' }}>
                    <button
                        type="button"
                        className="icon-del"
                        onClick={() => onDismissRecheck(next.kind, recheckDueKey(next))}
                        aria-label={t('monitor.recheck.dismiss')}
                        style={{ position: 'absolute', top: 8, right: 8, color: 'inherit' }}
                    >
                        <SpriteIcon id="x" />
                    </button>
                    <span className="l">{t('settings.group.reminders')}</span>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{recheckKindLabel(next.kind)}</span>
                    <span className="l" style={{ whiteSpace: 'normal', lineHeight: 1.5 }}>
                        {t(next.basis === 'last_check' ? 'monitor.recheck.basis_check' : 'monitor.recheck.basis')
                            .replace('{drug}', t(`ester.${next.ester}`))
                            .replace('{date}', anchorDate)}
                    </span>
                    <span className="chip" style={{ alignSelf: 'flex-start', background: 'rgba(255,255,255,.16)', color: 'inherit' }}>
                        {t('monitor.recheck.title')}
                    </span>
                </div>
                ) : null}

                <p className="muted px-1 text-xs leading-relaxed">{t('settings.reminders.desc')}</p>

                {isFtm && (
                    <div className="card" style={{ background: 'var(--terc)', color: 'var(--onterc)' }}>
                        <b style={{ fontSize: 15 }}>{t('settings.reminders.ftm_title')}</b>
                        <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.55 }}>{t('settings.reminders.ftm_desc')}</p>
                    </div>
                )}

                {intervalGroup(t(isFtm ? 'settings.reminders.liver_ftm' : 'settings.reminders.liver'), (
                    <>
                        {intervalRow(t('settings.reminders.phase'), recheckIntervals.liverFirstPhaseMonths, v => setRecheckIntervals({ ...recheckIntervals, liverFirstPhaseMonths: v }))}
                        {intervalRow(t('settings.reminders.early'), recheckIntervals.liverEarlyMonths, v => setRecheckIntervals({ ...recheckIntervals, liverEarlyMonths: v }))}
                        {intervalRow(t('settings.reminders.after'), recheckIntervals.liverMonths, v => setRecheckIntervals({ ...recheckIntervals, liverMonths: v }))}
                    </>
                ))}
                {!isFtm && intervalGroup(t('settings.reminders.potassium'), (
                    <>
                        {intervalRow(t('settings.reminders.phase'), recheckIntervals.potassiumFirstPhaseMonths, v => setRecheckIntervals({ ...recheckIntervals, potassiumFirstPhaseMonths: v }))}
                        {intervalRow(t('settings.reminders.early'), recheckIntervals.potassiumEarlyMonths, v => setRecheckIntervals({ ...recheckIntervals, potassiumEarlyMonths: v }))}
                        {intervalRow(t('settings.reminders.after'), recheckIntervals.potassiumMonths, v => setRecheckIntervals({ ...recheckIntervals, potassiumMonths: v }))}
                    </>
                ))}
                {!isFtm && intervalGroup(t('settings.reminders.estradiol'), (
                    intervalRow(t('settings.reminders.interval'), recheckIntervals.estradiolMonths, v => setRecheckIntervals({ ...recheckIntervals, estradiolMonths: v }))
                ))}
            </div>
        );
    };

    // ── Data ──────────────────────────────────────────────────────────────────
    const renderData = (): React.ReactNode => (
        <div className="flex flex-col gap-6">
            <SegmentedList label={t('settings.group.data')}>
                <SegmentedListItem
                    icon={Download}
                    title={t('export.title')}
                    trailing={chevron}
                    onClick={() => navTo(onNavigateToExport, 'data')}
                />
                <SegmentedListItem
                    icon={Upload}
                    title={t('import.title')}
                    trailing={chevron}
                    onClick={() => navTo(onNavigateToImport, 'data')}
                />
            </SegmentedList>

            {/* onClearAllEvents already asks for confirmation — the button must
                not add a second dialog, and it stays disabled with nothing to clear. */}
            <button
                type="button"
                onClick={onClearAllEvents}
                disabled={!events.length}
                className="btn danger-wide"
                style={{ opacity: events.length ? 1 : .45 }}
            >
                <Icon icon={Trash2} size={20} />
                {t('drawer.clear')}
            </button>
        </div>
    );

    // ── About ─────────────────────────────────────────────────────────────────
    const renderAbout = (): React.ReactNode => (
        <SegmentedList label={t('settings.group.about')}>
            <div className="li" style={{ cursor: 'default' }}>
                <div className="t">
                    <b>{t('settings.version')}</b>
                </div>
                <span className="r tabular-nums">{APP_VERSION.replace(/^v/, '')}</span>
            </div>

            {onOpenDonate && (
                <SegmentedListItem
                    icon={Coffee}
                    title={t('settings.donate')}
                    subtitle={t('settings.donate_desc')}
                    trailing={chevron}
                    onClick={onOpenDonate}
                />
            )}

            {/* The update item is the Android self-updater's entry point. A channel
                that does not self-update (F-Droid) has no business offering it —
                the store owns that job, and a hidden entry point would still be one. */}
            {isNativeApp() && SELF_UPDATE_ENABLED && (
                <SegmentedListItem
                    icon={RefreshCw}
                    title={t('settings.check_updates.title')}
                    subtitle={t('settings.check_updates.version').replace('{version}', APP_VERSION.replace(/^v/, ''))}
                    trailing={chevron}
                    onClick={() => {
                        void checkNativeUpdate().then(update => {
                            if (!update) {
                                showDialog('alert', `${t('settings.check_updates.latest')} (${APP_VERSION.replace(/^v/, '')})`);
                                return;
                            }
                            // The same M3E sheet the background notice opens. Answering with
                            // a text dialog would start a download whose progress is drawn
                            // somewhere else — which is exactly what this used to do, and
                            // why "确定" looked like it did nothing.
                            openUpdateSheet(update);
                        }).catch(() => showDialog('alert', t('settings.check_updates.error')));
                    }}
                />
            )}

            {/* The Android app, for a web visitor: a direct link to the signed APK.
                Not shown inside the native app (which updates itself), so the two
                are mutually exclusive. The URL comes from the update manifest. */}
            {!isNativeApp() && (
                <SegmentedListItem
                    icon={MonitorSmartphone}
                    title={t('settings.download_android')}
                    subtitle={t('settings.download_android_desc')}
                    trailing={chevron}
                    onClick={async () => void openExternalUrl(await fetchLatestApkUrl())}
                />
            )}

            {/* Algorithm attribution. Required by the upstream project's README,
                and it is the honest thing regardless: the model is not our work. */}
            <SegmentedListItem
                icon={TestTube2}
                title={t('drawer.algorithm_credits')}
                subtitle={t('drawer.algorithm_credits_desc')}
                trailing={chevron}
                onClick={() => showDialog('confirm', t('drawer.algorithm_confirm'), () => void openExternalUrl('https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test'))}
            />

            {/* This project's own repository — distinct from the algorithm row. */}
            <SegmentedListItem
                icon={CodeFile}
                title={t('drawer.github')}
                subtitle={t('drawer.github_desc')}
                trailing={chevron}
                onClick={() => showDialog('confirm', t('drawer.github_confirm'), () => void openExternalUrl('https://github.com/xingqimiao/Kira-HRT-Tracker'))}
            />

            <SegmentedListItem
                icon={TriangleWarning}
                title={t('drawer.disclaimer')}
                subtitle={t('drawer.disclaimer_desc')}
                trailing={chevron}
                onClick={() => setIsDisclaimerOpen(true)}
            />

            <SegmentedListItem
                icon={Shield}
                title={t('settings.privacy')}
                subtitle={t('settings.privacy_desc')}
                trailing={chevron}
                onClick={() => showDialog('confirm', t('settings.privacy_confirm'), () => void openExternalUrl('https://kiramyao.com/privacy'))}
            />

            {onOpenLicences && (
                <SegmentedListItem
                    icon={ShieldCheck}
                    title={t('licence.title')}
                    subtitle={t('licence.row_desc')}
                    trailing={chevron}
                    onClick={onOpenLicences}
                />
            )}

            {/* The intro only ever shows itself once, so this is the only way back. */}
            <SegmentedListItem
                icon={Rewind}
                title={t('settings.show_intro')}
                trailing={chevron}
                onClick={onShowIntro}
            />
        </SegmentedList>
    );

    // ── Pane ──────────────────────────────────────────────────────────────────
    const aaPane = sub === 'aa' && aaAvailable;
    const paneTitle = aaPane
        ? t('settings.aa_display')
        : sub === 'pk'
            ? t('settings.pk_engine')
            : sub === 'calib'
                ? t('cal.settings')
                : cats.find(c => c.id === cat)?.label ?? t('nav.settings');

    const paneBody: React.ReactNode = aaPane
        ? renderAaPanel()
        : sub === 'pk'
            ? renderPkPanel()
            : sub === 'calib'
                ? renderCalibPanel()
                : cat === 'general'
                ? renderGeneral()
                : cat === 'algo'
                ? renderAlgo()
                : cat === 'plans'
                    ? renderPlans()
                    : cat === 'reminders'
                        ? renderReminders()
                        : cat === 'data'
                            ? renderData()
                            : renderAbout();

    return (
        <div className="pg on long" id="p3">
            <div className="d-split">
                <nav
                    id="hub"
                    aria-label={t('nav.settings')}
                    className="d-col"
                    style={isDesktop || mobileView === 'list' ? undefined : { display: 'none' }}
                >
                    <h1 style={{ margin: '2px 6px 4px' }}>{t('nav.settings')}</h1>
                    <SegmentedList bigIcons label={t('nav.settings')}>
                        {cats.map(({ id, label, icon, hint }) => (
                            <SegmentedListItem
                                key={id}
                                icon={icon}
                                title={label}
                                subtitle={hint}
                                active={isDesktop && cat === id}
                                trailing={isDesktop ? undefined : <Icon icon={ChevronRight} size={18} />}
                                onClick={() => (isDesktop ? selectCat(id) : enterMobileCat(id))}
                            />
                        ))}
                    </SegmentedList>
                </nav>

                <section
                    id="sd"
                    aria-label={paneTitle}
                    className="d-col detail-pane"
                    style={isDesktop || mobileView !== 'list' ? undefined : { display: 'none' }}
                >
                    <HeaderBack
                        title={paneTitle}
                        showArrow={!isDesktop || sub !== null}
                        onBack={sub !== null ? closeSub : exitMobileCat}
                        backLabel={t('core.back')}
                    />
                    <div key={`${cat}:${sub ?? 'root'}`} className="d-col m3e-rise">
                        {paneBody}
                    </div>
                </section>
            </div>
        </div>
    );
};
export default Settings;











