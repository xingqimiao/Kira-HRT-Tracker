import React from 'react';
import { DoseEvent, Route, Ester, ANTIANDROGENS } from '../../logic';
import { useTranslation } from '../contexts/LanguageContext';
import { formatDate, formatTime } from '../utils/helpers';

/**
 * The overview's dose list, shown in the slot the dose grid occupies when the
 * chart is in candle (K线) view.
 *
 * A trading terminal pairs its candles with an order book, and the order book's
 * signature is the depth bar: a horizontal measure of *how much* sits on each
 * row. The honest equivalent here is the dose itself — each row carries a red
 * bar whose length is that dose against the largest one on screen, with the
 * amount printed over it. So the panel answers "how big was each recent dose,
 * at a glance" beside the candles those doses drew, rather than a plain list.
 *
 * The bar scales against the biggest dose *in the shown list*, which is what an
 * order book does and what keeps a week of 2–3 mg gel visible instead of one
 * large dose flattening the rest. Milligrams of different esters do not share a
 * scale, so the bar is a per-row magnitude, not a summed quantity.
 *
 * Read-only and unclickable: the timeline owns editing, and a row here that
 * opened a form would be a second editing surface to keep in sync.
 */
const ROWS = 14;

/** A dose of this many mg fills the bar; larger doses cap at full. A fixed
 *  yardstick (not the list's own maximum) so the bars mean the same thing in
 *  every window — a 3 mg dose is always three-fifths of a bar. */
const BAR_FULL_MG = 5;

/** Order of esters that share a time, so the list is stable rather than
 *  whichever order the store happened to return. */
const esterRank = (e: Ester) => e;

const DoseOrderBook = ({ events, onRepeat, className = '' }: { events: DoseEvent[]; onRepeat?: (e: DoseEvent) => void; className?: string }) => {
    const { t, lang } = useTranslation();

    // Newest first. `patchRemove` is the end of a dose, not an order, so it is
    // left out — the same rule the heatmap counts by.
    const recent = React.useMemo(
        () => events
            .filter(e => e.route !== Route.patchRemove)
            .slice()
            .sort((a, b) => b.timeH - a.timeH || esterRank(a.ester).localeCompare(esterRank(b.ester)))
            .slice(0, ROWS),
        [events],
    );

    return (
        <div className={`flex w-full flex-col ${className}`}>
            <p className="mb-2 shrink-0 text-xs font-semibold text-[var(--color-m3-on-surface-variant)]">
                {t('orderbook.title')}
            </p>
            {recent.length === 0 ? (
                <p className="py-6 text-center text-xs text-[var(--color-m3-on-surface-variant)] opacity-60">
                    {t('orderbook.empty')}
                </p>
            ) : (
                <ul className="flex min-h-0 flex-1 flex-col gap-0.5 lg:overflow-y-auto">
                    {recent.map(e => {
                        const at = new Date(e.timeH * 3600000);
                        // No bar for an anti-androgen — it is not on the curve the
                        // candles beside this list draw. Otherwise: 5 mg is a full
                        // bar, capped there, with a small floor so a tiny dose is
                        // still visible.
                        const bar = ANTIANDROGENS.has(e.ester) ? 0 : Math.min(100, Math.max(6, (e.doseMG / BAR_FULL_MG) * 100));
                        return (
                            <li key={e.id} className="relative overflow-hidden rounded-[var(--radius-sm)]">
                                {/* The depth bar. Red, as order-book asks are, and
                                    anchored to the right edge growing leftward — the
                                    order-book direction. The fill is quiet enough that
                                    the numbers stay legible over the widest bars.
                                    Decorative, so it is hidden from the accessibility
                                    tree — the amount beside it carries the same fact. */}
                                {bar > 0 && (
                                    <span
                                        aria-hidden
                                        className="absolute inset-y-0 end-0 bg-[var(--color-m3-error)] opacity-25"
                                        style={{ width: `${bar}%` }}
                                    />
                                )}
                                <button
                                    type="button"
                                    disabled={!onRepeat}
                                    onClick={() => onRepeat?.(e)}
                                    title={onRepeat ? t('orderbook.repeat') : undefined}
                                    className="relative flex w-full items-baseline justify-between gap-3 px-2 py-1.5 text-xs text-start transition-colors enabled:hover:bg-[var(--color-m3-surface-container)] enabled:active:bg-[var(--color-m3-primary-container)] disabled:cursor-default"
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate font-medium text-[var(--color-m3-on-surface)]">
                                            {t(`ester.${e.ester}`)}
                                        </span>
                                        <span className="block truncate text-[var(--color-m3-on-surface-variant)]">
                                            {t(`route.${e.route}`)}
                                        </span>
                                    </span>
                                    <span className="shrink-0 text-end tabular-nums">
                                        <span className="block font-medium text-[var(--color-m3-on-surface)]">
                                            {e.doseMG.toFixed(2)} mg
                                        </span>
                                        <span className="block text-[var(--color-m3-on-surface-variant)]">
                                            {formatDate(at, lang)} {formatTime(at)}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

export default DoseOrderBook;
