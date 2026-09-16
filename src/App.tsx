import { useState, useEffect, useMemo } from 'react';
import { useTranslation, LanguageProvider } from './contexts/LanguageContext';
import { useDialog, DialogProvider } from './contexts/DialogContext';
import { HRTModeProvider, useHRTMode } from './contexts/HRTModeContext';
import { PixelCatProvider } from './contexts/PixelCatContext';
import ErrorBoundary from './components/ErrorBoundary';
import { APP_VERSION, AppTheme } from './constants';
import { DoseEvent, decompressData, encryptData, decryptData } from '../logic';
import { parseCloudBackup } from './utils/cloudBackup';
import { useAppData } from './hooks/useAppData';
import { useAppNavigation, ViewKey } from './hooks/useAppNavigation';
import { useLiveShareSync } from './hooks/useLiveShareSync';
import { useCloudSync } from './hooks/useCloudSync';
import { useCoreSync } from './hooks/useCoreSync';

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
import { cloudService } from './services/cloud';

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
import SessionsPage from './pages/Sessions';
import TwoFactorPage from './pages/TwoFactor';
import ChangePasswordPage from './pages/ChangePassword';
import DeleteAccountPage from './pages/DeleteAccount';
import EditProfilePage from './pages/EditProfile';
import EditAvatarPage from './pages/EditAvatar';
import PKParamsPage from './pages/PKParams';
import HRTModeSettings from './pages/HRTModeSettings';
import LanguageSettings from './pages/LanguageSettings';
import AppearanceSettings from './pages/AppearanceSettings';
import WeightSettings from './pages/WeightSettings';
import ExportSettings from './pages/ExportSettings';
import ImportSettings from './pages/ImportSettings';
import TransparencySettings from './pages/TransparencySettings';
import MilkTeaEasterEgg from './pages/MilkTeaEasterEgg';
import CatStates from './pages/CatStates';
import PublicShare from './pages/PublicShare';
import ShareSettings from './pages/ShareSettings';
import Onboarding, { markOnboardingSeen, shouldShowOnboarding } from './pages/Onboarding';
import SiteNoticeBanner from './components/SiteNotice';

const AppContent = () => {
    const { t, lang, setLang } = useTranslation();
    const { showDialog } = useDialog();
    const { mode } = useHRTMode();
    const { user, token, logout, needsSetup2FA, clearSetup2FA } = useAuth();

    /**
     * The Application Core session, alongside the legacy Worker one.
     *
     * Both exist during the migration and they are not the same thing: the Core holds
     * the key to the records, the Worker session drives cloud backup and passkeys.
     * The Core is now the primary way in — it is what the server actually protects
     * records with — and the data layer below is scoped to whichever identity is
     * present, preferring Core.
     */
    const coreSession = useCoreSession();
    const [isCoreAuthOpen, setIsCoreAuthOpen] = useState(false);
    const [prefillUsername, setPrefillUsername] = useState('');
    const [twoFAEnabled, setTwoFAEnabled] = useState(false);

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
        mergeImportedData,
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
    } = useAppNavigation(user);


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

    // --- Developer mode (unlocks the milk tea easter egg) ---
    const [devMode, setDevMode] = useState<boolean>(() =>
        localStorage.getItem('app-dev-mode') === 'true'
    );
    useEffect(() => {
        localStorage.setItem('app-dev-mode', String(devMode));
    }, [devMode]);

    const [theme, setTheme] = useState<AppTheme>(() => {
        const saved = localStorage.getItem('app-theme');
        // Dark is the default, not "follow the OS". The interface is designed against
        // the dark palette — near-black surfaces and hairline separators — and that is
        // what a first visit should show. Light is one tap away in Appearance, and a
        // stored choice always wins.
        return (saved as AppTheme) || 'dark';
    });

    useEffect(() => {
        localStorage.setItem('app-auto-backup', String(autoSync));
    }, [autoSync]);

    // Two-way sync with the cloud backup: pull, reconcile, push. Replaces both
    // the upload-only auto-backup and the startup "your data differs" prompt —
    // the prompt could only add records the cloud had and this device lacked, so
    // edits and deletions stayed unresolved and it reappeared every launch.
    const syncState = useCloudSync({
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
    });

    // --- Theme Effect ---
    useEffect(() => {
        if (needsSetup2FA && user && currentView !== 'two-factor') {
            handleViewChange('two-factor');
        }
    }, [needsSetup2FA, user]);

    useEffect(() => {
        localStorage.setItem('app-theme', theme);
        const root = window.document.documentElement;

        const applyTheme = (isDark: boolean) => {
            root.classList.remove('light', 'dark');
            root.classList.add(isDark ? 'dark' : 'light');
        };

        // Mono renders as light with a grayscale filter (see html.mono in index.css)
        root.classList.toggle('mono', theme === 'mono');

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
    const handleCloudSave = async () => {
        if (!token) { setIsAuthModalOpen(true); return; }
        const outcome = await syncState.syncNow();
        // A locked cloud copy is not a failure to retry — it is a password this
        // device hasn't been given. Say so, rather than the flat "save failed"
        // that sent people pressing the button again to no effect.
        showDialog('alert', t(
            outcome === 'synced' ? 'account.cloud_save_success'
                : outcome === 'locked' ? 'account.cloud_save_locked'
                    : 'account.cloud_save_failed'));
    };

    const handleCloudLoad = async (backupId?: string) => {
        if (!token) { setIsAuthModalOpen(true); return; }
        try {
            let parsed: any;
            let timestamp: number;
            if (backupId) {
                const backup = await cloudService.loadOne(token, backupId);
                parsed = await parseCloudBackup(backup.data);
                timestamp = backup.created_at;
            } else {
                // Metadata first, then fetch only the newest body — the same
                // reason as the startup check: the plain list endpoint is
                // SELECT * and would ship every retained backup to read one.
                const metas = await cloudService.listMeta(token);
                if (!metas || metas.length === 0) {
                    showDialog('alert', t('account.no_cloud_backups'));
                    return;
                }
                const newest = metas.reduce((a, b) => (b.created_at > a.created_at ? b : a));
                const latest = await cloudService.loadOne(token, newest.id);
                parsed = await parseCloudBackup(latest.data);
                timestamp = latest.created_at;
            }
            if (!parsed) {
                showDialog('alert', t('account.cloud_load_failed'));
                return;
            }
            showDialog('confirm', (t('account.load_confirm') as string).replace('{time}', new Date(timestamp * 1000).toLocaleString()), () => {
                processImportedData(parsed);
            });
        } catch (e) {
            showDialog('alert', t('account.cloud_load_failed'));
        }
    };

    const handleCloudMerge = async (backupId: string) => {
        if (!token) { setIsAuthModalOpen(true); return; }
        try {
            const backup = await cloudService.loadOne(token, backupId);
            const parsed = await parseCloudBackup(backup.data);
            if (!parsed) {
                showDialog('alert', t('account.merge_cloud_failed'));
                return;
            }
            mergeImportedData(parsed);
        } catch (e) {
            showDialog('alert', t('account.merge_cloud_failed'));
        }
    };

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
    if (showOnboarding && !needsSetup2FA) {
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
                onViewChange={(v) => !needsSetup2FA && handleViewChange(v)}
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
                            authToken={token}
                            onAuthRequired={() => setIsAuthModalOpen(true)}
                        />
                    )}

                    {currentView === 'share' && token && (
                        <ShareSettings
                            onBack={() => handleViewChange('home')}
                            authToken={token}
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
                            onNavigateToTransparency={() => handleViewChange('settings-transparency')}
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
                            devMode={devMode}
                            setDevMode={setDevMode}
                            onNavigateToMilkTea={() => handleViewChange('settings-milk-tea')}
                            onNavigateToCatStates={() => handleViewChange('settings-cat-states')}
                            onNavigateToSecurity={() => {
                                // One entry point either way: with a Core session it
                                // opens the security page, without one it starts the
                                // sign-in that creates the session.
                                if (coreSession.isSignedIn) handleViewChange('settings-security');
                                else setIsCoreAuthOpen(true);
                            }}
                            coreSignedIn={coreSession.isSignedIn}
                            isAdmin={!!user?.isAdmin}
                            onNavigateToAdmin={() => handleViewChange('admin')}
                        />
                    )}

                    {currentView === 'settings-security' && (
                        <CoreAccountSettings
                            session={coreSession}
                            onBack={() => handleViewChange('settings')}
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
                            t={t}
                            user={user}
                            token={token}
                            onLogout={logout}
                            onCloudSave={handleCloudSave}
                            onCloudLoad={handleCloudLoad}
                            onCloudMerge={handleCloudMerge}
                            localData={{ events, labResults, doseTemplates, weight }}
                            onNavigate={(v) => handleViewChange(v as ViewKey)}
                            twoFAEnabled={twoFAEnabled}
                            onTwoFAStatusChange={setTwoFAEnabled}
                            syncStatus={syncState.status}
                            lastSyncedAt={syncState.lastSyncedAt}
                        />
                    )}

                    {currentView === 'sessions' && token && (
                        <SessionsPage
                            token={token}
                            onBack={() => handleViewChange('account')}
                        />
                    )}

                    {currentView === 'two-factor' && token && (
                        <TwoFactorPage
                            token={token}
                            enabled={twoFAEnabled}
                            onStatusChange={(v) => { setTwoFAEnabled(v); if (v) clearSetup2FA(); }}
                            onBack={() => handleViewChange('account')}
                            setupRequired={needsSetup2FA}
                        />
                    )}

                    {currentView === 'change-password' && (
                        <ChangePasswordPage
                            onBack={() => handleViewChange('account')}
                        />
                    )}

                    {currentView === 'delete-account' && (
                        <DeleteAccountPage
                            onBack={() => handleViewChange('account')}
                        />
                    )}

                    {currentView === 'edit-profile' && (
                        <EditProfilePage
                            onBack={() => handleViewChange('account')}
                        />
                    )}

                    {currentView === 'edit-avatar' && user && token && (
                        <EditAvatarPage
                            username={user.username}
                            token={token}
                            onBack={() => handleViewChange('account')}
                        />
                    )}

                    {currentView === 'settings-transparency' && (
                        <TransparencySettings
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-milk-tea' && devMode && (
                        <MilkTeaEasterEgg
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-cat-states' && devMode && (
                        <CatStates onBack={() => handleViewChange('settings')} />
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
                                'settings-transparency': 'settings',
                                'settings-milk-tea': 'settings',
                                'settings-cat-states': 'settings',
                                'pk-params': 'settings',
                                'account': 'account',
                                'sessions': 'account',
                                'two-factor': 'account',
                                // Mobile reaches admin from Settings → General, so the
                                // settings tab is the one that should read as active.
                                'admin': 'settings',
                            } as Record<string, string>)[currentView] ?? currentView;
                            const isActive = activeTab === id;
                            const isDisabled = needsSetup2FA && id !== 'two-factor';
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
                                <XAuthLanding navigate={() => {
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
                                <PixelCatProvider>
                                    <ErrorBoundary>
                                        <AppContent />
                                    </ErrorBoundary>
                                </PixelCatProvider>
                            </AuthProvider>
                        </DialogProvider>
                    )}
                </CoreSessionProvider>
            </HRTModeProvider>
        </LanguageProvider>
    );
};

export default App;
