import { useState, useRef, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Home, ListTodo, Settings as SettingsIcon, UserCircle, CalibrationCurve } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useBackHandler, setWebPopStateFallback } from '../utils/nativeBack';
import { isNativeApp } from '../utils/platform';

export type ViewKey = 'home' | 'share' | 'history' | 'lab' | 'lab-calibration' | 'settings' | 'account' | 'pk-params' | 'settings-language' | 'settings-appearance' | 'settings-weight' | 'settings-export' | 'settings-import' | 'settings-security' | 'settings-mcp' | 'settings-licences' | 'settings-donate' | 'settings-donate-supporters';

/** Where system back lands from each view. Sub-pages return to their parent
 *  tab; a tab returns home; home returns false so the gesture falls through to
 *  the system (predictive back-to-home). */
const BACK_PARENT: Partial<Record<ViewKey, ViewKey>> = {
    'share': 'home',
    'lab-calibration': 'lab',
    'pk-params': 'settings',
    'settings-language': 'settings',
    'settings-appearance': 'settings',
    'settings-weight': 'settings',
    'settings-export': 'settings',
    'settings-import': 'settings',
    'settings-security': 'account',
    // Opened from the Account page's AI-assistant row, so back belongs there —
    // not on Settings, which is a different tab.
    'settings-mcp': 'account',
    'settings-licences': 'settings',
    'settings-donate': 'settings',
    'settings-donate-supporters': 'settings-donate',
};

/**
 * What a history entry carries.
 *
 * `hrtDepth` is the entry's position in the app's own stack, so a `popstate` can
 * rebuild the stack without trusting a separate counter that a forward jump would
 * leave wrong. Only these keys are ours; anything already in `state` is preserved.
 */
type HrtHistoryState = { hrtView?: ViewKey; hrtDepth?: number };

/**
 * `initialView` exists for the X landing: it renders instead of the app shell, so it
 * cannot switch tabs itself and hands the destination over as the page reloads. Taking it
 * as an initial state rather than navigating in an effect means the very first paint is
 * the right tab — no flash of Home, and no dependence on effect timing.
 */
export const useAppNavigation = (initialView: ViewKey = 'home') => {
    const { t } = useTranslation();

    // --- State ---
    const [currentView, setCurrentView] = useState<ViewKey>(initialView);
    const [transitionDirection, setTransitionDirection] = useState<'forward' | 'backward'>('forward');
    const mainScrollRef = useRef<HTMLDivElement>(null);

    const viewOrder: ViewKey[] = ['home', 'share', 'history', 'lab', 'lab-calibration', 'settings', 'account', 'pk-params', 'settings-language', 'settings-appearance', 'settings-weight', 'settings-export', 'settings-import', 'settings-security', 'settings-mcp', 'settings-licences', 'settings-donate', 'settings-donate-supporters'];

    // --- Browser history ---
    //
    // Every view change used to be in-memory only, so Back on the web left the app
    // entirely — the reader lost the place they were in and had to navigate back
    // from the start. Each change now pushes an entry carrying the view, and Back
    // walks them. The path is never rewritten: `/auth/:provider/callback` and the
    // share route are read from the URL, and a view name in it would collide with
    // both.
    //
    // The APK gets none of this. Android's WebView *consumes the back key itself*
    // whenever `history.canGoBack()` is true — it pops its own history before any
    // `OnBackPressedCallback` is consulted, so the Kotlin→`hrt-back` path never
    // ran and every gesture on a tab surfaced as "jumped back to the overview".
    // The APK has no browser chrome and no address bar, so its history entries
    // bought nothing; here they actively cost the gesture. Native views therefore
    // live only in React state, and the Kotlin callback is the single entry point.
    //
    // The depth of the entry the app is on. It is carried in the history state
    // itself (below), so Back and Forward restore it rather than a counter that
    // would drift; this ref is only the render-time copy.
    const depthRef = useRef(0);

    const writeEntry = (view: ViewKey, depth: number, replace: boolean) => {
        if (isNativeApp()) return;
        try {
            const state = { ...((window.history.state ?? {}) as Record<string, unknown>), hrtView: view, hrtDepth: depth };
            if (replace) window.history.replaceState(state, '');
            else window.history.pushState(state, '');
        } catch {
            // A WebView with history disabled: navigation still works in memory, it
            // just cannot be walked with Back. Not worth failing a page over.
        }
    };

    // --- Actions ---
    const applyView = (view: ViewKey) => {
        if (view === currentView) return;
        const go = () => {
            const currentIndex = viewOrder.indexOf(currentView);
            const nextIndex = viewOrder.indexOf(view);
            flushSync(() => {
                setTransitionDirection(nextIndex >= currentIndex ? 'forward' : 'backward');
                setCurrentView(view);
            });
        };
        // Native cross-fade for the outgoing *and* incoming route on mobile devices.
        // Desktop uses simple instantaneous swap with subtle page fade, avoiding
        // viewport-wide scale/translation jitter.
        const isDesktop = typeof document !== 'undefined' && (document.body.classList.contains('desktop') || window.innerWidth >= 760);
        const transition = (document as Document & {
            startViewTransition?: (cb: () => void) => unknown;
        }).startViewTransition;
        if (transition && !isDesktop && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            transition.call(document, go);
        } else {
            go();
        }
    };

    const handleViewChange = (view: ViewKey) => {
        if (view === currentView) return;
        applyView(view);
        // A forward move replaces whatever the reader had gone back from, which is
        // also what `pushState` does to the browser's own forward entries.
        depthRef.current += 1;
        writeEntry(view, depthRef.current, false);
    };

    // --- Effects ---
    const viewRef = useRef({ currentView, handleViewChange, applyView });
    viewRef.current = { currentView, handleViewChange, applyView };

    // Mark the entry the app was opened on, then follow Back and Forward.
    //
    // The popstate handler closes one overlay first (the browser's back gesture
    // pops the entry an open sheet pushed — see nativeBack) and only applies a
    // view when no overlay was up. The listener lives in nativeBack so the
    // overlay-close always runs before this logic and the two can never disagree.
    // The APK has no history of its own: its back is Kotlin's `hrt-back`, which
    // never produces a popstate.
    useEffect(() => {
        writeEntry(initialView, 0, true);
        if (isNativeApp()) return;
        const onPopState = (event: PopStateEvent) => {
            const state = event.state as HrtHistoryState | null;
            const view = state?.hrtView;
            if (typeof view !== 'string' || !viewOrder.includes(view as ViewKey)) return;
            const depth = typeof state?.hrtDepth === 'number' && state.hrtDepth >= 0 ? state.hrtDepth : 0;
            depthRef.current = depth;
            viewRef.current.applyView(view);
        };
        setWebPopStateFallback(onPopState);
        return () => setWebPopStateFallback(null);
        // `viewOrder` is a constant list, re-created by render only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reset scroll when switching tabs
    useEffect(() => {
        const el = mainScrollRef.current;
        if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }, [currentView]);

    // Android system back walks the view hierarchy (dialogs and modals register
    // above this handler, so they pop first). Deregistered at home so an empty
    // stack tells Kotlin to let the system handle back there — that is what
    // plays the predictive back-to-home animation instead of eating the event.
    //
    // Where the browser stack has an entry to pop, Back pops it instead of applying
    // the parent directly: the two must agree, or a later browser Back would land on
    // a view the app had already left. `applyView` is entered again through
    // `popstate`, which does not push.
    //
    // The APK has no history entries at all (see `writeEntry`), so Back applies the
    // parent directly — `history.back()` there would be a no-op and the gesture
    // would read as dead.
    useBackHandler(currentView !== 'home', () => {
        const { currentView: view } = viewRef.current;
        if (view === 'home') return false;
        if (!isNativeApp() && depthRef.current > 0) {
            window.history.back();
            return true;
        }
        // Native, or opened straight onto a sub-page (a reload, or a deep link):
        // there is no entry behind this one, so apply the parent rather than stack
        // a second entry in front of a page the reader never visited.
        const parent = BACK_PARENT[view] ?? 'home';
        applyView(parent);
        writeEntry(parent, 0, true);
        return true;
    }, 'view');

    // --- Derived Data ---
    const navItems = [
        { id: 'home', label: t('nav.home'), icon: Home },
        { id: 'history', label: t('nav.history'), icon: ListTodo },
        { id: 'lab', label: t('nav.lab'), icon: CalibrationCurve },
        { id: 'settings', label: t('nav.settings'), icon: SettingsIcon },
        { id: 'account', label: t('nav.account'), icon: UserCircle },
    ];

    return {
        currentView,
        transitionDirection,
        handleViewChange,
        mainScrollRef,
        navItems
    };
};
