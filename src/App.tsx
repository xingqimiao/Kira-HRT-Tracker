import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { SvgDefs } from './ui/SvgDefs';
import { PrototypeShell, type ShellFab } from './ui/PrototypeShell';
import { useViewportMode } from './ui/useViewportMode';
import { usePressMorph } from './ui/usePressMorph';
import { useTranslation, LanguageProvider } from './contexts/LanguageContext';
import { useDialog, DialogProvider } from './contexts/DialogContext';
import { HRTModeProvider, useHRTMode } from './contexts/HRTModeContext';
import ErrorBoundary from './components/ErrorBoundary';
import { APP_VERSION, AppTheme, ChartStyle, KeyColor, normalizeChartStyle } from './constants';
import { DoseEvent, decompressData, encryptData, decryptData } from '../logic';
import { detectForeignFormat, convertForeignPayload, type ForeignSource } from './utils/foreignImport';
import { importGelProducts } from './utils/gelProducts';
import { decryptFeatherline, mapFeatherlineSnapshot, FeatherlineError } from './utils/featherlineBackup';
import type { Lang } from './i18n/types';
import { useAppData } from './hooks/useAppData';
import { useAppNavigation, ViewKey } from './hooks/useAppNavigation';
import { useLiveShareSync } from './hooks/useLiveShareSync';
import { useCoreSync } from './hooks/useCoreSync';
import { onAppSettingsApplied } from './utils/appSettings';
import { saveTextFile } from './utils/saveFile';
import { get as secureGet, set as secureSet } from './utils/secureStore';
import { setAuthLandingIntent, takeAuthLandingIntent } from './utils/authLandingIntent';

import WeightEditorModal from './components/WeightEditorModal';
import DoseFormModal from './components/DoseFormModal';
import { Bookmark, Plus, Scan } from './icons';
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
import UpdateNotice from './components/UpdateNotice';
import BindCredentials from './pages/BindCredentials';
import OAuthLanding from './pages/OAuthLanding';
import PKParamsPage from './pages/PKParams';
import LanguageSettings from './pages/LanguageSettings';
import AppearanceSettings from './pages/AppearanceSettings';
import WeightSettings from './pages/WeightSettings';
import ExportSettings from './pages/ExportSettings';
import ImportSettings from './pages/ImportSettings';
import LicenceSettings from './pages/LicenceSettings';
import DonateSettings from './pages/DonateSettings';
import SupportersList from './pages/SupportersList';
import McpSettings from './pages/McpSettings';
import PublicShare from './pages/PublicShare';
import ShareSettings from './pages/ShareSettings';
import Onboarding, { markOnboardingSeen, shouldShowOnboarding } from './pages/Onboarding';
import HrtMilestoneEffect from './components/HrtMilestoneEffect';
import { armMilestone, clearArmedMilestone, type MilestoneNotice } from './utils/hrtMilestone';
import SplashScreen from './components/SplashScreen';
import { isNativeApp } from './utils/platform';
import {
    migrateOldRemindersToPlans,
    reschedulePlanNotifications,
    startPlanWebNotifications,
    registerDoseSource,
    setPlanNotificationLanguage,
} from './utils/medPlanNotify';
import { installNativeBack, useBackHandler } from './utils/nativeBack';
import { installNativeLinkInterceptor } from './utils/externalLinks';
import { syncPushRegistration } from './utils/pushRegister';
import { isPlanNotificationGranted } from './utils/medPlanNotify';

const AppContent = () => {
    const { t, lang, setLang } = useTranslation();
    const { showDialog } = useDialog();
    const { mode } = useHRTMode();

    // The prototype's two shells (bottom bar / 96px rail) and its press morph are
    // document-level behaviours, so they are installed once here rather than in
    // each screen.
    useViewportMode();
    usePressMorph();

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
        pkEngine, setPkEngine,
        engineInUse,
        pendingMilestone,
        showStreakNotice, dismissStreakNotice,
        calibration,
        calibrateFor,
        currentLevel,
        currentT,
        currentStatus,
        dosePeaks,
        currentTime,
        groupedEvents,
        addEvent, updateEvent, deleteEvent, deleteEvents, clearAllEvents,
        addLabResult, updateLabResult, deleteLabResult, clearLabResults,
        journal, addJournalEntry, updateJournalEntry, deleteJournalEntry,
        dismissedRechecks, dismissRecheck,
        addTemplate, deleteTemplate,
        addQuickDose, deleteQuickDose,
        quickDoses,
        pkParams, setPkParams, clearPkParams,
        medPlan,
        processImportedData,
        buildExportPayload,
        applySyncedState,
        scope,
        readyScope,
    } = useAppData(showDialog, coreSession.user?.userId ?? null);

    // The locked cold start plays the splash in index.tsx, before App may mount;
    // the flag keeps this overlay from replaying it on top of the unlock hand-over.
    const [splashDone, setSplashDone] = useState(
        () => !isNativeApp() || Boolean((window as unknown as { __HRT_SPLASH_DONE__?: boolean }).__HRT_SPLASH_DONE__),
    );

    // The medication-plan notifier reads today's doses through a getter, not a
    // captured array: the interval registered here must see every re-render's
    // events, so a ref carries the live value across its 60-second ticks.
    const eventsRef = useRef(events);
    eventsRef.current = events;
    useEffect(() => {
        registerDoseSource(() => eventsRef.current);
        migrateOldRemindersToPlans();
        void reschedulePlanNotifications().catch(e => console.error('[med-plan] reschedule failed', e));
        startPlanWebNotifications();
        const refresh = () => {
            if (document.visibilityState === 'visible') {
                void reschedulePlanNotifications().catch(e => console.error('[med-plan] reschedule failed', e));
            }
        };
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
        window.addEventListener('hrt-mode-changed', refresh);
        return () => {
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('focus', refresh);
            window.removeEventListener('hrt-mode-changed', refresh);
        };
    }, []);

    // Keep the device's FCM token bound to the signed-in account, so a catch-up
    // nudge can reach it. Runs when the account changes: FCM rotates the token
    // rarely, so re-registering is cheap and a missing token (first launch,
    // rotation) is the case that matters. Both transports bind here — native via the
    // Android bridge, web via the Firebase SDK; `syncPushRegistration` is a no-op
    // when notifications are not granted or web push is unconfigured.
    useEffect(() => {
        if (!coreSession.token) return;
        void isPlanNotificationGranted()
            .then(granted => (granted ? syncPushRegistration(coreSession.token as string) : undefined))
            .catch(() => undefined);
    }, [coreSession.token]);

    // Notifications that draw outside React (a scheduled native ring, an FCM nudge
    // the OS hands to the native service or the worker) must follow the app's
    // language setting. Bind the translator and push the resolved fallbacks to each
    // transport, then re-schedule the native reminders so any already-queued ones
    // pick up the new language rather than firing in the old one.
    //
    // Keyed on the resolved strings, not on `lang`: on a cold start in a
    // non-Chinese language the pack is still downloading, so the first render's `t`
    // answers from the `zh` fallback — a `[lang]` effect would push Chinese and never
    // correct itself, because `lang` does not change when the pack lands (the context
    // repaints instead). Watching the values re-pushes when the real pack arrives.
    const notifFallbackSig = useRef('');
    useEffect(() => {
        const sig = `${t('plan.notify_title')}\u0000${t('plan.notify_body')}`;
        if (sig === notifFallbackSig.current) return;
        notifFallbackSig.current = sig;
        setPlanNotificationLanguage(t);
        void reschedulePlanNotifications().catch(() => undefined);
    });

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

    const initialView = landingIntent?.view || (new URLSearchParams(window.location.search).get('view') as ViewKey | null) || 'home';
    const {
        currentView,
        transitionDirection,
        handleViewChange,
        mainScrollRef,
        navItems,
    } = useAppNavigation(initialView);


    // --- Local UI State (Modals & Forms) ---
    const [isWeightModalOpen, setIsWeightModalOpen] = useState(false);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingEvent, setEditingEvent] = useState<DoseEvent | null>(null);
    const [isPasswordInputOpen, setIsPasswordInputOpen] = useState(false);
    const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
    const [isQuickAddLabOpen, setIsQuickAddLabOpen] = useState(false);
    // The overview's FAB opens the saved-dose sheet; the page owns its contents.
    const [quickRecordOpen, setQuickRecordOpen] = useState(false);
    // The checkup FAB's scan entry opens a full-screen scanner page. Manual add
    // and scan are siblings, not one form with a scan panel inside it.
    const [isLabScanOpen, setIsLabScanOpen] = useState(false);
    // A form opened from the lab FAB must not survive a tab change: the flag is
    // shell state, so coming back to 体检 used to pop the add form unasked.
    useEffect(() => {
        if (currentView === 'lab') return;
        setIsQuickAddLabOpen(false);
        setIsLabScanOpen(false);
    }, [currentView]);
    const [isDisclaimerOpen, setIsDisclaimerOpen] = useState(false);
    /**
     * A file waiting on a password.
     *
     * Two kinds, because they need different decrypt paths: a JSON envelope (ours,
     * Oyama's, Transmtf's) is text handed to `decryptData`, while a Featherline
     * backup is a binary container whose Argon2/AES work lives in its own module.
     * The bytes are held rather than re-read because a File cannot be re-read from a
     * state setter.
     */
    const [pendingImport, setPendingImport] = useState<
        { kind: 'json'; text: string } | { kind: 'featherline'; bytes: Uint8Array } | null
    >(null);

    // --- Auto-sync preference ---
    // Storage key kept from when this only ever uploaded, so an existing
    // preference carries over rather than silently resetting to on.
    const [autoSync, setAutoSync] = useState<boolean>(() =>
        secureGet('app-auto-backup') !== 'false'
    );

    // --- First run ---
    const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding);
    // True when the intro was opened from Settings rather than shown on a first
    // run. A replay is a re-read, not a setup: it must not write back to the
    // account — chiefly the start-date step, where tapping the picker would
    // otherwise overwrite a real date the user set long ago.
    const [replayOnboarding, setReplayOnboarding] = useState(false);

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

    // Personalization: how the chart draws the primary series. Same shape as theme
    // above — a storage key, an adoption on sync, and a normaliser for a value this
    // build may not know.
    const [chartStyle, setChartStyle] = useState<ChartStyle>(() =>
        normalizeChartStyle(secureGet('app-chart-style'))
    );
    // Whole numbers by default — "8" not "8.8". Opt in to the decimal place.
    const [readingDecimals, setReadingDecimals] = useState<boolean>(() =>
        secureGet('app-reading-decimals') === 'true'
    );
    // Whether the overview hides the anti-androgen reading. Off by default.
    const [hideAA, setHideAA] = useState<boolean>(() =>
        secureGet('app-hide-aa') === 'true'
    );

    useEffect(() => {
        localStorage.setItem('app-key-color', keyColor);
        // A class rather than inline variables: the light/dark readings live in
        // stylesheet blocks, and this only has to select which pair is in force.
        window.document.documentElement.classList.toggle('key-blue', keyColor === 'blue');
    }, [keyColor]);

    useEffect(() => {
        secureSet('app-chart-style', chartStyle);
    }, [chartStyle]);

    useEffect(() => {
        secureSet('app-reading-decimals', String(readingDecimals));
    }, [readingDecimals]);

    useEffect(() => {
        secureSet('app-hide-aa', String(hideAA));
    }, [hideAA]);

    // Adopt theme and key colour when a sync brings the account's choices in.
    // Each value is validated against what this build understands before being
    // taken, so a payload from a newer version cannot set a theme it has no
    // palette for.
    useEffect(() => onAppSettingsApplied(() => {
        const savedTheme = localStorage.getItem('app-theme');
        if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') setTheme(savedTheme);
        setKeyColor(localStorage.getItem('app-key-color') === 'blue' ? 'blue' : 'pink');
        setChartStyle(normalizeChartStyle(secureGet('app-chart-style')));
        setReadingDecimals(secureGet('app-reading-decimals') === 'true');
        setHideAA(secureGet('app-hide-aa') === 'true');
    }), []);

    useEffect(() => {
        secureSet('app-auto-backup', String(autoSync));
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
        journal,
        quickDoses,
        weight,
        pkParams,
        medPlan,
        calibrationMethod,
        calibrationHistoryMode,
        aaChartMode,
        hrtStartDate,
        recheckIntervals,
        ocrModelTier,
        pkEngine,
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
        const shouldLock = isPasswordInputOpen || isWeightModalOpen || isFormOpen || isDisclaimerOpen;
        document.body.style.overflow = shouldLock ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
    }, [isPasswordInputOpen, isWeightModalOpen, isFormOpen, isDisclaimerOpen]);

    // Android system back closes the topmost overlay. Registered after the
    // navigation handler (declared later wins the top of the stack), and the
    // dialog provider above this closes dialogs before modals.
    useBackHandler(isQuickAddOpen, () => { setIsQuickAddOpen(false); return true; });
    useBackHandler(isQuickAddLabOpen, () => { setIsQuickAddLabOpen(false); return true; });
    useBackHandler(quickRecordOpen, () => { setQuickRecordOpen(false); return true; });
    useBackHandler(isPasswordInputOpen, () => { setIsPasswordInputOpen(false); return true; });
    useBackHandler(isWeightModalOpen, () => { setIsWeightModalOpen(false); return true; });
    useBackHandler(isFormOpen, () => { setIsFormOpen(false); return true; });
    useBackHandler(isDisclaimerOpen, () => { setIsDisclaimerOpen(false); return true; });
    useBackHandler(isCoreAuthOpen, () => { setIsCoreAuthOpen(false); setPrefillUsername(''); return true; });

    // Native shell wiring: system back dispatch and system-browser links.
    useEffect(() => installNativeBack(), []);
    useEffect(() => installNativeLinkInterceptor(), []);


    /**
     * Convert a payload that has been decrypted or was never encrypted, and hand it
     * to the merge. Shared by the plain path and the post-password path so a
     * converted foreign file and a native one cannot take different routes.
     *
     * `source` is only used for what the user is told: an Oyama or Kira file needs no
     * transformation (the fork means the shapes already agree), a Transmtf file needs
     * its unsupported `gelProducts` dropped and reported.
     */
    const applyImportedPayload = (parsed: unknown, source: ForeignSource | null): boolean => {
        const { payload, gelProducts } = convertForeignPayload(parsed, source ?? 'kira');
        const ok = processImportedData(payload);
        // The custom gel catalogue is account data in its own right — merged after
        // the records so a product can never be imported "for" a record that then
        // failed to land.
        if (ok && gelProducts) {
            const merged = importGelProducts(gelProducts);
            const n = merged.added + merged.updated;
            if (n > 0) showDialog('alert', t('import.gel_products_imported').replace('{n}', String(n)));
        }
        return ok;
    };

    /**
     * Counts an import before it is applied.
     *
     * This is the same detection the real import runs, stopping one step short of
     * `processImportedData`: the payload is converted (so a foreign file is counted
     * in this app's own terms) but nothing is written. `null` means the count is
     * not knowable yet — a password-protected or binary backup — and the modal
     * then imports directly rather than promising a preview it cannot produce.
     */
    const previewImport = async (input: string | ArrayBuffer): Promise<{ source: string; doses: number; labs: number } | null> => {
        try {
            const detection = detectForeignFormat(input);
            if (detection.source === 'featherline' || detection.problem === 'unreadable') return null;

            let parsed: any = detection.parsed;
            if (parsed && typeof parsed === 'object' && typeof parsed.c === 'string') {
                parsed = JSON.parse(await decompressData(parsed.c));
            }
            if (parsed && parsed.encrypted && parsed.iv && parsed.salt && parsed.data) return null;

            const source = detection.source ?? detectForeignFormat(JSON.stringify(parsed)).source;
            const { payload } = convertForeignPayload(parsed, source ?? 'kira');
            const counted = payload as { events?: unknown[]; labResults?: unknown[] };
            return {
                source: source ?? 'kira',
                doses: counted.events?.length ?? 0,
                labs: counted.labResults?.length ?? 0,
            };
        } catch {
            return null;
        }
    };

    const importEventsFromJson = async (input: string | ArrayBuffer): Promise<boolean> => {
        try {
            const detection = detectForeignFormat(input);

            // A Featherline backup is a binary envelope, so it has no JSON to inspect:
            // it goes straight to the password prompt, and its Argon2/decrypt path
            // runs in `handlePasswordSubmit`.
            if (detection.source === 'featherline' && detection.bytes) {
                setPendingImport({ kind: 'featherline', bytes: detection.bytes });
                setIsPasswordInputOpen(true);
                return true;
            }

            if (detection.problem === 'unreadable') {
                showDialog('alert', t('drawer.import_error'));
                return false;
            }

            let parsed: any = detection.parsed;

            // Handle Compression
            if (parsed && typeof parsed === 'object' && typeof parsed.c === 'string') {
                parsed = JSON.parse(await decompressData(parsed.c));
            }

            // Handle Encryption. This now also catches Oyama's and Transmtf's
            // password envelopes: both use the `encrypted`/`iv`/`salt`/`data` keys
            // this guard looks for, and `decryptData` reads Transmtf's 100000
            // iterations through its own default. The branch is unchanged in
            // behaviour; the *output* is what the conversion below adds.
            if (parsed && parsed.encrypted && parsed.iv && parsed.salt && parsed.data) {
                setPendingImport({ kind: 'json', text: JSON.stringify(parsed) });
                setIsPasswordInputOpen(true);
                return true;
            }

            // Re-detect on the decompressed object: a compressed envelope hid the
            // real shape from the first pass.
            const source = detection.source ?? detectForeignFormat(JSON.stringify(parsed)).source;
            return applyImportedPayload(parsed, source);
        } catch (err) {
            console.error(err);
            showDialog('alert', t('drawer.import_error'));
            return false;
        }
    };

    const handlePasswordSubmit = async (password: string) => {
        if (!pendingImport) return;
        try {
            // Featherline: Argon2id + AES-GCM over gzip(JSON), decrypted and mapped
            // in its own module — the only source whose file is not JSON.
            if (pendingImport.kind === 'featherline') {
                if (!pendingImport.bytes) return;
                const json = await decryptFeatherline(pendingImport.bytes, password);
                const mapped = mapFeatherlineSnapshot(json);
                const ok = processImportedData(mapped);
                if (ok) {
                    setIsPasswordInputOpen(false);
                    setPendingImport(null);
                    const reasons = mapped.skipped.reasons;
                    if (reasons.length > 0) {
                        showDialog('alert', t('import.skipped_rows')
                            .replace('{n}', String(mapped.skipped.doses + mapped.skipped.labs))
                            .replace('{why}', reasons.join('; ')));
                    }
                } else {
                    showDialog('alert', t('import.decrypt_error'));
                }
                return;
            }

            if (!pendingImport.text) return;
            const decrypted = await decryptData(pendingImport.text, password);
            if (!decrypted) {
                showDialog('alert', t('import.decrypt_error'));
                return;
            }
            let parsed = JSON.parse(decrypted);
            // Handle Compression after decryption
            if (parsed && typeof parsed === 'object' && typeof parsed.c === 'string') {
                parsed = JSON.parse(await decompressData(parsed.c));
            }
            // The plaintext inside the envelope is where the source finally becomes
            // knowable, so it is detected here rather than from the envelope.
            const source = detectForeignFormat(JSON.stringify(parsed)).source;
            if (applyImportedPayload(parsed, source)) {
                setIsPasswordInputOpen(false);
                setPendingImport(null);
            }
        } catch (e) {
            console.error(e);
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
        saveTextFile(filename, 'application/json', data);
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

    // The splash is an overlay, not a gate: whatever screen is next — onboarding,
    // the bind gate, the shell — mounts underneath it while the fill plays, so the
    // frame after the vial settles is already a live screen. The old early return
    // (and its 600 ms hold) made the app boot only after the splash ended.
    //
    // The hand-over is the app fading IN, and only that — the splash does not fade
    // itself out (see SplashScreen). Fading both at once cross-fades two things and
    // reads as the vial ghosting away rather than as the app arriving. On web there is
    // no splash (`splashDone` starts true), so the reveal is a no-op there.
    const splash = !splashDone ? (
        <SplashScreen mode={mode} onDone={() => setSplashDone(true)} />
    ) : null;
    const revealStyle: React.CSSProperties = isNativeApp()
        ? {
            opacity: splashDone ? 1 : 0,
            transition: 'opacity 300ms var(--md-sys-motion-easing-emphasized-decelerate, cubic-bezier(0.2,0,0,1))',
        }
        : {};

    // Takes over the whole screen rather than sitting in the view stack: the
    // intro is where language and HRT mode get chosen, and leaving the nav up
    // would let someone tab away with both still on their defaults.
    if (showOnboarding) {
        return (
            <>
            {splash}
            <div style={revealStyle}>
            <Onboarding
                languageOptions={languageOptions}
                /* So the start-date step opens on whatever is already saved, and
                   writes through the data layer that knows the account. */
                hrtStartDate={hrtStartDate}
                onHrtStartChange={setHrtStartDate}
                weight={weight}
                onWeightChange={setWeight}
                /* The same pipeline the data screen uses, so the intro's import row
                   reads the same backups — including the password prompt an
                   encrypted one opens. */
                onImportJson={importEventsFromJson}
                /* On a replay the step above goes read-only — see `replayOnboarding`. */
                replay={replayOnboarding}
                onDone={() => { markOnboardingSeen(); setShowOnboarding(false); setReplayOnboarding(false); }}
            />
            </div>
            </>
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
            <>
            {splash}
            <div style={revealStyle}>
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
            </div>
            </>
        );
    }

    // Which destination has a primary action, and what it does. Settings and
    // Which destination has a primary action, and what it does. Settings and
    // account have none — the shell shows the tube logo in the rail slot instead.
    const shellFab = (view: ViewKey): ShellFab | null => {
        switch (view) {
            case 'home':
                return {
                    label: t('quickadd.button'),
                    icon: 'mark',
                    onClick: () => setQuickRecordOpen(true),
                };
            case 'history':
                return {
                    label: t('timeline.add_title'),
                    icon: 'plus',
                    onClick: () => setIsQuickAddOpen(true),
                };
            case 'lab':
                return {
                    label: t('lab.add_title'),
                    icon: 'plus',
                    menu: [
                        {
                            label: t('scan.title'),
                            icon: 'scan',
                            onClick: () => setIsLabScanOpen(true),
                        },
                        {
                            label: t('lab.add_title'),
                            icon: 'plus',
                            onClick: () => setIsQuickAddLabOpen(true),
                        },
                    ],
                };
            default:
                return null;
        }
    };

    return (
        <>
        {splash}
        <div style={revealStyle}>
        <PrototypeShell
            items={navItems.map(item => ({ id: item.id, label: item.label }))}
            activeId={activeSection}
            onNavigate={(v) => handleViewChange(v as ViewKey)}
            scrollRef={mainScrollRef}
            fab={quickRecordOpen ? null : shellFab(currentView)}
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
                    key={currentView}
                    className={`flex-1 flex flex-col ${transitionDirection === 'backward' ? 'view-enter-backward' : 'view-enter-forward'}`}
                >
                    {/* Full-bleed, and each page owns its own measure: most cap at 2xl,
                        and the dashboard widens once there is a chart to show. A shared
                        cap here would fight those per-page decisions, and the sticky
                        headers inside each page need to span the column they stick
                        within. */}
                    <div className="w-full flex-1 flex flex-col pb-10">
                    {currentView === 'home' && (
                        <Home
                            t={t}
                            currentLevel={currentLevel}
                            currentT={currentT}
                            currentStatus={currentStatus}
                            dosePeaks={dosePeaks}
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
                            chartStyle={chartStyle}
                            readingDecimals={readingDecimals}
                            hideAA={hideAA}
                            quickRecordOpen={quickRecordOpen}
                            onQuickRecordClose={() => setQuickRecordOpen(false)}
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
                            onDeleteEvents={deleteEvents}
                            onSaveTemplate={addTemplate}
                            onDeleteTemplate={deleteTemplate}
                            groupedEvents={groupedEvents}
                            activeEngine={engineInUse}
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
                            isScanOpen={isLabScanOpen}
                            setIsScanOpen={setIsLabScanOpen}
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
                            onShowIntro={() => { setReplayOnboarding(true); setShowOnboarding(true); }}
                            onOpenLicences={() => handleViewChange('settings-licences')}
                            onOpenDonate={() => handleViewChange('settings-donate')}
                            weight={weight}
                            setIsWeightModalOpen={setIsWeightModalOpen}
                            pkParams={pkParams}
                            onNavigateToPKParams={() => handleViewChange('pk-params')}
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
                            hideAA={hideAA}
                            setHideAA={setHideAA}
                            recheckIntervals={recheckIntervals}
                            setRecheckIntervals={setRecheckIntervals}
                            dismissedRechecks={dismissedRechecks}
                            onDismissRecheck={dismissRecheck}
                            ocrModelTier={ocrModelTier}
                            setOcrModelTier={setOcrModelTier}
                            pkEngine={pkEngine}
                            setPkEngine={setPkEngine}
                            engineInUse={engineInUse}
                            calibrationMethod={calibrationMethod}
                            setCalibrationMethod={setCalibrationMethod}
                            calibrationHistoryMode={calibrationHistoryMode}
                            setCalibrationHistoryMode={setCalibrationHistoryMode}
                            calibration={calibration}
                            doseTemplates={doseTemplates}
                        />
                    )}

                    {currentView === 'settings-security' && (
                        <CoreAccountSettings
                            session={coreSession}
                            onBack={() => handleViewChange('account')}
                            onDeleted={() => handleViewChange('home')}
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
                            chartStyle={chartStyle}
                            setChartStyle={setChartStyle}
                            readingDecimals={readingDecimals}
                            setReadingDecimals={setReadingDecimals}
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
                            onPreview={previewImport}
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
                            onHrtStartChange={setHrtStartDate}
                        />
                    )}

                    {currentView === 'settings-licences' && (
                        <LicenceSettings
                            appVersion={APP_VERSION}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-donate' && (
                        <DonateSettings
                            onBack={() => handleViewChange('settings')}
                            onOpenSupporters={() => handleViewChange('settings-donate-supporters')}
                        />
                    )}

                    {currentView === 'settings-donate-supporters' && (
                        <SupportersList onBack={() => handleViewChange('settings-donate')} />
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
                            engine={engineInUse}
                        />
                    )}
                    </div>
                </div>
        </PrototypeShell>
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
                activeEngine={engineInUse}
            />

            <DisclaimerModal
                isOpen={isDisclaimerOpen}
                onClose={() => setIsDisclaimerOpen(false)}
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
    // Two shapes, both live: `/share#<token>` is what older builds handed out, and
    // `/share/<token>` is what the Core returns today. The path form is the one a
    // link copied from the app uses, so it has to be recognised here — otherwise
    // the SPA renders the app shell over a shared record.
    const match = /^\/share(?:\/([^/?#]+))?\/?$/.exec(window.location.pathname);
    if (!match) {
        return { isShareRoute: false, token: null };
    }

    const pathToken = match[1] ?? '';
    const fragmentToken = window.location.hash
        .slice(1)
        .replace(/^\/+/, '')
        .split(/[/?]/, 1)[0];

    return { isShareRoute: true, token: pathToken || fragmentToken || null };
};

const App = () => {
    const [shareRoute, setShareRoute] = useState(getShareRoute);
    const [authCallbackProvider, setAuthCallbackProvider] = useState(getAuthCallbackProvider);
    useEffect(() => {
        const updateRoute = () => {
            setShareRoute(getShareRoute());
            setAuthCallbackProvider(getAuthCallbackProvider());
        };
        const onNativeOAuthCallback = (event: Event) => {
            const raw = (event as CustomEvent<string>).detail;
            if (typeof raw !== 'string') return;
            try {
                const callback = new URL(raw);
                if (callback.protocol !== 'kira-hrt:' || callback.hostname !== 'oauth') return;
                const provider = callback.searchParams.get('provider');
                if (provider !== 'x' && provider !== 'google') return;
                const query = callback.search;
                window.history.replaceState(null, '', `/auth/${provider}/callback${query}`);
                updateRoute();
            } catch {
                // Ignore malformed deep links from other apps.
            }
        };
        window.addEventListener('hashchange', updateRoute);
        window.addEventListener('popstate', updateRoute);
        window.addEventListener('hrt-oauth-callback', onNativeOAuthCallback);
        return () => {
            window.removeEventListener('hashchange', updateRoute);
            window.removeEventListener('popstate', updateRoute);
            window.removeEventListener('hrt-oauth-callback', onNativeOAuthCallback);
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
                {/* The prototype sprite, mounted once for the whole tree: every
                    icon is `<svg class="i"><use href="#id"/></svg>`. */}
                <SvgDefs />
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
                            <ErrorBoundary>
                                <AppContent />
                            </ErrorBoundary>
                        </DialogProvider>
                    )}
                    {/* Inside `LanguageProvider` for its copy, and outside `AppContent`
                        so a running form cannot unmount it. It renders nothing until a
                        new build is actually waiting. */}
                    <UpdateNotice />
                </CoreSessionProvider>
            </HRTModeProvider>
        </LanguageProvider>
    );
};

export default App;




