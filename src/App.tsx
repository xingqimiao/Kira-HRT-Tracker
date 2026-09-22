import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation, LanguageProvider } from './contexts/LanguageContext';
import { useDialog, DialogProvider } from './contexts/DialogContext';
import { HRTModeProvider, useHRTMode } from './contexts/HRTModeContext';
import { VialProvider } from './contexts/VialContext';
import ErrorBoundary from './components/ErrorBoundary';
import { APP_VERSION, AppTheme, KeyColor } from './constants';
import { DoseEvent, decompressData, encryptData, decryptData } from '../logic';
import type { Lang } from './i18n/types';
import { useAppData } from './hooks/useAppData';
import { useAppNavigation, ViewKey } from './hooks/useAppNavigation';
import { useLiveShareSync } from './hooks/useLiveShareSync';
import { useCoreSync } from './hooks/useCoreSync';
import { onAppSettingsApplied } from './utils/appSettings';
import { setAuthLandingIntent, takeAuthLandingIntent } from './utils/authLandingIntent';

import WeightEditorModal from './components/WeightEditorModal';
import DoseFormModal from './components/DoseFormModal';
import ImportModal from './components/ImportModal';
import { AppShell } from './components/ui';
import PasswordInputModal from './components/PasswordInputModal';
import DisclaimerModal from './components/DisclaimerModal';
import CoreAuthModal from './components/CoreAuthModal';
import { useCoreSession, CoreSessionProvider } from './hooks/useCoreSession';

// Pages
import Home from './pages/Home';
import History from './pages/History';
import Lab from './pages/Lab';
import CalibrationSettings from './pages/CalibrationSettings';
import Settings from './pages/Settings';
import Account from './pages/Account';
import CoreAccountSettings from './pages/CoreAccountSettings';
import BindCredentials from './pages/BindCredentials';
import OAuthLanding from './pages/OAuthLanding';
import PKParamsPage from './pages/PKParams';
import HRTModeSettings from './pages/HRTModeSettings';
import LanguageSettings from './pages/LanguageSettings';
import AppearanceSettings from './pages/AppearanceSettings';
import WeightSettings from './pages/WeightSettings';
import ExportSettings from './pages/ExportSettings';
import ImportSettings from './pages/ImportSettings';
import LicenceSettings from './pages/LicenceSettings';
import McpSettings from './pages/McpSettings';
import PublicShare from './pages/PublicShare';
import ShareSettings from './pages/ShareSettings';
import Onboarding, { markOnboardingSeen, shouldShowOnboarding } from './pages/Onboarding';
import HrtMilestoneEffect from './components/HrtMilestoneEffect';
import { armMilestone, clearArmedMilestone, type MilestoneNotice } from './utils/hrtMilestone';

const AppContent = () => {
    const { t, lang, setLang } = useTranslation();
    const { showDialog } = useDialog();
    const { mode } = useHRTMode();

    /**
     * The Application Core session — the only one there is.
     *
     * It holds the key to the records and identifies the account the data layer
     * below is scoped to.
     */
    const coreSession = useCoreSession();

    /**
     * What a provider landing asked for, read once during this first render.
     *
     * State rather than an effect, and read *before* the hooks that consume it, for two
     * reasons: an effect applies the navigation after the first paint, so the user would
     * see Home flash and then Account, and it made correctness depend on declaration
     * order — the effect sat above `setPrefillUsername` and `handleViewChange`.
     *
     * `takeAuthLandingIntent` clears the key as it reads it, so a later manual reload does
     * not drag the user back to the Account tab.
     */
    const [landingIntent] = useState(() => takeAuthLandingIntent());

    const [isCoreAuthOpen, setIsCoreAuthOpen] = useState(false);
    const [prefillUsername, setPrefillUsername] = useState(landingIntent?.username ?? '');
    /**
     * Set when the account page offers the binding screen before the server has refused
     * anything. The mandatory case needs no flag: it comes from the record store itself.
     */
    const [bindRequested, setBindRequested] = useState(false);

    /**
     * Bumped when the binding screen reports success.
     *
     * A bind that returns OK is itself the proof the server now has the credential, and
     * that is a fact this screen knows and the sync engine does not: the sync may be
     * skipped, coalesced, or still running when the promise resolves. Counting the
     * confirmations lets the gate below stop depending on a sync it cannot observe —
     * one bump is enough to leave the screen, and `accountIncomplete` is only consulted
     * before that ever happens.
     */
    const [bindConfirmations, setBindConfirmations] = useState(0);

    // Use Custom Hooks
    const {
        events,
        weight, setWeight,
        labResults,
        doseTemplates,
        simulation,
        calibrationFn,
        calibrationMethod, setCalibrationMethod,
        calibrationHistoryMode, setCalibrationHistoryMode,
        aaChartMode, setAaChartMode,
        hrtStartDate, setHrtStartDate,
        recheckIntervals, setRecheckIntervals,
        ocrModelTier, setOcrModelTier,
        pendingMilestone,
        showStreakNotice, dismissStreakNotice,
        calibration,
        currentLevel,
        currentT,
        currentStatus,
        currentTime,
        groupedEvents,
        addEvent, addEvents, updateEvent, deleteEvent, deleteEvents, clearAllEvents,
        addLabResult, updateLabResult, deleteLabResult, clearLabResults,
        journal, addJournalEntry, updateJournalEntry, deleteJournalEntry,
        dismissedRechecks, dismissRecheck,
        addTemplate, deleteTemplate,
        addQuickDose, deleteQuickDose,
        quickDoses,
        pkParams, setPkParams, clearPkParams,
        processImportedData,
        buildExportPayload,
        applySyncedState,
        scope,
        readyScope,
    } = useAppData(showDialog, coreSession.user?.userId ?? null);

    // A confirmed bind belongs to the account that made it. Reset when the signed-in
    // user changes (or is signed out), so the next account is not waved past a gate it
    // has its own reason to answer.
    const boundForRef = useRef<string | null>(null);
    useEffect(() => {
        const id = coreSession.user?.userId ?? null;
        if (boundForRef.current !== id) {
            boundForRef.current = id;
            setBindConfirmations(0);
            setBindRequested(false);
        }
    }, [coreSession.user?.userId]);

    useLiveShareSync({
        authToken: coreSession.token,
        mode,
        events,
        simulation,
        calibrationFn,
    });

    const {
        currentView,
        transitionDirection,
        handleViewChange,
        mainScrollRef,
        navItems,
    } = useAppNavigation(landingIntent?.view);


    // --- Local UI State (Modals & Forms) ---
    const [isWeightModalOpen, setIsWeightModalOpen] = useState(false);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingEvent, setEditingEvent] = useState<DoseEvent | null>(null);
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isPasswordInputOpen, setIsPasswordInputOpen] = useState(false);
    const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
    const [isQuickAddLabOpen, setIsQuickAddLabOpen] = useState(false);
    const [isDisclaimerOpen, setIsDisclaimerOpen] = useState(false);
    const [pendingImportText, setPendingImportText] = useState<string | null>(null);

    // --- Auto-sync preference ---
    // Storage key kept from when this only ever uploaded, so an existing
    // preference carries over rather than silently resetting to on.
    const [autoSync, setAutoSync] = useState<boolean>(() =>
        localStorage.getItem('app-auto-backup') !== 'false'
    );

    // --- First run ---
    const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding);

    const [theme, setTheme] = useState<AppTheme>(() => {
        const saved = localStorage.getItem('app-theme');
        // Follow the OS by default: someone who has their phone in light mode all day
        // should not have to be told this app disagrees. A stored choice always wins,
        // and 'mono' is a value older builds wrote — it falls through to 'system'
        // rather than being honoured, since the palette is gone.
        return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
    });

    const [keyColor, setKeyColor] = useState<KeyColor>(() =>
        localStorage.getItem('app-key-color') === 'blue' ? 'blue' : 'pink',
    );

    useEffect(() => {
        localStorage.setItem('app-key-color', keyColor);
        // A class rather than inline variables: the light/dark readings live in
        // stylesheet blocks, and this only has to select which pair is in force.
        window.document.documentElement.classList.toggle('key-blue', keyColor === 'blue');
    }, [keyColor]);

    // Adopt theme and key colour when a sync brings the account's choices in.
    // Each value is validated against what this build understands before being
    // taken, so a payload from a newer version cannot set a theme it has no
    // palette for.
    useEffect(() => onAppSettingsApplied(() => {
        const savedTheme = localStorage.getItem('app-theme');
        if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') setTheme(savedTheme);
        setKeyColor(localStorage.getItem('app-key-color') === 'blue' ? 'blue' : 'pink');
    }), []);

    useEffect(() => {
        localStorage.setItem('app-auto-backup', String(autoSync));
    }, [autoSync]);

    // Two-way sync with the Application Core — the path that actually stores the
    // records.
    //
    // Gated on `coreSession.isSignedIn`: without a Core session there is no key
    // server-side, so a push would 401 — and, worse, a *pull* would silently do
    // nothing while looking like it worked. ANDed with the user's own preference:
    // the hook's `enabled` is documented as "the user's preference", and `autoSync`
    // is that preference — passing only the session left the Settings toggle
    // connected to nothing, so records kept syncing with it switched off.
    /**
     * The milestone this visit should celebrate, as `<days>:<cake|confetti>`.
     *
     * Splitting it here rather than in the account page is what puts the notice
     * *above* the shell's scroll container instead of inside a page: the banner is
     * a notice about the account, not a row of it, and it should still be up when
     * someone has scrolled the settings list. Which day is a milestone is
     * arithmetic (`milestoneFor`); "has this one been shown yet" is a stored fact,
     * and both are already answered by the data layer before this point.
     */
    const celebration = armMilestone(pendingMilestone);

    /**
     * The banner's notice: the milestone if this visit has one, otherwise the
     * third-day streak note.
     *
     * The milestone wins when both are somehow set — a day can be both the third
     * of a run and a round hundred, and the round hundred is the rarer thing.
     * The streak note is a one-off from the data layer; once dismissed this
     * visit it is gone for good, because the layer already stamped it in storage.
     */
    const notice: MilestoneNotice | null =
        celebration?.milestone ?? (showStreakNotice ? 'streak3' : null);

    /**
     * Cleared once the notice has shown itself, so a later mount in the same
     * session does not replay it. Not on unmount — see the note on
     * `armMilestone` in src/utils/hrtMilestone.ts for why.
     */
    const onMilestoneDone = useCallback(() => {
        clearArmedMilestone();
        dismissStreakNotice();
    }, [dismissStreakNotice]);

    const coreSyncState = useCoreSync({
        token: coreSession.token,
        userId: coreSession.user?.userId ?? null,
        enabled: coreSession.isSignedIn && autoSync,
        ready: readyScope === scope,
        buildPayload: buildExportPayload,
        applyRemote: applySyncedState,
        events,
        labResults,
        doseTemplates,
        weight,
        pkParams,
        calibrationMethod,
        calibrationHistoryMode,
        aaChartMode,
        hrtStartDate,
        recheckIntervals,
        ocrModelTier,
    });

    useEffect(() => {
        localStorage.setItem('app-theme', theme);
        const root = window.document.documentElement;

        const applyTheme = (isDark: boolean) => {
            root.classList.remove('light', 'dark');
            root.classList.add(isDark ? 'dark' : 'light');
        };

        if (theme === 'system') {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            applyTheme(mediaQuery.matches);
            const handleChange = (e: MediaQueryListEvent) => applyTheme(e.matches);
            mediaQuery.addEventListener('change', handleChange);
            return () => mediaQuery.removeEventListener('change', handleChange);
        } else {
            applyTheme(theme === 'dark');
        }
    }, [theme]);

    // Names in their own script, because a reader picking between 日本語 and 한국어
    // recognises the one they read. Typed as `Lang` so a language added to the
    // packs cannot be left out of the picker, and a label cannot name a language
    // this build does not ship.
    const languageOptions = useMemo((): { value: Lang; label: string }[] => ([
        { value: 'zh', label: '简体中文' },
        { value: 'zh-TW', label: '正體中文' },
        { value: 'yue', label: '廣東話' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
        { value: 'ko', label: '한국어' },
        { value: 'tr', label: 'Türkçe' },
    ]), []);


    // --- Modal Logic Wrappers ---

    useEffect(() => {
        const shouldLock = isPasswordInputOpen || isWeightModalOpen || isFormOpen || isImportModalOpen || isDisclaimerOpen;
        document.body.style.overflow = shouldLock ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
    }, [isPasswordInputOpen, isWeightModalOpen, isFormOpen, isImportModalOpen, isDisclaimerOpen]);


    const importEventsFromJson = async (text: string): Promise<boolean> => {
        try {
            let parsed = JSON.parse(text);

            // Handle Encryption
            if (parsed.encrypted && parsed.iv && parsed.salt && parsed.data) {
                setPendingImportText(text);
                setIsPasswordInputOpen(true);
                return true;
            }

            // Handle Compression
            if (parsed.c && typeof parsed.c === 'string') {
                const decompressed = await decompressData(parsed.c);
                parsed = JSON.parse(decompressed);
            }

            return processImportedData(parsed);
        } catch (err) {
            console.error(err);
            showDialog('alert', t('drawer.import_error'));
            return false;
        }
    };

    const handlePasswordSubmit = async (password: string) => {
        if (!pendingImportText) return;
        const decrypted = await decryptData(pendingImportText, password);
        if (decrypted) {
            try {
                let parsed = JSON.parse(decrypted);
                // Handle Compression after decryption
                if (parsed.c && typeof parsed.c === 'string') {
                    const decompressed = await decompressData(parsed.c);
                    parsed = JSON.parse(decompressed);
                }
                processImportedData(parsed);
                setIsPasswordInputOpen(false);
                setPendingImportText(null);
            } catch (e) {
                console.error(e);
                showDialog('alert', t('import.decrypt_error'));
            }
        } else {
            showDialog('alert', t('import.decrypt_error'));
        }
    };

    const handleEditEvent = (e: DoseEvent) => { setEditingEvent(e); setIsFormOpen(true); };

    const handleQuickExport = () => {
        if (events.length === 0 && labResults.length === 0) {
            showDialog('alert', t('drawer.empty_export'));
            return;
        }
        const exportData = buildExportPayload();
        const json = JSON.stringify(exportData, null, 2);
        navigator.clipboard.writeText(json).then(() => {
            showDialog('alert', t('drawer.export_copied'));
        }).catch(err => {
            console.error('Failed to copy: ', err);
        });
    };

    const downloadFile = (data: string, filename: string) => {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    };

    const handleExportConfirm = async (encrypt: boolean, customPassword?: string): Promise<string | null> => {
        const exportData = buildExportPayload();
        const json = JSON.stringify(exportData, null, 2);

        if (encrypt) {
            const { data, password } = await encryptData(json, customPassword);
            downloadFile(data, `hrt-dosages-encrypted-${new Date().toISOString().split('T')[0]}.json`);
            if (!customPassword) {
                return password;
            }
        } else {
            downloadFile(json, `hrt-dosages-${new Date().toISOString().split('T')[0]}.json`);
        }
        return null;
    };

    // Reconcile, then upload — not a plain upload. Every save inserts a new
    // newest revision with no "only if unchanged", so writing without reading
    // first would let one device's press erase a dose another device deleted.
    // Works with auto-sync switched off; refuses when the cloud copy is
    // encrypted and unreadable here, rather than replacing it with plaintext.

    /**
     * Which destination owns the current view.
     *
     * A sub-view belongs to the section it was drilled out of, so the rail (and
     * the bar) keep that destination lit while you are inside it. The MCP screen
     * is the one the two surfaces used to disagree about — the top bar lit
     * Settings and the bottom bar lit Account, and it is reached from Account.
     */
    const sectionFor = (view: string): string => {
        if (view === 'settings-mcp') return 'account';
        if (view.startsWith('settings-') || view === 'pk-params') return 'settings';
        if (view === 'lab-calibration') return 'lab';
        return view;
    };
    const activeSection = sectionFor(currentView);

    // Takes over the whole screen rather than sitting in the view stack: the
    // intro is where language and HRT mode get chosen, and leaving the nav up
    // would let someone tab away with both still on their defaults.
    if (showOnboarding) {
        return (
            <Onboarding
                languageOptions={languageOptions}
                /* So the start-date step opens on whatever is already saved, and
                   writes through the data layer that knows the account. */
                hrtStartDate={hrtStartDate}
                onHrtStartChange={setHrtStartDate}
                onDone={() => { markOnboardingSeen(); setShowOnboarding(false); }}
            />
        );
    }

    /**
     * The mandatory fallback-credential gate.
     *
     * The record store refuses an account that has no password bound — an account
     * created through X or Google — so every screen behind this one would be empty and
     * every write refused. It takes the shell's place rather than sitting inside it for
     * that reason: there is nothing to navigate to yet, and the session is deliberately
     * left intact, because it is what binds the credential.
     */
    // A confirmed bind leaves immediately, whatever the sync engine still believes.
    // `bindConfirmations` is never reset: once the credential is bound it stays bound,
    // and only the server refusing again (a new account, a failed sync) sets
    // `accountIncomplete`, which is a fresh reason to be here.
    const needsBinding =
        bindConfirmations === 0 && (coreSyncState.accountIncomplete || bindRequested);
    if (coreSession.isSignedIn && needsBinding) {
        return (
            <BindCredentials
                session={coreSession}
                onDone={async () => {
                    setBindRequested(false);
                    // The bind already succeeded — it is why this callback ran — so the
                    // gate comes down on that fact alone. `syncNow` used to be the only
                    // thing that could clear it, which made a successful bind depend on a
                    // background sync it neither controls nor can observe: arrive while
                    // one is in flight and this screen stayed up, blank password field and
                    // disabled button, with nothing to say why.
                    //
                    // `bindConfirmations` is bumped here and `accountIncomplete` is
                    // re-derived below, so the shell is reached either way; the sync still
                    // runs because it is what actually pulls the records.
                    setBindConfirmations(n => n + 1);
                    await coreSyncState.syncNow();
                }}
            />
        );
    }

    return (
        <>
        <AppShell
            navItems={navItems}
            activeId={activeSection}
            onNavigate={(v) => handleViewChange(v as ViewKey)}
            navLabel="Primary"
        >
                {/* The milestone notice sits *between* the navigation and the
                    scrolling content, so it is in the shell rather than in a page.

                    In flow, not fixed: it takes its own strip of the layout, so it
                    covers no row of the page, cannot collide with the floating
                    bottom navigation (which is fixed to the viewport floor), and
                    needs no z-index dance with the rail — as a child of
                    `.m3-shell-body` it inherits the same 80px offset the content
                    does, so from 840 up it starts beside the rail rather than
                    under it. That strip is the element's own `height` and it is
                    measured from the bar and tweened on the same token the bar
                    animates in on, so the page is pushed rather than jumped. See
                    the block in index.css. */}
                <HrtMilestoneEffect
                    milestone={notice}
                    days={celebration?.days ?? 0}
                    onDone={onMilestoneDone}
                />
                <div
                    ref={mainScrollRef}
                    key={currentView}
                    className={`flex-1 flex flex-col overflow-y-auto scrollbar-hide scroll-pb-nav ${transitionDirection === 'backward' ? 'view-enter-backward' : 'view-enter-forward'}`}
                >
                    {/* Full-bleed, and each page owns its own measure: most cap at 2xl,
                        and the dashboard widens once there is a chart to show. A shared
                        cap here would fight those per-page decisions, and the sticky
                        headers inside each page need to span the column they stick
                        within. */}
                    <div className="w-full pb-10">
                    {currentView === 'home' && (
                        <Home
                            t={t}
                            currentLevel={currentLevel}
                            currentT={currentT}
                            currentStatus={currentStatus}
                            events={events}
                            simulation={simulation}
                            labResults={labResults}
                            onEditEvent={handleEditEvent}
                            calibrationFn={calibrationFn}
                            theme={theme}
                            onNavigateToHistory={() => handleViewChange('history')}
                            onNavigateToLab={() => handleViewChange('lab')}
                            onNavigateToShare={() => handleViewChange('share')}
                            /* Same reason as ShareSettings below: the share feature
                               authenticates against the Core. */
                            authToken={coreSession.token}
                            onAuthRequired={() => setIsCoreAuthOpen(true)}
                            doseTemplates={doseTemplates}
                            onAddEvent={addEvent}
                            onRemoveEvent={deleteEvent}
                            aaChartMode={aaChartMode}
                            nowMs={currentTime.getTime()}
                        />
                    )}

                    {/* Shares live on the Core, so this is the Core session's token. */}
                    {currentView === 'share' && coreSession.token && (
                        <ShareSettings
                            onBack={() => handleViewChange('home')}
                            authToken={coreSession.token}
                            mode={mode}
                            events={events}
                            simulation={simulation}
                            calibrationFn={calibrationFn}
                        />
                    )}

                    {currentView === 'history' && (
                        <History
                            t={t}
                            isQuickAddOpen={isQuickAddOpen}
                            setIsQuickAddOpen={setIsQuickAddOpen}
                            doseTemplates={doseTemplates}
                            onSaveEvent={e => {
                                if (events.find(p => p.id === e.id)) updateEvent(e);
                                else addEvent(e);
                            }}
                            onDeleteEvent={deleteEvent}
                            onAddEvents={addEvents}
                            onDeleteEvents={deleteEvents}
                            onSaveTemplate={addTemplate}
                            onDeleteTemplate={deleteTemplate}
                            groupedEvents={groupedEvents}
                        />
                    )}

                    {currentView === 'lab' && (
                        <Lab
                            t={t}
                            isQuickAddLabOpen={isQuickAddLabOpen}
                            setIsQuickAddLabOpen={setIsQuickAddLabOpen}
                            labResults={labResults}
                            events={events}
                            onSaveLabResult={r => {
                                if (labResults.find(prev => prev.id === r.id)) updateLabResult(r);
                                else addLabResult(r);
                            }}
                            onDeleteLabResult={deleteLabResult}
                            onClearLabResults={clearLabResults}
                            calibrationMethod={calibrationMethod}
                            calibration={calibration}
                            onOpenCalibrationSettings={() => handleViewChange('lab-calibration')}
                            lang={lang}
                            journal={journal}
                            onSaveJournalEntry={e => {
                                if (journal.find(p => p.id === e.id)) updateJournalEntry(e);
                                else addJournalEntry(e);
                            }}
                            onDeleteJournalEntry={deleteJournalEntry}
                            dismissedRechecks={dismissedRechecks}
                            onDismissRecheck={dismissRecheck}
                            recheckIntervals={recheckIntervals}
                            ocrModelTier={ocrModelTier}
                        />
                    )}

                    {currentView === 'lab-calibration' && (
                        <CalibrationSettings
                            method={calibrationMethod}
                            setMethod={setCalibrationMethod}
                            historyMode={calibrationHistoryMode}
                            setHistoryMode={setCalibrationHistoryMode}
                            calibration={calibration}
                            onBack={() => handleViewChange('lab')}
                        />
                    )}

                    {currentView === 'settings' && (
                        <Settings
                            t={t}
                            lang={lang}
                            setLang={setLang}
                            theme={theme}
                            setTheme={setTheme}
                            languageOptions={languageOptions}
                            onImportJson={importEventsFromJson}
                            labResults={labResults}
                            onExport={handleExportConfirm}
                            onQuickExport={handleQuickExport}
                            onClearAllEvents={clearAllEvents}
                            events={events}
                            showDialog={showDialog}
                            setIsDisclaimerOpen={setIsDisclaimerOpen}
                            onShowIntro={() => setShowOnboarding(true)}
                            onOpenLicences={() => handleViewChange('settings-licences')}
                            weight={weight}
                            setIsWeightModalOpen={setIsWeightModalOpen}
                            pkParams={pkParams}
                            onNavigateToPKParams={() => handleViewChange('pk-params')}
                            onNavigateToHRTMode={() => handleViewChange('settings-hrt-mode')}
                            onNavigateToLanguage={() => handleViewChange('settings-language')}
                            onNavigateToAppearance={() => handleViewChange('settings-appearance')}
                            onNavigateToWeight={() => handleViewChange('settings-weight')}
                            onNavigateToExport={() => handleViewChange('settings-export')}
                            onNavigateToImport={() => handleViewChange('settings-import')}
                            autoSync={autoSync}
                            setAutoSync={setAutoSync}
                            isLoggedIn={coreSession.isSignedIn}
                            aaChartMode={aaChartMode}
                            setAaChartMode={setAaChartMode}
                            recheckIntervals={recheckIntervals}
                            setRecheckIntervals={setRecheckIntervals}
                            ocrModelTier={ocrModelTier}
                            setOcrModelTier={setOcrModelTier}
                        />
                    )}

                    {currentView === 'settings-security' && (
                        <CoreAccountSettings
                            session={coreSession}
                            onBack={() => handleViewChange('account')}
                            onDeleted={() => handleViewChange('home')}
                        />
                    )}

                    {currentView === 'settings-hrt-mode' && (
                        <HRTModeSettings
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-language' && (
                        <LanguageSettings
                            lang={lang}
                            setLang={setLang}
                            languageOptions={languageOptions}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-appearance' && (
                        <AppearanceSettings
                            theme={theme}
                            setTheme={setTheme}
                            keyColor={keyColor}
                            setKeyColor={setKeyColor}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-weight' && (
                        <WeightSettings
                            weight={weight}
                            onSave={setWeight}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-export' && (
                        <ExportSettings
                            events={events}
                            labResults={labResults}
                            weight={weight}
                            onExport={handleExportConfirm}
                            onQuickExport={handleQuickExport}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-import' && (
                        <ImportSettings
                            onImportJson={importEventsFromJson}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'account' && (
                        <Account
                            session={coreSession}
                            onNavigateToSecurity={() => handleViewChange('settings-security')}
                            onNavigate={(v) => handleViewChange(v as ViewKey)}
                            syncStatus={coreSyncState.status}
                            lastSyncedAt={coreSyncState.lastSyncedAt}
                            onSyncNow={() => void coreSyncState.syncNow()}
                            /* Carried through from the X landing, which knows the
                               username X just confirmed. */
                            initialUsername={prefillUsername}
                            /* Offered by the account page while `recovery_risk` says the
                               account has one way in and it is a provider. */
                            onBindCredentials={() => setBindRequested(true)}
                            hrtStartDate={hrtStartDate}
                        />
                    )}

                    {currentView === 'settings-licences' && (
                        <LicenceSettings
                            appVersion={APP_VERSION}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-mcp' && (
                        <McpSettings
                            session={coreSession}
                            onBack={() => handleViewChange('account')}
                            onSignIn={() => setIsCoreAuthOpen(true)}
                        />
                    )}

                    {currentView === 'pk-params' && (
                        <PKParamsPage
                            pkParams={pkParams}
                            onSave={setPkParams}
                            onReset={clearPkParams}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}
                    </div>
                </div>
        </AppShell>

            <PasswordInputModal
                isOpen={isPasswordInputOpen}
                onClose={() => setIsPasswordInputOpen(false)}
                onConfirm={handlePasswordSubmit}
            />

            <WeightEditorModal
                isOpen={isWeightModalOpen}
                onClose={() => setIsWeightModalOpen(false)}
                currentWeight={weight}
                onSave={setWeight}
            />

            <DoseFormModal
                isOpen={isFormOpen}
                onClose={() => setIsFormOpen(false)}
                eventToEdit={editingEvent}
                onSave={(e: DoseEvent) => {
                    if (events.find(p => p.id === e.id)) updateEvent(e);
                    else addEvent(e);
                }}
                onDelete={deleteEvent}
                templates={doseTemplates}
                onSaveTemplate={addTemplate}
                onDeleteTemplate={deleteTemplate}
                quickDoses={quickDoses}
                onAddQuickDose={addQuickDose}
                onDeleteQuickDose={deleteQuickDose}
                events={events}
            />

            <DisclaimerModal
                isOpen={isDisclaimerOpen}
                onClose={() => setIsDisclaimerOpen(false)}
            />

            <ImportModal
                isOpen={isImportModalOpen}
                onClose={() => setIsImportModalOpen(false)}
                onImportJson={importEventsFromJson}
            />

            {/* The one sign-in in the app: the Core is what protects the records. */}
            <CoreAuthModal
                isOpen={isCoreAuthOpen}
                onClose={() => { setIsCoreAuthOpen(false); setPrefillUsername(''); }}
                session={coreSession}
                initialUsername={prefillUsername}
                onSignedIn={() => setPrefillUsername('')}
            />
        </>
    );
};

/**
 * Where the browser lands after a provider authorization.
 *
 * Path-based rather than a view key, because the server redirects to a real URL and
 * the app must recognise it on a cold load — the user arrives from the provider with no
 * app state at all. Same approach as `/share`, which has the same constraint.
 *
 * The legacy `/auth/x/setup` path is still matched: the callback no longer sends anyone
 * there, but a browser holding an older redirect should land on the same screen rather
 * than on the app shell with a spent code in the address bar.
 */
const getAuthCallbackProvider = (): 'x' | 'google' | null => {
    if (/^\/auth\/x\/(callback|setup)\/?$/.test(window.location.pathname)) return 'x';
    if (/^\/auth\/google\/callback\/?$/.test(window.location.pathname)) return 'google';
    return null;
};

const getShareRoute = (): { isShareRoute: boolean; token: string | null } => {
    if (!/^\/share\/?$/.test(window.location.pathname)) {
        return { isShareRoute: false, token: null };
    }

    const fragmentToken = window.location.hash
        .slice(1)
        .replace(/^\/+/, '')
        .split(/[/?]/, 1)[0];

    return { isShareRoute: true, token: fragmentToken || null };
};

const App = () => {
    const [shareRoute, setShareRoute] = useState(getShareRoute);
    const [authCallbackProvider, setAuthCallbackProvider] = useState(getAuthCallbackProvider);
    useEffect(() => {
        const updateRoute = () => {
            setShareRoute(getShareRoute());
            setAuthCallbackProvider(getAuthCallbackProvider());
        };
        window.addEventListener('hashchange', updateRoute);
        window.addEventListener('popstate', updateRoute);
        return () => {
            window.removeEventListener('hashchange', updateRoute);
            window.removeEventListener('popstate', updateRoute);
        };
    }, []);

    /**
     * The provider landing is reached from an external redirect, so it must be handled
     * before anything that expects app state — including the onboarding gate, which
     * would otherwise intercept a brand-new social user and hide the setup they need.
     */
    if (authCallbackProvider) {
        return (
            <LanguageProvider>
                <HRTModeProvider>
                    <DialogProvider>
                        <CoreSessionProvider>
                            <ErrorBoundary>
                                <OAuthLanding provider={authCallbackProvider} navigate={(view, options) => {
                                    // The destination is persisted, not used here: this
                                    // route renders *instead of* the app shell, so it
                                    // cannot switch views in place, and the reload below
                                    // is what brings the shell back. Without persisting it,
                                    // every button landed on Home — including the one
                                    // that continues a sign-in.
                                    setAuthLandingIntent({ view, username: options?.username });
                                    // Replace, not push: the callback URL carries a
                                    // spent one-time code, and Back must not return to
                                    // a link that cannot work twice.
                                    window.history.replaceState(null, '', '/');
                                    setAuthCallbackProvider(null);
                                    window.location.reload();
                                }} />
                            </ErrorBoundary>
                        </CoreSessionProvider>
                    </DialogProvider>
                </HRTModeProvider>
            </LanguageProvider>
        );
    }
    return (
        <LanguageProvider>
            <HRTModeProvider>
                {/* One session for the whole app, including the X landing below:
                    the callback stores a token that AppContent then reads, so two
                    instances would silently be two sessions. */}
                <CoreSessionProvider>
                    {shareRoute.isShareRoute ? (
                        <ErrorBoundary>
                            <PublicShare token={shareRoute.token} />
                        </ErrorBoundary>
                    ) : (
                        <DialogProvider>
                            <VialProvider>
                                <ErrorBoundary>
                                    <AppContent />
                                </ErrorBoundary>
                            </VialProvider>
                        </DialogProvider>
                    )}
                </CoreSessionProvider>
            </HRTModeProvider>
        </LanguageProvider>
    );
};

export default App;
