import React from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { Bookmark, ChevronDown, RotateCcw } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { DoseEvent } from '../../logic';
import { templateToEvent } from '../utils/templateToEvent';

/** The template fields this needs — see `DoseTemplate` in useAppData/DoseForm. */
interface QuickTemplate {
    id: string;
    name: string;
    route: DoseEvent['route'];
    ester: DoseEvent['ester'];
    doseMG: number;
    extras: DoseEvent['extras'];
    createdAt: number;
}

interface HomeQuickAddProps {
    templates: QuickTemplate[];
    onAddEvent: (event: DoseEvent) => void;
    /** The undo, once the notice has timed out and there is no other way back. */
    onRemoveEvent: (id: string) => void;
}

/** How long the undo stays offered before the notice closes itself. */
const UNDO_MS = 6000;

/**
 * The overview page's one-tap "log a dose I already saved".
 *
 * One button, not a row of them: a person with eight templates would otherwise
 * have the overview crowded by the thing they use least. Opened, it lists every
 * template; picking one lands a record at the current time immediately, because
 * the whole point is not walking to the history page — so the undo lives in the
 * confirmation rather than in a form.
 *
 * It renders `null` with no templates. The page's own empty state already offers
 * "record a dose", which is the honest next step for someone who has never saved
 * one — a second button next to it would only be a dead end.
 *
 * Sized and spaced for a card's corner slot rather than dropped in the flow: the
 * parent decides where it sits, so there is no margin of its own to fight.
 */
const HomeQuickAdd: React.FC<HomeQuickAddProps> = ({ templates, onAddEvent, onRemoveEvent }) => {
    const { t } = useTranslation();
    const [open, setOpen] = React.useState(false);
    const [undo, setUndo] = React.useState<{ id: string; name: string } | null>(null);
    const buttonRef = React.useRef<HTMLButtonElement>(null);

    if (templates.length === 0) return null;

    // Most recently made first. Templates carry no "last used" stamp, and adding
    // one means touching the data shape and every device's stored copy — not worth
    // it for ordering a menu the user reads, not the app.
    const ordered = [...templates].sort((a, b) => b.createdAt - a.createdAt);

    const add = (template: QuickTemplate) => {
        const event = templateToEvent(template, crypto.randomUUID(), Date.now() / 3600000);
        onAddEvent(event);
        setOpen(false);
        setUndo({ id: event.id, name: template.name });
    };

    return (
        <>
            <div className="relative inline-block">
                <button
                    ref={buttonRef}
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    aria-haspopup="menu"
                    aria-label={t('quickadd.button')}
                    className={`inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-m3-outline-variant)] px-2.5 text-xs font-medium transition-colors sm:pl-3 sm:pr-2 ${
                        open
                            ? 'bg-[var(--color-m3-primary-container)] text-[var(--color-m3-on-surface)]'
                            : 'text-[var(--color-m3-on-surface-variant)] hover:bg-[var(--color-m3-surface-container)] hover:text-[var(--color-m3-on-surface)]'
                    }`}
                    style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
                    title={t('quickadd.button_hint')}
                >
                    <Icon icon={Bookmark} size={13} />
                    {/* Label only from `sm` up: on a 390px card the title row has room for
                        three items, and the words were what overflowed. The icon keeps its
                        aria-label, so nothing is lost to a screen reader. */}
                    <span className="hidden sm:inline">{t('quickadd.button')}</span>
                    <Icon icon={ChevronDown} size={13} className={`hidden sm:block ${open ? 'rotate-180' : ''}`} />
                </button>

                {open && createPortal(
                    <Dropdown
                        anchor={buttonRef.current}
                        items={ordered}
                        onPick={add}
                        onDismiss={() => setOpen(false)}
                    />,
                    document.body,
                )}
            </div>

            {undo && createPortal(
                <UndoBanner
                    key={undo.id}
                    name={undo.name}
                    onUndo={() => { onRemoveEvent(undo.id); setUndo(null); }}
                    onExpire={() => setUndo(null)}
                    t={t}
                />,
                document.body,
            )}
        </>
    );
};

/**
 * The opened list, pinned under its button.
 *
 * This page has a three-column layout, and an `absolute` menu would be clipped by
 * whichever of them happens to create a stacking context — so it is rendered at the
 * document root with a fixed position taken from the button's own rect.
 */
const Dropdown: React.FC<{
    anchor: HTMLElement | null;
    items: QuickTemplate[];
    onPick: (template: QuickTemplate) => void;
    onDismiss: () => void;
}> = ({ anchor, items, onPick, onDismiss }) => {
    const { t } = useTranslation();
    const [rect, setRect] = React.useState<DOMRect | null>(() => anchor?.getBoundingClientRect() ?? null);

    React.useEffect(() => {
        const measure = () => setRect(anchor?.getBoundingClientRect() ?? null);
        measure();
        window.addEventListener('scroll', measure, true);
        window.addEventListener('resize', measure);
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('scroll', measure, true);
            window.removeEventListener('resize', measure);
            window.removeEventListener('keydown', onKey);
        };
    }, [anchor, onDismiss]);

    if (!rect) return null;

    // The trigger lives in the card's far corner, so the list hangs from its right
    // edge. Left-anchored, a 288px menu on a 375px screen would run off the side.
    const width = Math.min(288, window.innerWidth - 16);

    return (
        <>
            {/* Catches the outside click. Transparent: dimming the page for a menu with
                one level would read as a modal, which this is not. */}
            <div className="fixed inset-0 z-[80]" onClick={onDismiss} aria-hidden="true" />
            <div
                role="menu"
                className="fixed z-[81] max-h-80 overflow-y-auto rounded-xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-lowest)] py-1 shadow-lg"
                style={{
                    top: rect.bottom + 6,
                    width,
                    left: Math.max(8, rect.right - width),
                }}
            >
                {items.map((template) => (
                    <button
                        key={template.id}
                        type="button"
                        role="menuitem"
                        onClick={() => onPick(template)}
                        className="block w-full border-b border-[var(--color-m3-outline-variant)] px-3 py-2.5 text-left last:border-b-0 hover:bg-[var(--color-m3-surface-container)]"
                    >
                        <span className="block text-sm font-medium text-[var(--color-m3-on-surface)]">{template.name}</span>
                        <span className="mt-0.5 block text-xs text-[var(--color-m3-on-surface-variant)]">
                            {t(`route.${template.route}`)} · {template.doseMG.toFixed(2)} mg
                        </span>
                    </button>
                ))}
            </div>
        </>
    );
};

/**
 * "Added X — undo", which closes itself after `UNDO_MS`.
 *
 * The timer lives here rather than in the parent so the notice's lifetime and the
 * undo it offers cannot drift apart: when the notice goes, the chance to undo goes
 * with it. `key={undo.id}` remounts this per record, which is what restarts the
 * countdown when someone taps two templates in a row.
 */
const UndoBanner: React.FC<{
    name: string;
    onUndo: () => void;
    onExpire: () => void;
    t: (key: string) => string;
}> = ({ name, onUndo, onExpire, t }) => {
    React.useEffect(() => {
        const timer = window.setTimeout(onExpire, UNDO_MS);
        return () => window.clearTimeout(timer);
    }, [onExpire]);

    return (
        <div
            role="status"
            className="fixed bottom-4 left-1/2 z-[90] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-3 rounded-xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-highest)] px-4 py-3 text-[var(--color-m3-on-surface)] shadow-lg"
        >
            <span className="min-w-0 flex-1 text-xs">
                {t('quickadd.done').replace('{name}', name)}
            </span>
            <button
                type="button"
                onClick={onUndo}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-[var(--color-m3-primary)] hover:bg-[var(--color-m3-primary-container)]"
            >
                <Icon icon={RotateCcw} size={13} />
                {t('quickadd.undo')}
            </button>
        </div>
    );
};

export default HomeQuickAdd;
