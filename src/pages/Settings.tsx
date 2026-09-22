import React, { useState } from 'react';
import Icon from '../components/Icon';
import Switch from '../components/Switch';
import { ChevronRight, Settings2, Database, Info, ArrowLeft, Globe, CalendarDays } from '../icons';
import type { IconComponent } from '../icons';
import type { Lang } from '../i18n/types';
import { AppTheme } from '../constants';
import { AntiandrogenChartMode, ANTIANDROGEN_CHART_MODES, DoseEvent, PKCustomParams, RecheckIntervals, OcrModelTier, OCR_MODEL_TIERS } from '../../logic';
import { useHRTMode } from '../contexts/HRTModeContext';
import { useVial } from '../contexts/VialContext';

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
}) => {
    const { mode } = useHRTMode();
    const { showVial, setShowVial } = useVial();
    const [cat, setCat] = useState<SettingsCat>(_savedCat);
    const [mobileView, setMobileView] = useState<MobileView>(_savedMobileView);

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

            <div className={`${rowBase} cursor-default`}>
                <div>
                    <p className={rowLabel}>{t('settings.blood_vial')}</p>
                    <p className={`text-xs ${muted} mt-0.5`}>{t('settings.blood_vial_desc')}</p>
                </div>
                <Switch checked={showVial} onChange={setShowVial} />
            </div>

            {/* The lab-scan model used to be picked here, as a trade-off between a
                small download and accuracy. There is one model now, so there is no
                choice to present — see the note on `OcrModelTier` in logic.ts. The
                stored preference is still normalised on read, so a device that had
                chosen the retired tier lands on the current one rather than on a
                missing value. */}

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
                    {pkParams && (
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

            <button
                onClick={() => showDialog('confirm', t('drawer.github_confirm'), () => window.open('https://github.com/SmirnovaOyama/Oyama-s-HRT-recorder', '_blank'))}
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
                className="w-20 py-1 text-center tabular-nums bg-transparent border-b-2 border-[var(--color-m3-outline-variant)] focus:border-[var(--color-m3-primary)] outline-none text-[var(--color-m3-on-surface)]"
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
    const RemindersContent = () => (
        <div>
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
