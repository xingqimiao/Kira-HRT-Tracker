import React from 'react';
import Icon from './Icon';
import type { IconComponent } from '../icons';

interface NavItem {
    id: string;
    label: string;
    icon: IconComponent;
}

interface SidebarProps {
    navItems: NavItem[];
    currentView: string;
    onViewChange: (view: any) => void;
}

/**
 * The primary navigation, as a 64px bar across the top.
 *
 * It replaces the left rail the app started with. That rail cost a fixed 260px on
 * every screen for five destinations, which is a poor trade on a page whose whole job
 * is to show a chart and a list of doses. Across the top it costs 64px once, and the
 * reading column underneath gets the width back.
 *
 * The bar is the page colour at 88% with a blur, not a solid block: content scrolling
 * underneath stays faintly visible, so the bar reads as glass over the page rather
 * than a band cut out of it. Links are pills and the current one is *filled*, which is
 * the only state signal — no underline competing with it.
 *
 * Sub-views (a settings screen, the sessions list) are owned by the section they were
 * opened from, so the pill for that section stays lit while you are inside it.
 *
 * Desktop only: on a phone the floating bottom bar in App.tsx is the navigation, and
 * two of them would be one too many.
 */
const Sidebar: React.FC<SidebarProps> = ({ navItems, currentView, onViewChange }) => {
    /** A view belongs to the section it drills out of until it drills somewhere else. */
    const sectionFor = (view: string): string => {
        if (view.startsWith('settings-') || view === 'pk-params') return 'settings';
        if (view === 'sessions' || view === 'change-password') return 'account';
        if (view === 'lab-calibration') return 'lab';
        return view;
    };

    const section = sectionFor(currentView);
    // Admin lives behind Settings on every screen size, so the bar does not need a
    // sixth destination for it.
    const visible = navItems.filter(item => item.id !== 'admin');

    return (
        <nav className="m3-navbar hidden px-4 md:flex md:px-6" aria-label="Primary">
            <div className="mx-auto flex w-full max-w-[1100px] items-center gap-4">
                {/* The mark. A wordmark, not a logo — there is no logo, and inventing one
                    would be the only fictional thing on the page. */}
                <button
                    onClick={() => onViewChange('home')}
                    className="shrink-0 text-[0.9375rem] font-semibold tracking-tight text-[var(--color-m3-on-surface)]"
                >
                    Kira Tracker
                </button>

                <div className="ml-auto flex items-center gap-1">
                    {visible.map(item => {
                        const isActive = section === item.id;
                        return (
                            <button
                                key={item.id}
                                onClick={() => onViewChange(item.id)}
                                aria-current={isActive ? 'page' : undefined}
                                className={`m3-nav-pill ${isActive ? 'is-active' : ''}`}
                            >
                                <Icon icon={item.icon} size={18} strokeWidth={isActive ? 1.9 : 1.75} />
                                <span>{item.label}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </nav>
    );
};

export default Sidebar;
