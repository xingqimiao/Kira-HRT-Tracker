import React from 'react';
import NavigationRail, { NavDestination } from './NavigationRail';
import NavigationBar from './NavigationBar';

/**
 * The application shell.
 *
 * catalog → layout-and-responsive.md (app shell) + navigation-patterns.md. It is
 * the one place the window size classes are acted on: the rail shows itself at
 * 840 and the bar hides itself there, both in CSS, so nothing about the switch
 * depends on JavaScript having run.
 *
 * The content area stays full-bleed — each screen owns its own reading measure
 * through PageContainer — because the sticky headers inside a page have to span
 * the column they stick within, and a shared cap here would fight that.
 */
const AppShell: React.FC<{
    navItems: NavDestination[];
    activeId: string;
    onNavigate: (id: string) => void;
    navLabel: string;
    children: React.ReactNode;
}> = ({ navItems, activeId, onNavigate, navLabel, children }) => (
    <div className="h-[100dvh] w-full bg-[var(--color-m3-surface)] flex flex-col font-sans text-[var(--color-m3-on-surface)] select-none overflow-hidden">
        <NavigationRail
            items={navItems}
            activeId={activeId}
            onNavigate={onNavigate}
            label={navLabel}
        />
        <div className="m3-shell-body flex-1 flex flex-col overflow-hidden w-full bg-[var(--color-m3-surface-dim)] relative">
            {children}
            <NavigationBar
                items={navItems}
                activeId={activeId}
                onNavigate={onNavigate}
                label={navLabel}
            />
        </div>
    </div>
);

export default AppShell;
