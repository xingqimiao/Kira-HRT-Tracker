import { useState, useEffect, useMemo } from 'react';
import { useTranslation, LanguageProvider } from './contexts/LanguageContext';
import { useDialog, DialogProvider } from './contexts/DialogContext';
import { HRTModeProvider, useHRTMode } from './contexts/HRTModeContext';
import { VialProvider } from './contexts/VialContext';
import ErrorBoundary from './components/ErrorBoundary';
import { APP_VERSION, AppTheme, KeyColor } from './constants';
import { DoseEvent, decompressData, encryptData, decryptData } from '../logic';
import { useAppData } from './hooks/useAppData';
import { useAppNavigation, ViewKey } from './hooks/useAppNavigation';
import { useLiveShareSync } from './hooks/useLiveShareSync';
import { useCloudSync } from './hooks/useCloudSync';
import { useCoreSync } from './hooks/useCoreSync';
import { onAppSettingsApplied } from './utils/appSettings';
import { setXLandingIntent, takeXLandingIntent } from './utils/xLandingIntent';

import WeightEditorModal from './components/WeightEditorModal';
import DoseFormModal from './components/DoseFormModal';
import ImportModal from './components/ImportModal';
import Sidebar from './components/Sidebar';
import Icon from './components/Icon';
import PasswordInputModal from './components/PasswordInputModal';
import DisclaimerModal from './components/DisclaimerModal';
import AuthModal from './components/AuthModal';
import CoreAuthModal from './components/CoreAuthModal';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { useCoreSession, CoreSessionProvider } from './hooks/useCoreSession';

// Pages
import Home from './pages/Home';
import History from './pages/History';
import Lab from './pages/Lab';
import CalibrationSettings from './pages/CalibrationSettings';
import Settings from './pages/Settings';
import Account from './pages/Account';
import Admin from './pages/Admin';
import CoreAccountSettings from './pages/CoreAccountSettings';
import XAuthLanding from './pages/XAuthLanding';
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
import SiteNoticeBanner from './components/SiteNotice';

const AppContent = () => {
    const { t, lang, setLang } = useTranslation();
    const { showDialog } = useDialog();
    const { mode } = useHRTMode();
    const { user, token } = useAuth();

    /**
     * The Application Core session, alongside the legacy Worker one.
     *
     * Both exist during the migration and they are not the same thing: the Core holds
     * the key to the records, the Worker session drives cloud backup.
     * The Core is now the primary way in — it is what the server actually protects
     * records with — and the data layer below is scoped to whichever identity is
     * present, preferring Core.
     */
    const coreSession = useCoreSession();

    /**
     * What the X landing asked for, read once during this first render.
     *
     * State rather than an effect, and read *before* the hooks that consume it, for two
     * reasons: an effect applies the navigation after the first paint, so the user would
     * see Home flash and then Account, and it made correctness depend on declaration
     * order — the effect sat above `setPrefillUsername` and `handleViewChange`.
     *
     * `takeXLandingIntent` clears the key as it reads it, so a later manual reload does
     * not drag the user back to the Account tab.
     */
    const [xIntent] = useState(() => takeXLandingIntent());

    const [isCoreAuthOpen, setIsCoreAuthOpen] = useState(false);
    const [prefillUsername, setPrefillUsername] = useState(xIntent?.username ?? '');

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
        calibration,
        currentLevel,
        currentCPA,
        currentT,
        currentStatus,
        groupedEvents,
        addEvent, addEvents, updateEvent, deleteEvent, deleteEvents, clearAllEvents,
        addLabResult, updateLabResult, deleteLabResult, clearLabResults,
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

    useLiveShareSync({
        authToken: token,
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
    } = useAppNavigation(user, xIntent?.view);


    // --- Local UI State (Modals & Forms) ---
    const [isWeightModalOpen, setIsWeightModalOpen] = useState(false);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingEvent, setEditingEvent] = useState<DoseEvent | null>(null);
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isPasswordInputOpen, setIsPasswordInputOpen] = useState(false);
    const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
    const [isQuickAddLabOpen, setIsQuickAddLabOpen] = useState(false);
    const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
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

    // Two-way sync with the cloud backup: pull, reconcile, push. Replaces both
    // the upload-only auto-backup and the startup "your data differs" prompt —
    // the prompt could only add records the cloud had and this device lacked, so
    // edits and deletions stayed unresolved and it reappeared every launch.
    // The legacy Worker cloud backup. Still runs, but has no UI surface now that the
    // account page is Core-only — see the note in Account.tsx. Kept rather than
    // removed so an existing backup keeps being maintained; unbind the result to say
    // so honestly, instead of deleting the user data path silently.
    useCloudSync({
        token,
        userId: user?.id ?? null,
        enabled: autoSync,
        // Never touch the cloud while the data layer is mid-switch between
        // accounts or modes: the payload would mix one account's in-memory
        // records with another's storage keys.
        ready: readyScope === scope,
        buildPayload: buildExportPayload,
        applyRemote: applySyncedState,
        events,
        labResults,
        doseTemplates,
        weight,
        pkParams,
    });

    /**
     * Two-way sync against the Application Core — the path that actually stores the
     * records.
     *
     * Both sync hooks run, and they are not redundant: this one puts doses and labs
     * in the Core's structured, encrypted store (where an agent can read them and
     * where account deletion can genuinely remove them), while `useCloudSync` above
     * maintains the legacy encrypted backup blob for the existing Worker deployment.
     * They share `buildExportPayload` / `applySyncedState` and the app's own merge
     * engine, so neither duplicates the merge rules.
     *
     * Gated on `coreSession.isSignedIn`: without a Core session there is no key
     * server-side, so a push would 401 — and, worse, a *pull* would silently do
     * nothing while looking like it worked.
     */
    const coreSyncState = useCoreSync({
        token: coreSession.token,
        userId: coreSession.user?.userId ?? null,
        enabled: coreSession.isSignedIn,
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

    const languageOptions = useMemo(() => ([
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

    // Construct Nav Items again just for Sidebar prop, or reuse from hook if we exported it
    // Actually we exported navItems from useAppNavigation
    // But we need to pass them to sidebar.
    // And also reconstruct the bottom nav bar manually because it was inline in the original App.tsx
    // Let's grab navItems logic from hook or just reconstruct here?
    // The hook provides navItems.

    // Takes over the whole screen rather than sitting in the view stack: the
    // intro is where language and HRT mode get chosen, and leaving the nav up
    // would let someone tab away with both still on their defaults. Yields to a
    // forced 2FA setup, which is the one thing that can't wait behind a tour.
    if (showOnboarding) {
        return (
            <Onboarding
                languageOptions={languageOptions}
                onDone={() => { markOnboardingSeen(); setShowOnboarding(false); }}
            />
        );
    }

    return (
        <div className="h-[100dvh] w-full bg-[var(--color-m3-surface)] flex flex-col font-sans text-[var(--color-m3-on-surface)] select-none overflow-hidden">
            <Sidebar
                navItems={navItems}
                currentView={currentView}
                onViewChange={(v) => handleViewChange(v)}
            />
            <div className="flex-1 flex flex-col overflow-hidden w-full bg-[var(--color-m3-surface-dim)]  relative">

                {/* The host, shown only where the browser chrome does not already say
                    it: this app is reachable on more than one domain, and which one you
                    are on decides where the data goes. On a phone that is worth 11px of
                    vertical space; in a desktop window the address bar says it. */}
                <div className="md:hidden shrink-0 pt-[env(safe-area-inset-top,0px)] pb-1 text-center text-[0.6875rem] font-medium tracking-wide text-muted select-none">
                    {window.location.hostname}
                </div>

                {/* Operator banner. Outside the scroller and keyed off nothing in
                    this component, so it stays put across view changes. */}
                <SiteNoticeBanner />

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
                            currentCPA={currentCPA}
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
                            onAuthRequired={() => setIsAuthModalOpen(true)}
                        />
                    )}

                    {/* Shares live on the Core, so this is the Core session's token.
                        It was given the Worker token, which is a separate identity — a
                        user signed in to the Core was asked to sign in again. */}
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
                            appVersion={APP_VERSION}
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
                            isLoggedIn={!!user}
                            isAdmin={!!user?.isAdmin}
                            onNavigateToAdmin={() => handleViewChange('admin')}
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

                    {currentView === 'admin' && user?.isAdmin && (
                        <Admin />
                    )}
                    </div>
                </div>

                {/* Bottom Navigation — floating island */}
                <nav className="fixed left-4 right-4 bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))] z-40 md:hidden rounded-2xl bg-[var(--color-m3-surface-bright)]  border border-[var(--color-m3-outline-variant)]  shadow-[var(--shadow-m3-3)]">
                    <div className="flex items-stretch p-1.5 gap-1">
                        {navItems.filter(item => item.id !== 'admin').map(({ id, icon, label }) => {
                            const activeTab = ({
                                'home': 'home',
                                'history': 'history',
                                'lab': 'lab',
                                'lab-calibration': 'lab',
                                'settings': 'settings',
                                'settings-hrt-mode': 'settings',
                                'settings-language': 'settings',
                                'settings-appearance': 'settings',
                                'settings-weight': 'settings',
                                'settings-export': 'settings',
                                'settings-import': 'settings',
                                'settings-mcp': 'account',
                                'settings-licences': 'settings',
                                'pk-params': 'settings',
                                'account': 'account',
                                'sessions': 'account',
                                'two-factor': 'account',
                                // Mobile reaches admin from Settings → General, so the
                                // settings tab is the one that should read as active.
                                'admin': 'settings',
                            } as Record<string, string>)[currentView] ?? currentView;
                            const isActive = activeTab === id;
                            const isDisabled = false;
                            return (
                                <button
                                    key={id}
                                    onClick={() => !isDisabled && handleViewChange(id as ViewKey)}
                                    disabled={isDisabled}
                                    className={`flex-1 flex flex-col items-center justify-center gap-1 py-1.5 transition-colors duration-150 motion-reduce:transition-none
                                        ${isDisabled
                                            ? 'text-[var(--color-m3-outline)]  cursor-not-allowed'
                                            : isActive
                                            ? 'text-body'
                                            : 'text-muted'
                                        }`}
                                >
                                    <Icon icon={icon} size={20} strokeWidth={isActive ? 1.9 : 1.75} />
                                    <span className="text-[0.625rem] font-medium">
                                        {label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </nav>
            </div>

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

            <AuthModal
                isOpen={isAuthModalOpen}
                onClose={() => setIsAuthModalOpen(false)}
            />

            {/* The Core sign-in. Rendered alongside the legacy modal during the
                migration: the Core is what actually protects records, and this is the
                flow with the mandatory second factor. */}
            <CoreAuthModal
                isOpen={isCoreAuthOpen}
                onClose={() => { setIsCoreAuthOpen(false); setPrefillUsername(''); }}
                session={coreSession}
                initialUsername={prefillUsername}
                onSignedIn={() => setPrefillUsername('')}
            />
        </div >
    );
};

/**
 * Where the browser lands after an X authorization.
 *
 * Path-based rather than a view key, because the server redirects to a real URL and
 * the app must recognise it on a cold load — the user arrives from X with no app state
 * at all. Same approach as `/share`, which has the same constraint.
 */
const isXAuthRoute = (): boolean =>
    /^\/auth\/x\/(callback|setup)\/?$/.test(window.location.pathname);

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
    const [xAuthRoute, setXAuthRoute] = useState(isXAuthRoute);
    useEffect(() => {
        const updateRoute = () => {
            setShareRoute(getShareRoute());
            setXAuthRoute(isXAuthRoute());
        };
        window.addEventListener('hashchange', updateRoute);
        window.addEventListener('popstate', updateRoute);
        return () => {
            window.removeEventListener('hashchange', updateRoute);
            window.removeEventListener('popstate', updateRoute);
        };
    }, []);

    /**
     * The X landing is reached from an external redirect, so it must be handled
     * before anything that expects app state — including the onboarding gate, which
     * would otherwise intercept a brand-new X user and hide the setup they need.
     */
    if (xAuthRoute) {
        return (
            <LanguageProvider>
                <HRTModeProvider>
                    <DialogProvider>
                        <AuthProvider>
                            <CoreSessionProvider>
                            <ErrorBoundary>
                                <XAuthLanding navigate={(view, options) => {
                                    // The destination is persisted, not used here: this
                                    // route renders *instead of* the app shell, so it
                                    // cannot switch views in place, and the reload below
                                    // is what brings the shell back. Without persisting it,
                                    // every button landed on Home — including the one
                                    // that continues a sign-in.
                                    setXLandingIntent({ view, username: options?.username });
                                    // Replace, not push: the callback URL carries a
                                    // spent one-time code, and Back must not return to
                                    // a link that cannot work twice.
                                    window.history.replaceState(null, '', '/');
                                    setXAuthRoute(false);
                                    window.location.reload();
                                }} />
                            </ErrorBoundary>
                            </CoreSessionProvider>
                        </AuthProvider>
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
                            <AuthProvider>
                                <VialProvider>
                                    <ErrorBoundary>
                                        <AppContent />
                                    </ErrorBoundary>
                                </VialProvider>
                            </AuthProvider>
                        </DialogProvider>
                    )}
                </CoreSessionProvider>
            </HRTModeProvider>
        </LanguageProvider>
    );
};

export default App;
