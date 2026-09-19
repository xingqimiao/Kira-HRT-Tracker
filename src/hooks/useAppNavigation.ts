import { useState, useRef, useEffect } from 'react';
import { Home, ListTodo, Settings as SettingsIcon, UserCircle, CalibrationCurve } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';

export type ViewKey = 'home' | 'share' | 'history' | 'lab' | 'lab-calibration' | 'settings' | 'account' | 'pk-params' | 'settings-hrt-mode' | 'settings-language' | 'settings-appearance' | 'settings-weight' | 'settings-export' | 'settings-import' | 'settings-security' | 'settings-mcp' | 'settings-licences';

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

    const viewOrder: ViewKey[] = ['home', 'share', 'history', 'lab', 'lab-calibration', 'settings', 'account', 'pk-params', 'settings-hrt-mode', 'settings-language', 'settings-appearance', 'settings-weight', 'settings-export', 'settings-import', 'settings-security', 'settings-mcp', 'settings-licences'];

    // --- Actions ---
    const handleViewChange = (view: ViewKey) => {
        if (view === currentView) return;
        const currentIndex = viewOrder.indexOf(currentView);
        const nextIndex = viewOrder.indexOf(view);
        setTransitionDirection(nextIndex >= currentIndex ? 'forward' : 'backward');
        setCurrentView(view);
    };

    // --- Effects ---
    // Reset scroll when switching tabs
    useEffect(() => {
        const el = mainScrollRef.current;
        if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }, [currentView]);

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
