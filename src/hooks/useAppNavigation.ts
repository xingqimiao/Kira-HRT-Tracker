import { useState, useRef, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Home, ListTodo, Settings as SettingsIcon, UserCircle, CalibrationCurve } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useBackHandler } from '../utils/nativeBack';

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

    // --- Actions ---
    const handleViewChange = (view: ViewKey) => {
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

    // --- Effects ---
    // Reset scroll when switching tabs
    useEffect(() => {
        const el = mainScrollRef.current;
        if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }, [currentView]);

    // Android system back walks the view hierarchy (dialogs and modals register
    // above this handler, so they pop first). Deregistered at home so an empty
    // stack tells Kotlin to let the system handle back there — that is what
    // plays the predictive back-to-home animation instead of eating the event.
    const viewRef = useRef({ currentView, handleViewChange });
    viewRef.current = { currentView, handleViewChange };
    useBackHandler(currentView !== 'home', () => {
        const { currentView: view, handleViewChange: change } = viewRef.current;
        if (view === 'home') return false;
        change(BACK_PARENT[view] ?? 'home');
        return true;
    });

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
