import type { MouseEvent, ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './SvgDefs';
import { rememberTransformSource } from './ContainerTransform';
import { hasViewBack, onBackGesture, overlayFollowsGesture, useBackHandler } from '../utils/nativeBack';
import { springTo, SPRING } from '../utils/spring';

/**
 * The Material predictive-back pose at full progress, read off the system's own
 * back-to-home animation (a page card scaling to ~0.86 with a deep corner radius
 * over a dimmed surround).
 */
const SCALE = 0.14;
const RADIUS_PX = 32;
const SHIFT_PX = 12;
/** How dark the surround gets. The destination page would be there natively. */
const SCRIM = 0.35;

/**
 * The page-level half of predictive back.
 *
 * `AdaptiveSheet` moves itself when a sheet is the surface being dismissed; this
 * covers every other back — a sub-page popping to its parent, a category closing
 * inside Settings. Without it the gesture ran, the page changed, and nothing on
 * screen had moved in between: the reported "预测性返回现在只支持了底部菜单".
 *
 * The shell leans toward the finger's edge and returns with the spring on cancel.
 * The commit is deliberately not animated here — the view change is React work
 * that lands a frame after the finger lifts, and animating a page that is about
 * to be replaced reads as a second, unrelated motion.
 */
function useShellPeek(
    scrollRef: RefObject<HTMLDivElement | null>,
    phoneRef: RefObject<HTMLDivElement | null>,
) {
    const settle = useRef<(() => void) | null>(null);
    const progress = useRef(0);
    const edge = useRef(-1);

    useEffect(() => {
        /*
         * The page content leans, not the shell.
         *
         * The first version translated `.phone`, which carried the bottom
         * navigation and the FAB along with the page — chrome moving under a
         * back gesture reads as the whole app being shoved around, which is the
         * reported "连底部tab都会动". The tab bar is the frame, not the picture;
         * only the picture moves.
         */
        const el = () =>
            scrollRef.current
            ?? phoneRef.current?.querySelector<HTMLElement>(':scope > .scroll')
            ?? null;

        /*
         * The Material predictive-back pose, driven straight from the platform's
         * progress: the page scales into a rounded card leaning toward the
         * finger's edge, over a dim. The same three properties every frame, all
         * compositor work — no layout, no re-render.
         *
         * What it cannot reproduce is what the system shows *around* the card:
         * the destination page. This app mounts one view at a time, so behind
         * the card is `--back-scrim`, a dim, rather than the screen being left.
         */
        const apply = (value: number) => {
            progress.current = value;
            const target = el();
            const shell = phoneRef.current;
            if (!target || !shell) return;
            if (value <= 0) {
                target.style.transform = '';
                target.style.borderRadius = '';
                target.style.background = '';
                target.style.willChange = '';
                shell.style.setProperty('--back-scrim', '0');
                return;
            }
            const dx = edge.current * value * SHIFT_PX;
            target.style.willChange = 'transform';
            target.style.transform = `translate3d(${dx}px,0,0) scale(${1 - SCALE * value})`;
            target.style.borderRadius = `${RADIUS_PX * value}px`;
            target.style.background = 'var(--bg)';
            shell.style.setProperty('--back-scrim', String(value * SCRIM));
        };

        return onBackGesture({
            onStart: e => {
                edge.current = e === 1 ? 1 : -1;
                settle.current?.();
                settle.current = null;
                apply(0);
            },
            onProgress: p => {
                // A sheet on top is the surface following the finger; at the root
                // the system's own back-to-home preview is. Neither wants the
                // page leaning under them. Page-internal states (a Settings
                // category) register as overlays too but move nothing, so there
                // this is the only feedback the gesture gives.
                if (overlayFollowsGesture() || !hasViewBack()) {
                    apply(0);
                    return;
                }
                apply(p);
            },
            onCancel: () => {
                settle.current = springTo(progress.current, 0, apply, {
                    config: SPRING.SHEET,
                });
            },
        });
    }, [scrollRef, phoneRef]);

    // The commit reaches the peek only as the same `hrt-back` that pops the view;
    // nothing else resets the pose, and a page left as a scaled card after the
    // view has changed is worse than no preview at all.
    useEffect(() => {
        const reset = () => {
            settle.current?.();
            settle.current = null;
            progress.current = 0;
            const target = scrollRef.current
                ?? phoneRef.current?.querySelector<HTMLElement>(':scope > .scroll');
            if (!target) return;
            target.style.transform = '';
            target.style.borderRadius = '';
            target.style.background = '';
            target.style.willChange = '';
            phoneRef.current?.style.setProperty('--back-scrim', '0');
        };
        window.addEventListener('hrt-back', reset);
        return () => window.removeEventListener('hrt-back', reset);
    }, [scrollRef, phoneRef]);

    // Unmount must not leave the page stranded sideways.
    useEffect(() => () => {
        settle.current?.();
        settle.current = null;
        const el = scrollRef.current ?? phoneRef.current?.querySelector<HTMLElement>(':scope > .scroll');
        if (el) {
            el.style.transform = '';
            el.style.borderRadius = '';
            el.style.background = '';
            el.style.willChange = '';
        }
        phoneRef.current?.style.setProperty('--back-scrim', '0');
    }, [scrollRef, phoneRef]);
}

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
    const phoneRef = useRef<HTMLDivElement | null>(null);
    const fallbackScrollRef = useRef<HTMLDivElement | null>(null);
    useShellPeek(scrollRef ?? fallbackScrollRef, phoneRef);

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
        <div className="phone" ref={phoneRef}>
            <div className="scroll" ref={scrollRef ?? fallbackScrollRef}>
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
