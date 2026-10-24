import type { MouseEvent, ReactNode, RefObject } from 'react';
import { useEffect, useState } from 'react';
import { Icon } from './SvgDefs';
import { rememberTransformSource } from './ContainerTransform';
import { useBackHandler } from '../utils/nativeBack';

/** The prototype's five tabs, in its order. */
export type ShellTab = 'home' | 'history' | 'lab' | 'settings' | 'account';

const TAB_ICON: Record<ShellTab, string> = {
    home: 'home',
    history: 'list',
    lab: 'chart',
    settings: 'set',
    account: 'user',
};

export interface ShellItem {
    id: string;
    label: string;
}

export interface ShellFab {
    label: string;
    icon: string;
    onClick?: () => void;
    /** When present the FAB opens the `#fm` speed dial instead of acting. */
    menu?: { label: string; icon: string; onClick: () => void }[];
}

/**
 * The prototype shell: `.phone` > `.scroll` + `.nav` + `#fab` + `.rail-logo`.
 *
 * Every piece of geometry comes from `src/m3e.css`, which is the prototype's own
 * stylesheet; this component only supplies the markup the prototype's script
 * would otherwise build by hand. `body.desktop` (set by `useViewportMode`) turns
 * the bar into the 96dp rail and moves the FAB into the rail's top slot.
 */
export function PrototypeShell({
    items,
    activeId,
    onNavigate,
    scrollRef,
    fab,
    children,
}: {
    items: ShellItem[];
    activeId: string;
    onNavigate: (id: string) => void;
    scrollRef?: RefObject<HTMLDivElement | null>;
    /** Omitted on Settings and Account: the rail shows the logo instead. */
    fab?: ShellFab | null;
    children: ReactNode;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const hasMenu = Boolean(fab?.menu?.length);

    // System back closes the speed-dial. Without this the gesture fell through
    // to the view handler and navigated with the menu still floating — and since
    // the shell outlives every page, the expanded menu survived the navigation
    // and re-appeared on the page the user came back to. Closing it on navigation
    // covers the same surprise for every other path (a nav tap, the rail logo).
    useBackHandler(menuOpen, () => {
        setMenuOpen(false);
        return true;
    });
    useEffect(() => {
        setMenuOpen(false);
    }, [activeId]);

    const onFabClick = (e: MouseEvent<HTMLButtonElement>) => {
        // The surface it opens measures this exact button. Recorded even for the
        // speed-dial toggle; only a full-screen surface consumes it.
        rememberTransformSource(e.currentTarget);
        if (hasMenu) {
            setMenuOpen(open => !open);
            return;
        }
        fab?.onClick?.();
    };

    return (
        <div className="phone">
            <div className="scroll" ref={scrollRef}>
                {children}
            </div>

            {/* The prototype's speed-dial list, anchored above/left of the FAB.
                `#fm` holds the `.fmi` buttons directly — the stagger in the
                stylesheet keys off `#fm.on .fmi:nth-child(n)`. */}
            {hasMenu ? (
                <div className={`scrim${menuOpen ? ' on' : ''}`} onClick={() => setMenuOpen(false)} aria-hidden="true" style={{ zIndex: 10 }} />
            ) : null}

            {hasMenu ? (
                <div id="fm" className={menuOpen ? 'on' : ''}>
                    {fab!.menu!.map(item => (
                        <button
                            key={item.label}
                            className="fmi"
                            data-fm={item.icon}
                            onClick={(e) => {
                                rememberTransformSource(e.currentTarget);
                                setMenuOpen(false);
                                item.onClick();
                            }}
                        >
                            <Icon id={item.icon} />
                            {item.label}
                        </button>
                    ))}
                </div>
            ) : null}

            {fab ? (
                <button
                    className={`fab on${hasMenu ? ' fab-morph' : ''}${hasMenu && menuOpen ? ' open' : ''}`}
                    data-m
                    style={{ '--mo': '16px' } as never}
                    onClick={onFabClick}
                    aria-label={fab.label}
                    aria-expanded={hasMenu ? menuOpen : undefined}
                >
                    {/* Both glyphs stay mounted so the crossfade can run: the plus
                        turns into the close mark rather than being swapped. */}
                    <span className="fab-ico" aria-hidden="true">
                        <Icon id={fab.icon} />
                        {hasMenu ? <Icon id="x" /> : null}
                    </span>
                    {/* The label collapses to its own width through a grid track,
                        so the pill shrinks to a 56px square without a magic number. */}
                    <span className="fab-txt-wrap">
                        <span className="fab-txt">{fab.label}</span>
                    </span>
                </button>
            ) : null}

            {/* Replacement for the FAB in the rail's top slot on pages that do
                not have one — tapping it goes back to the overview. */}
            <button
                className={`rail-logo${fab ? '' : ' on'}`}
                aria-label="Kira HRT Tracker"
                onClick={() => onNavigate('home')}
            >
                <Icon id="tube" />
            </button>

            <div className="nav">
                {items.map(item => {
                    const tab = item.id as ShellTab;
                    const icon = TAB_ICON[tab] ?? 'home';
                    return (
                        <button
                            key={item.id}
                            className={item.id === activeId ? 'on' : undefined}
                            onClick={() => onNavigate(item.id)}
                        >
                            <span className="p">
                                <Icon id={icon} />
                            </span>
                            {item.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
