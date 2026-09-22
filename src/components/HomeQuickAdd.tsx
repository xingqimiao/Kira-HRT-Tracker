import React from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { Bookmark, ChevronDown, RotateCcw } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { usePresence } from '../hooks/usePresence';
import { DoseEvent } from '../../logic';
import { templateToEvent } from '../utils/templateToEvent';

/** The menu's exit, in ms — must match the `.m3-menu` exit in index.css. */
const MENU_EXIT_MS = 150;

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
 * The trigger's look, in one place: the live button and the intro's showcase both
 * render from this, so the picture of the button cannot drift from the button.
 *
 * `large` is the only difference, and it exists because the intro has the card to
 * itself while the overview's title row does not — on a 390px card the live button
 * drops its words (the label was what overflowed) and keeps only the glyphs, which
 * would make a showcase with no words a picture of a nondescript icon. The colour,
 * edge, radius and gap stay the same at both sizes.
 */
const triggerClass = (open: boolean, empty: boolean, large = false) =>
    `inline-flex items-center border border-[var(--color-m3-outline-variant)] font-medium transition-colors ${
        large
            ? 'h-12 gap-1.5 rounded-lg pe-3 ps-4 text-sm'
            // A phone-only square: below `sm` the label is hidden, so a padded
            // row around one glyph was a 41x36 rectangle (measured) with the
            // icon 11px from one edge and 10px from the other. `w-9 h-9 p-0
            // justify-center` makes it a 36x36 square with the glyph at its
            // centre, and `rounded-md` is the corner the Share control beside it
            // already uses — from `sm` up it grows back into the labelled row.
            : 'h-9 w-9 justify-center gap-0 rounded-md p-0 text-xs sm:w-auto sm:justify-normal sm:gap-1.5 sm:rounded-lg sm:pl-3 sm:pr-2'
    } ${
        open
            ? 'bg-[var(--color-m3-primary-container)] text-[var(--color-m3-on-surface)]'
            : 'text-[var(--color-m3-on-surface-variant)] hover:bg-[var(--color-m3-surface-container)] hover:text-[var(--color-m3-on-surface)]'
    } ${empty ? 'cursor-not-allowed opacity-40' : ''}`;

/**
 * The overview page's one-tap "log a dose I already saved".
 *
 * One button, not a row of them: a person with eight templates would otherwise
 * have the overview crowded by the thing they use least. Opened, it lists every
 * template; picking one lands a record at the current time immediately, because
 * the whole point is not walking to the history page — so the undo lives in the
 * confirmation rather than in a form.
 *
 * With no templates it renders disabled rather than nothing, and says why in its
 * hint. It used to render `null`, on the reasoning that the page's empty state
 * already offers "record a dose" — but that left a hole in the card's corner where
 * the control appears as soon as one template exists, and the person who has never
 * saved one is exactly the person who needs to be told the feature is there. The
 * Share button beside it is disabled in the same way for the same reason.
 *
 * Sized and spaced for a card's corner slot rather than dropped in the flow: the
 * parent decides where it sits, so there is no margin of its own to fight.
 */
const HomeQuickAdd: React.FC<HomeQuickAddProps> = ({ templates, onAddEvent, onRemoveEvent }) => {
    const { t } = useTranslation();
    const [open, setOpen] = React.useState(false);
    const [undo, setUndo] = React.useState<{ id: string; name: string } | null>(null);
    const buttonRef = React.useRef<HTMLButtonElement>(null);

    const empty = templates.length === 0;

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
                    disabled={empty}
                    aria-expanded={open}
                    aria-haspopup="menu"
                    aria-label={t('quickadd.button')}
                    className={triggerClass(open, empty)}
                    style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
                    /* The hint doubles as the explanation when there is nothing to
                       log yet: the same words that describe the feature tell you
                       what is missing. */
                    title={empty ? t('quickadd.empty_hint') : t('quickadd.button_hint')}
                >
                    <Icon icon={Bookmark} size={13} />
                    {/* Label only from `sm` up: on a 390px card the title row has room for
                        three items, and the words were what overflowed. The icon keeps its
                        aria-label, so nothing is lost to a screen reader. */}
                    <span className="hidden sm:inline">{t('quickadd.button')}</span>
                    <Icon icon={ChevronDown} size={13} className={`hidden sm:block ${open ? 'rotate-180' : ''}`} />
                </button>

                {/* Always rendered, so the menu can play its exit; it returns
                    null itself once closed and spent. `anchor` is read from the
                    button's rect inside. */}
                {createPortal(
                    <Dropdown
                        open={open}
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
 * The trigger as a picture, for the intro step that introduces it.
 *
 * Not the live control: the intro cannot log a dose (there is no record yet), so a
 * real `HomeQuickAdd` would either be dead or would fire against an empty store.
 * Rendering the same markup in a non-interactive shell keeps the picture honest —
 * it is the button, not a drawing of one — while staying keyboard-inert, because
 * the step's own controls are the only things a keyboard should reach there.
 *
 * Worded through `t()` like the button, so the picture is in the reader's language.
 */
export const QuickAddPreview: React.FC = () => {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            title={t('quickadd.button_hint')}
            className={`${triggerClass(false, false, true)} cursor-default`}
        >
            <Icon icon={Bookmark} size={18} />
            <span>{t('quickadd.button')}</span>
            <Icon icon={ChevronDown} size={18} />
        </button>
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
    /** The trigger's live state. The exit runs on the way to false. */
    open: boolean;
    anchor: HTMLElement | null;
    items: QuickTemplate[];
    onPick: (template: QuickTemplate) => void;
    onDismiss: () => void;
}> = ({ open, anchor, items, onPick, onDismiss }) => {
    const { t } = useTranslation();
    const [rect, setRect] = React.useState<DOMRect | null>(() => anchor?.getBoundingClientRect() ?? null);
    const { mounted, state } = usePresence(open, MENU_EXIT_MS);

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

    // The outside-click catcher leaves with the menu, on the same frame it starts
    // to close: while `data-state="closed"` is animating, `.m3-menu` is
    // `pointer-events: none`, so keeping the catcher up would swallow a click
    // meant for the page underneath.
    if (!rect || !mounted) return null;

    // The trigger lives in the card's far corner, so the list hangs from its right
    // edge. Left-anchored, a 288px menu on a 375px screen would run off the side.
    const width = Math.min(288, window.innerWidth - 16);

    return (
        <>
            {/* Catches the outside click. Transparent: dimming the page for a menu with
                one level would read as a modal, which this is not. */}
            {open && <div className="fixed inset-0 z-[80]" onClick={onDismiss} aria-hidden="true" />}
            <div
                role="menu"
                data-state={state}
                className="fixed z-[81] max-h-80 overflow-y-auto rounded-xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-lowest)] py-1 shadow-lg m3-menu m3-menu--top-right"
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
            className="m3-snackbar fixed bottom-4 left-1/2 z-[90] w-[calc(100%-2rem)] max-w-sm"
        >
            <span className="min-w-0 flex-1">
                {t('quickadd.done').replace('{name}', name)}
            </span>
            <button
                type="button"
                onClick={onUndo}
                className="m3-snackbar-action inline-flex shrink-0 items-center gap-1"
            >
                <Icon icon={RotateCcw} size={13} />
                {t('quickadd.undo')}
            </button>
        </div>
    );
};

export default HomeQuickAdd;
