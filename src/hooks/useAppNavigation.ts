import { useState, useRef, useEffect } from 'react';
import { Home, ListTodo, Settings as SettingsIcon, UserCircle, ShieldCheck, CalibrationCurve } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';

export type ViewKey = 'home' | 'share' | 'history' | 'lab' | 'lab-calibration' | 'settings' | 'account' | 'admin' | 'sessions' | 'two-factor' | 'change-password' | 'delete-account' | 'edit-profile' | 'edit-avatar' | 'pk-params' | 'settings-hrt-mode' | 'settings-language' | 'settings-appearance' | 'settings-weight' | 'settings-export' | 'settings-import' | 'settings-security' | 'settings-mcp' | 'settings-licences';

export const useAppNavigation = (user: any) => {
    const { t } = useTranslation();

    // --- State ---
    const [currentView, setCurrentView] = useState<ViewKey>('home');
    const [transitionDirection, setTransitionDirection] = useState<'forward' | 'backward'>('forward');
    const mainScrollRef = useRef<HTMLDivElement>(null);

    const viewOrder: ViewKey[] = ['home', 'share', 'history', 'lab', 'lab-calibration', 'settings', 'account', 'sessions', 'two-factor', 'change-password', 'delete-account', 'edit-profile', 'edit-avatar', 'pk-params', 'settings-hrt-mode', 'settings-language', 'settings-appearance', 'settings-weight', 'settings-export', 'settings-import', 'settings-security', 'settings-mcp', 'settings-licences', 'admin'];

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

    if (user?.isAdmin) {
        navItems.push({ id: 'admin', label: t('nav.admin'), icon: ShieldCheck });
    }

    return {
        currentView,
        transitionDirection,
        handleViewChange,
        mainScrollRef,
        navItems
    };
};
