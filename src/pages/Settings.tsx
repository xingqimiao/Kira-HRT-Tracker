import React, { useState } from 'react';
import Icon from '../components/Icon';
import Switch from '../components/Switch';
import DateTimePicker from '../components/DateTimePicker';
import { ChevronRight, Settings2, Database, Info, ArrowLeft, Globe, CalendarDays, Check } from '../icons';
import type { IconComponent } from '../icons';
import type { Lang } from '../i18n/types';
import { AppTheme } from '../constants';
import { AntiandrogenChartMode, ANTIANDROGEN_CHART_MODES, DoseEvent, PKCustomParams, RecheckIntervals, OcrModelTier, OCR_MODEL_TIERS, PkEngineId, PK_ENGINES, DEFAULT_PK_ENGINE } from '../../logic';
import { useHRTMode } from '../contexts/HRTModeContext';
import { isNativeApp } from '../utils/platform';
import { readMedReminders, writeMedReminders, rescheduleAllNativeNotifications, type MedReminder } from '../utils/medReminders';
import { APP_VERSION } from '../constants';
import { checkNativeUpdate, downloadNativeUpdate } from '../utils/nativeUpdate';

interface SettingsProps {
    t: (key: string) => string;
    lang: Lang;
    setLang: (lang: Lang) => void;
    theme: AppTheme;
    setTheme: (theme: AppTheme) => void;
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
    weight: number;
    setIsWeightModalOpen: (isOpen: boolean) => void;
    pkParams: PKCustomParams | null;
    onNavigateToPKParams: () => void;
    onNavigateToHRTMode: () => void;
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
    /** The user's re-check intervals — each individually adjustable. */
    recheckIntervals: RecheckIntervals;
    setRecheckIntervals: (v: RecheckIntervals) => void;
    /** Which OCR model tier the lab scan uses. */
    ocrModelTier: OcrModelTier;
    setOcrModelTier: (tier: OcrModelTier) => void;
    /** Which pharmacokinetic engine computes the curve. */
    pkEngine: PkEngineId;
    setPkEngine: (id: PkEngineId) => void;
    /** The engine actually in force — the Transmtf one cannot take PK overrides. */
    engineInUse: PkEngineId;
}

type SettingsCat = 'general' | 'reminders' | 'data' | 'about';
type MobileView = 'list' | SettingsCat;

const rowBase = "w-full flex items-center justify-between py-[18px] border-b border-[var(--color-m3-outline-variant)]  text-start";
const rowLabel = "text-m3-body-medium text-[var(--color-m3-on-surface)] ";
const rowValue = "flex items-center gap-1 text-m3-body-medium text-[var(--color-m3-on-surface-variant)] ";
const muted = "text-[var(--color-m3-on-surface-variant)] ";
const on = "text-[var(--color-m3-on-surface)] ";

let _savedCat: SettingsCat = 'general';
let _savedMobileView: MobileView = 'list';

const Settings: React.FC<SettingsProps> = ({
    t, lang, theme, languageOptions, onClearAllEvents, events,
    showDialog, setIsDisclaimerOpen, onShowIntro,
    onOpenLicences,
    weight, pkParams, onNavigateToPKParams, onNavigateToHRTMode,
    onNavigateToLanguage, onNavigateToAppearance, onNavigateToWeight,
    onNavigateToExport, onNavigateToImport, autoSync, setAutoSync, isLoggedIn,
    aaChartMode, setAaChartMode,
    recheckIntervals, setRecheckIntervals,
    ocrModelTier, setOcrModelTier,
    pkEngine, setPkEngine, engineInUse,
}) => {
    const { mode } = useHRTMode();
    const [cat, setCat] = useState<SettingsCat>(_savedCat);
    const [mobileView, setMobileView] = useState<MobileView>(_savedMobileView);
    const [medReminders, setMedReminders] = useState<MedReminder[]>(() => isNativeApp() ? readMedReminders() : []);
    const [medName, setMedName] = useState('');
    // The picked time, as a Date the shared picker round-trips. Was a native
    // `<input type="time">`, which rendered a different control on every OS and
    // matched nothing else in the app; the M3 picker is the one every other time
    // field here uses.
    const [medTime, setMedTime] = useState<Date>(() => {
        const d = new Date(); d.setHours(8, 0, 0, 0); return d;
    });
    const [medTimeOpen, setMedTimeOpen] = useState(false);
    const [medPermission, setMedPermission] = useState<boolean | null>(null);
    const [medError, setMedError] = useState(false);

    const selectCat = (c: SettingsCat) => {
        _savedCat = c;
        setCat(c);
    };

    const enterMobileCat = (c: SettingsCat) => {
        _savedCat = c;
        _savedMobileView = c;
        setCat(c);
        setMobileView(c);
    };

    const exitMobileCat = () => {
        _savedMobileView = 'list';
        setMobileView('list');
    };

    const navTo = (fn: () => void, forCat: SettingsCat) => {
        _savedCat = forCat;
        _savedMobileView = forCat;
        fn();
    };

    const cats: { id: SettingsCat; label: string; icon: IconComponent; hint: string }[] = [
        { id: 'general', label: t('settings.group.general'), icon: Settings2, hint: [t('settings.hrt_mode'), t('drawer.lang'), t('settings.theme')].join(' · ') },
        { id: 'reminders', label: t('settings.group.reminders'), icon: CalendarDays, hint: [t('settings.reminders.liver'), t('settings.reminders.estradiol')].join(' · ') },
        { id: 'data',    label: t('settings.group.data'),    icon: Database,  hint: [t('export.title'), t('import.title')].join(' · ') },
        { id: 'about',   label: t('settings.group.about'),   icon: Info,      hint: [t('drawer.algorithm_credits'), t('licence.title')].join(' · ') },
    ];

    const GeneralContent = () => (
        <div>
            <button onClick={() => navTo(onNavigateToHRTMode, 'general')} className={rowBase}>
                <span className={rowLabel}>{t('settings.hrt_mode')}</span>
                <span className={rowValue}>
                    {t(mode === 'transfem' ? 'mode.transfem' : 'mode.transmasc')}
                    <Icon icon={ChevronRight} size={15} />
                </span>
            </button>

            <button onClick={() => navTo(onNavigateToLanguage, 'general')} className={rowBase}>
                <span className={rowLabel}>{t('drawer.lang')}</span>
                <span className={rowValue}>
                    <Icon icon={Globe} size={14} className="opacity-50" />
                    {languageOptions.find(o => o.value === lang)?.label ?? lang}
                    <Icon icon={ChevronRight} size={15} />
                </span>
            </button>

            <button onClick={() => navTo(onNavigateToAppearance, 'general')} className={rowBase}>
                <span className={rowLabel}>{t('settings.theme')}</span>
                <span className={rowValue}>
                    {t(`theme.${theme}`)}
                    <Icon icon={ChevronRight} size={15} />
                </span>
            </button>

            <button onClick={() => navTo(onNavigateToWeight, 'general')} className={rowBase}>
                <span className={rowLabel}>{t('status.weight')}</span>
                <span className={rowValue}>
                    {weight} kg
                    <Icon icon={ChevronRight} size={15} />
                </span>
            </button>

            {isLoggedIn && (
                <div className={`${rowBase} cursor-default`}>
                    <div>
                        <p className={rowLabel}>{t('settings.auto_sync')}</p>
                        <p className={`text-xs ${muted} mt-0.5`}>{t('settings.auto_sync_desc')}</p>
                    </div>
                    <Switch checked={autoSync} onChange={setAutoSync} />
                </div>
            )}

            {/* The lab-scan model used to be picked here, as a trade-off between a
                small download and accuracy. There is one model now, so there is no
                choice to present — see the note on `OcrModelTier` in logic.ts. The
                stored preference is still normalised on read, so a device that had
                chosen the retired tier lands on the current one rather than on a
                missing value. */}

            {/* Which engine computes the curve. Transfem only: the Transmtf engine
                has no testosterone model, so on a transmasc account the choice would
                do nothing — and a control that silently does nothing is worse than no
                control.

                Stacked cards rather than a row of pills, because the names alone say
                nothing: "Built-in" and "Transmtf" are not descriptions, and a reader
                choosing between two models needs to know what changes. Each option
                carries its own sentence, and the selected one also says that it is. */}
            {mode === 'transfem' && (
                <div className="w-full py-[18px] border-b border-[var(--color-m3-outline-variant)]">
                    <p className={rowLabel}>{t('settings.pk_engine')}</p>
                    <p className={`text-xs ${muted} mt-0.5`}>{t('settings.pk_engine_desc')}</p>
                    <div className="mt-3 flex flex-col gap-2" role="group" aria-label={t('settings.pk_engine')}>
                        {PK_ENGINES.map(id => {
                            const active = pkEngine === id;
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => setPkEngine(id)}
                                    className={`w-full text-start rounded-[var(--radius-lg)] border p-3 transition-colors ${
                                        active
                                            ? 'border-[var(--color-m3-primary)] bg-[var(--color-m3-surface-container)] '
                                            : 'border-[var(--color-m3-outline-variant)]  hover:border-[var(--color-m3-outline)] '
                                    }`}
                                >
                                    <span className="flex items-center justify-between gap-2">
                                        <span className={`text-sm font-medium ${active ? 'text-[var(--color-m3-primary)]' : on}`}>
                                            {t(`settings.pk_engine.${id}`)}
                                        </span>
                                        {active && <Icon icon={Check} size={15} className="shrink-0 text-[var(--color-m3-primary)]" strokeWidth={2.5} />}
                                    </span>
                                    <span className={`mt-1 block text-xs leading-relaxed ${muted}`}>
                                        {t(`settings.pk_engine.${id}_note`)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Only meaningful in transfem mode: the anti-androgen column this
                controls does not exist on the transmasc overview. */}
            {mode === 'transfem' && (
                <div className="w-full py-[18px] border-b border-[var(--color-m3-outline-variant)]">
                    <p className={rowLabel}>{t('settings.aa_display')}</p>
                    <p className={`text-xs ${muted} mt-0.5`}>{t('settings.aa_display_desc')}</p>
                    {/* The app's own button tokens, as a segmented control: one
                        selected segment (filled) against the rest (outlined). */}
                    <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label={t('settings.aa_display')}>
                        {ANTIANDROGEN_CHART_MODES.map(m => (
                            <button
                                key={m}
                                type="button"
                                aria-pressed={aaChartMode === m}
                                onClick={() => setAaChartMode(m)}
                                className={`m3-btn m3-btn-sm ${aaChartMode === m ? 'm3-btn-filled' : 'm3-btn-outlined'}`}
                            >
                                {t(`settings.aa_display.${m}`)}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <button
                onClick={() => navTo(onNavigateToPKParams, 'general')}
                className={`${rowBase} border-b-0`}
            >
                <span className={rowLabel}>{t('settings.pk_params')}</span>
                <span className={rowValue}>
                    {engineInUse === 'transmtf' ? (
                        <span className="text-xs text-[var(--color-m3-on-surface-variant)]  mr-1">
                            {t('pk.unsupported.short')}
                        </span>
                    ) : pkParams && (
                        <span className="text-xs text-cos-warning  font-medium mr-1">
                            {t('pk.customized')}
                        </span>
                    )}
                    <Icon icon={ChevronRight} size={15} />
                </span>
            </button>
        </div>
    );

    const DataContent = () => (
        <div>
            <button onClick={() => navTo(onNavigateToExport, 'data')} className={rowBase}>
                <span className={rowLabel}>{t('export.title')}</span>
                <Icon icon={ChevronRight} size={15} className={muted} />
            </button>

            <button onClick={() => navTo(onNavigateToImport, 'data')} className={rowBase}>
                <span className={rowLabel}>{t('import.title')}</span>
                <Icon icon={ChevronRight} size={15} className={muted} />
            </button>

            <button
                onClick={onClearAllEvents}
                disabled={!events.length}
                className={`${rowBase} border-b-0 ${!events.length ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
                <span className={`text-m3-body-medium ${events.length ? 'text-cos-error ' : rowLabel}`}>
                    {t('drawer.clear')}
                </span>
            </button>
        </div>
    );

    const AboutContent = () => (
        <div>
            {isNativeApp() && (
                <button
                    onClick={() => {
                        void checkNativeUpdate().then(update => {
                            if (!update) {
                                showDialog('alert', `${t('settings.check_updates.latest')} (${APP_VERSION.replace(/^v/, '')})`);
                                return;
                            }
                            const notes = update.notes.length > 0 ? `\n\n${update.notes.map(note => `• ${note}`).join('\n')}` : '';
                            showDialog(
                                'confirm',
                                `${t('settings.check_updates.available').replace('{version}', update.version)}${notes}`,
                                () => { void downloadNativeUpdate(update); },
                            );
                        }).catch(() => showDialog('alert', t('settings.check_updates.error')));
                    }}
                    className={rowBase}
                >
                    <div>
                        <p className={rowLabel}>{t('settings.check_updates.title')}</p>
                        <p className={`text-xs ${muted} mt-0.5`}>{t('settings.check_updates.version').replace('{version}', APP_VERSION.replace(/^v/, ''))}</p>
                    </div>
                    <Icon icon={ChevronRight} size={15} className={muted} />
                </button>
            )}

            {/* The Android app, for a web visitor: a direct link to the signed APK.
                Not shown inside the native app (which updates itself — the row above),
                so the two are mutually exclusive. The URL is built from APP_VERSION so
                a version bump cannot leave it pointing at the previous release. */}
            {!isNativeApp() && (
                <button
                    onClick={() => window.open(`https://hrt.kiramyao.com/android/KiraHRT-${APP_VERSION.replace(/^v/, '')}-release.apk`, '_blank')}
                    className={rowBase}
                >
                    <div>
                        <p className={rowLabel}>{t('settings.download_android')}</p>
                        <p className={`text-xs ${muted} mt-0.5`}>{t('settings.download_android_desc')}</p>
                    </div>
                    <Icon icon={ChevronRight} size={15} className={muted} />
                </button>
            )}

            {/* Algorithm attribution. Required by the upstream project's README, and
                it is the honest thing regardless: the pharmacokinetic model is the
                substance of this app and it is not our work. Kept as its own row with
                a visible description rather than buried in a credits list, because
                "visibly link back" is the actual requirement — a link nobody can find
                does not satisfy it. */}
            <button
                onClick={() => showDialog('confirm', t('drawer.algorithm_confirm'), () => window.open('https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test', '_blank'))}
                className={rowBase}
            >
                <div>
                    <p className={rowLabel}>{t('drawer.algorithm_credits')}</p>
                    <p className={`text-xs ${muted} mt-0.5`}>{t('drawer.algorithm_credits_desc')}</p>
                </div>
                <Icon icon={ChevronRight} size={15} className={muted} />
            </button>

            {/* This project's own repository — distinct from the algorithm row above,
                which credits someone else's work because the model is theirs. This
                one is where *this* app lives; it pointed at a different project's
                repo, which reads as a misattribution in both directions. */}
            <button
                onClick={() => showDialog('confirm', t('drawer.github_confirm'), () => window.open('https://github.com/xingqimiao/Kira-HRT-Tracker', '_blank'))}
                className={rowBase}
            >
                <span className={rowLabel}>{t('drawer.github')}</span>
                <Icon icon={ChevronRight} size={15} className={muted} />
            </button>

            <button onClick={() => setIsDisclaimerOpen(true)} className={rowBase}>
                <span className={rowLabel}>{t('drawer.disclaimer')}</span>
                <Icon icon={ChevronRight} size={15} className={muted} />
            </button>

            {/* Open-source licence notice. This is the row "About" was missing: the
                algorithm, the model and the app we forked are all other people's
                work, and until now the only acknowledgement was a credits row that
                linked out. A licence notice is the formal statement of that, and it
                belongs in About rather than in Settings → Data, which is about the
                user's records rather than about the software. */}
            {onOpenLicences && (
                <button onClick={onOpenLicences} className={rowBase}>
                    <div>
                        <p className={rowLabel}>{t('licence.title')}</p>
                        <p className={`text-xs ${muted} mt-0.5`}>{t('licence.row_desc')}</p>
                    </div>
                    <Icon icon={ChevronRight} size={15} className={muted} />
                </button>
            )}

            {/* The intro only ever shows itself once, so this is the only way back
                to it — and the only way anyone who skipped it can read it. */}
            <button onClick={onShowIntro} className={rowBase}>
                <span className={rowLabel}>{t('settings.show_intro')}</span>
                <Icon icon={ChevronRight} size={15} className={muted} />
            </button>
        </div>
    );

    /**
     * One interval as a label plus a bounded number field.
     *
     * A plain function rather than a component: a component declared in the render
     * body is a new type every render, so the field would remount and lose focus on
     * each keystroke.
     */
    const intervalRow = (label: string, value: number, onChange: (n: number) => void) => (
        <div className="flex items-center justify-between gap-3 py-2">
            <span className="text-m3-body-medium text-[var(--color-m3-on-surface-variant)]">{label}</span>
            <input
                type="number"
                min={1}
                max={120}
                inputMode="numeric"
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="input-num w-20"
            />
        </div>
    );

    const intervalSection = (title: string, rows: React.ReactNode) => (
        <div className="w-full py-[18px] border-b border-[var(--color-m3-outline-variant)]">
            <p className={rowLabel}>{title}</p>
            <div className="mt-1">{rows}</div>
        </div>
    );

    /**
     * The re-check interval controls.
     *
     * Every value the reminder logic uses is here, so a cadence is a preference
     * rather than a constant — including estradiol, which had no reminder before.
     * The description names them as the app's own defaults and points at a doctor,
     * because an interval is a number the reader can change, not advice.
     */
    const addMedReminder = () => {
        const hour = medTime.getHours(), minute = medTime.getMinutes();
        if (!medName.trim()) return;
        const next = [...medReminders, { id: crypto.randomUUID(), name: medName.trim(), hour, minute, enabled: true }].sort((a, b) => a.hour - b.hour || a.minute - b.minute);
        setMedReminders(next); writeMedReminders(next);
        void rescheduleAllNativeNotifications(true).then(setMedPermission).catch(() => setMedError(true));
        setMedName('');
    };
    const removeMedReminder = (id: string) => {
        const next = medReminders.filter(r => r.id !== id);
        setMedReminders(next); writeMedReminders(next); void rescheduleAllNativeNotifications().catch(() => setMedError(true));
    };
    const toggleMedReminder = (id: string) => {
        const next = medReminders.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r);
        setMedReminders(next); writeMedReminders(next); void rescheduleAllNativeNotifications().catch(() => setMedError(true));
    };

    const MedReminderContent = () => isNativeApp() ? (
        <div className="mb-5 rounded-xl border border-[var(--color-m3-outline-variant)] p-4">
            <p className={`${rowLabel} mb-1`}>{t('med.title')}</p>
            <p className={`text-xs ${muted} mb-3`}>{t('med.desc')}</p>
            {medPermission === false && <p className="text-xs text-[var(--color-m3-warning)]">{t('med.permission')}</p>}
            {medError && <p className="text-xs text-[var(--color-m3-error)]">{t('med.error')}</p>}
            {medReminders.map(r => (
                <div key={r.id} className="flex items-center gap-3 py-2 border-b border-[var(--color-m3-outline-variant)]">
                    <button type="button" aria-pressed={r.enabled} onClick={() => toggleMedReminder(r.id)} className={`flex-1 text-start ${r.enabled ? on : muted}`}>
                        {r.name} · {String(r.hour).padStart(2, '0')}:{String(r.minute).padStart(2, '0')}
                    </button>
                    <button type="button" onClick={() => removeMedReminder(r.id)} className={`text-xs ${muted}`}>{t('med.remove')}</button>
                </div>
            ))}
            <div className="mt-3 flex gap-2">
                <input aria-label={t('med.name')} value={medName} onChange={e => setMedName(e.target.value)} placeholder={t('med.name')} className="input-text min-w-0 flex-1" />
                <button
                    type="button"
                    onClick={() => setMedTimeOpen(v => !v)}
                    aria-expanded={medTimeOpen}
                    aria-label={t('med.time')}
                    className="input-text flex w-28 shrink-0 items-center justify-between tabular-nums"
                >
                    <span>{String(medTime.getHours()).padStart(2, '0')}:{String(medTime.getMinutes()).padStart(2, '0')}</span>
                    <Icon icon={ChevronRight} size={14} className={`shrink-0 transition-transform duration-200 ${medTimeOpen ? 'rotate-90' : ''}`} />
                </button>
                <button type="button" onClick={addMedReminder} className="m3-button-filled shrink-0">{t('med.add')}</button>
            </div>
            {/* The app's own M3 picker, time mode — the same control every other time
                field here uses. It unfolds in place, like the date fields do. */}
            <DateTimePicker
                isOpen={medTimeOpen}
                inline
                mode="time"
                onClose={() => setMedTimeOpen(false)}
                onConfirm={(d) => { setMedTime(d); setMedTimeOpen(false); }}
                initialDate={medTime}
                title={t('med.time')}
            />
        </div>
    ) : null;

    const RemindersContent = () => (
        <div>
            <MedReminderContent />
            <p className={`text-xs ${muted} py-3 leading-relaxed`}>{t('settings.reminders.desc')}</p>
            {intervalSection(t('settings.reminders.liver'), (
                <>
                    {intervalRow(t('settings.reminders.phase'), recheckIntervals.liverFirstPhaseMonths, v => setRecheckIntervals({ ...recheckIntervals, liverFirstPhaseMonths: v }))}
                    {intervalRow(t('settings.reminders.early'), recheckIntervals.liverEarlyMonths, v => setRecheckIntervals({ ...recheckIntervals, liverEarlyMonths: v }))}
                    {intervalRow(t('settings.reminders.after'), recheckIntervals.liverMonths, v => setRecheckIntervals({ ...recheckIntervals, liverMonths: v }))}
                </>
            ))}
            {intervalSection(t('settings.reminders.potassium'), (
                <>
                    {intervalRow(t('settings.reminders.phase'), recheckIntervals.potassiumFirstPhaseMonths, v => setRecheckIntervals({ ...recheckIntervals, potassiumFirstPhaseMonths: v }))}
                    {intervalRow(t('settings.reminders.early'), recheckIntervals.potassiumEarlyMonths, v => setRecheckIntervals({ ...recheckIntervals, potassiumEarlyMonths: v }))}
                    {intervalRow(t('settings.reminders.after'), recheckIntervals.potassiumMonths, v => setRecheckIntervals({ ...recheckIntervals, potassiumMonths: v }))}
                </>
            ))}
            {intervalSection(t('settings.reminders.estradiol'), (
                intervalRow(t('settings.reminders.interval'), recheckIntervals.estradiolMonths, v => setRecheckIntervals({ ...recheckIntervals, estradiolMonths: v }))
            ))}
        </div>
    );

    const catContent = (id: SettingsCat) => {
        if (id === 'general') return <GeneralContent />;
        if (id === 'reminders') return <RemindersContent />;
        if (id === 'data') return <DataContent />;
        return <AboutContent />;
    };

    return (
        <div className="mx-auto flex w-full max-w-[64rem] pt-8 pb-32 min-h-full">

            {/* ── Left category nav (desktop) ─────────────────────────── */}
            <nav className="hidden md:flex flex-col w-52 shrink-0 px-3 gap-0.5 border-r border-[var(--color-m3-outline-variant)] ">
                <p className={`px-3 py-1.5 mb-3 text-m3-title-xl ${on}`}>
                    {t('nav.settings')}
                </p>
                {cats.map(({ id, label, icon }) => (
                    <button
                        key={id}
                        onClick={() => selectCat(id)}
                        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-m3-body-medium text-start
                            ${cat === id
                                ? `bg-[var(--color-m3-surface-container)]  ${on} font-medium`
                                : `${muted} hover:bg-[var(--color-m3-surface-container)]  hover:${on}`
                            }`}
                    >
                        <Icon icon={icon} size={16} strokeWidth={1.75} />
                        {label}
                    </button>
                ))}
            </nav>

            {/* ── Desktop content ─────────────────────────────────────── */}
            <div className="hidden md:block flex-1 px-10 max-w-2xl">
                <h2 className={`text-m3-title-xl ${on} mb-6`}>
                    {cats.find(c => c.id === cat)?.label}
                </h2>
                {/* Keyed on the category so switching remounts the pane and the
                    entrance plays. The category list itself does not move. */}
                <div className="m3-panel-in" key={cat}>{catContent(cat)}</div>
            </div>

            {/* ── Mobile ──────────────────────────────────────────────── */}
            {/* See Admin.tsx: a stretched `flex-1` child under the shell's `min-h-full`
                hides its own overflow from the scroller. */}
            <div className="md:hidden flex-1 self-start px-6 pb-32">
                {mobileView === 'list' ? (
                    <>
                        <h1 className={`sticky top-0 z-20 -mx-6 px-6 pt-2 pb-3 mb-3 bg-[var(--color-m3-surface-dim)]  text-m3-title-xl ${on}`}>{t('nav.settings')}</h1>
                        {cats.map(({ id, label, icon, hint }) => (
                            <button
                                key={id}
                                onClick={() => enterMobileCat(id)}
                                className={`${rowBase} items-center`}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={`w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-m3-surface-container)] `}>
                                        <Icon icon={icon} size={18} strokeWidth={1.75} className={muted} />
                                    </div>
                                    <div className="text-start">
                                        <p className={`text-m3-body-medium font-medium ${on}`}>{label}</p>
                                        <p className={`text-xs ${muted} mt-0.5 leading-relaxed`}>{hint}</p>
                                    </div>
                                </div>
                                <Icon icon={ChevronRight} size={15} className={muted} />
                            </button>
                        ))}
                    </>
                ) : (
                    <>
                        <div className="sticky top-0 z-20 -mx-6 px-6 pt-2 pb-3 mb-3 bg-[var(--color-m3-surface-dim)] ">
                            <button
                                onClick={exitMobileCat}
                                className="flex items-center gap-2 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] "
                            >
                                <Icon icon={ArrowLeft} size={18} className={`${muted} shrink-0`} />
                                <h1 className={`text-m3-title-xl ${on}`}>
                                    {cats.find(c => c.id === mobileView)?.label}
                                </h1>
                            </button>
                        </div>
                        <div className="m3-panel-in" key={mobileView}>{catContent(mobileView as SettingsCat)}</div>
                    </>
                )}
            </div>
        </div>
    );
};

export default Settings;
