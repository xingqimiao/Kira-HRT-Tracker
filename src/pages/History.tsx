import React, { useState } from 'react';
import { GroupedVirtuoso } from 'react-virtuoso';
import Icon from '../components/Icon';
import { Plus, Check, Trash2, ListChecks } from '../icons';
import { v4 as uuidv4 } from 'uuid';
import { DoseEvent, Route, Ester, ExtraKey, getToE2Factor, isTestosteroneEster, isAntiandrogen, type PkEngineId } from '../../logic';
import { formatTime } from '../utils/helpers';
import { useDialog } from '../contexts/DialogContext';
import DoseForm from '../components/DoseForm';
import { compoundIcon } from '../components/compoundIcons';
import Collapsible from '../components/Collapsible';
import BloodVial from '../components/BloodVial';
import { useHRTMode } from '../contexts/HRTModeContext';
import { DoseTemplate } from '../components/DoseFormModal';
import { DoseDayGroup } from '../hooks/useAppData';
import { useScrollParent } from '../hooks/useScrollParent';
import Switch from '../components/Switch';

// Trim trailing zeros so wear durations read "3.5" / "7" rather than "3.50".
const formatWearDays = (days: number): string =>
    (Math.round(days * 100) / 100).toString();

const MAX_BATCH_COUNT = 365;

const muted = 'text-[var(--color-m3-on-surface-variant)] ';
const on = 'text-[var(--color-m3-on-surface)] ';
const headerBtn = 'flex items-center gap-1.5 text-sm font-medium px-2 py-1 rounded-md hover:bg-[var(--color-m3-surface-container)] ';
const numInput = 'input-num w-16 h-8 text-sm font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';

/**
 * One dose row — memoised.
 *
 * Opening a row flips one id in the parent's state, which re-renders the whole list.
 * Without this, every row (and, collapsed, its `Collapsible` wrapper) rebuilt on that
 * flip: at 1000 records a single open cost ~76ms of script and ~560ms of main thread
 * (measured), which is the reported "记录一多，点开就卡". With `React.memo` only the
 * row that opened and the one that closed actually render. `isEditing` and
 * `isSelected` are the row's own flags, so a change to either is exactly a change to
 * that row. Props are all stable across an unrelated parent render (`t` is now
 * `useCallback`ed, `doseTemplates`/`activeEngine` come from App, the handlers are
 * `useCallback`ed below), so the memo holds.
 */
interface HistoryRowProps {
    ev: DoseEvent;
    isEditing: boolean;
    isSelected: boolean;
    isFuture: boolean;
    selectMode: boolean;
    t: (key: string) => string;
    onToggle: (id: string) => void;
    onSaveEvent: (e: DoseEvent) => void;
    onDeleteEvent: (id: string) => void;
    onCloseEdit: () => void;
    doseTemplates: DoseTemplate[];
    onSaveTemplate: (tpl: DoseTemplate) => void;
    onDeleteTemplate: (id: string) => void;
    allEvents: DoseEvent[];
    activeEngine?: PkEngineId;
}

const HistoryRow: React.FC<HistoryRowProps> = ({
    ev, isEditing, isSelected, isFuture, selectMode, t,
    onToggle, onSaveEvent, onDeleteEvent, onCloseEdit,
    doseTemplates, onSaveTemplate, onDeleteTemplate, allEvents, activeEngine,
}) => (
    <div className="border-b border-[var(--color-m3-outline-variant)]  last:border-b-0">
        <div
            onClick={() => onToggle(ev.id)}
            className={`py-3.5 flex items-start gap-3 cursor-pointer -mx-2 px-2 rounded-md hover:bg-[var(--color-m3-surface-container)]  ${(isEditing || (selectMode && isSelected)) ? 'bg-[var(--color-m3-surface-container)] ' : ''}`}
        >
            {selectMode ? (
                <span className={`mt-[3px] w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${isSelected ? 'bg-[var(--color-m3-primary)] border-[var(--color-m3-primary)]' : 'border-[var(--color-m3-outline)] '}`}>
                    {isSelected && <Icon icon={Check} size={11} strokeWidth={2.5} className="text-cos-on-primary" />}
                </span>
            ) : (
                <Icon
                    icon={compoundIcon(ev.ester)}
                    size={25}
                    className="mt-0 shrink-0 text-[var(--color-m3-primary)]"
                    title={t(`ester.${ev.ester}`)}
                />
            )}
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-[var(--color-m3-on-surface)]  truncate text-sm">
                            {ev.route === Route.patchRemove ? t('route.patchRemove') : t(`ester.${ev.ester}`)}
                        </span>
                        {isFuture && (
                            <span className={`shrink-0 m3-text-2xs ${muted} px-1.5 py-0.5 rounded bg-[var(--color-m3-surface-container)] `}>
                                {t('timeline.future')}
                            </span>
                        )}
                    </div>
                    <span className="text-xs tabular-nums text-[var(--color-m3-on-surface-variant)]  shrink-0">
                        {formatTime(new Date(ev.timeH * 3600000))}
                    </span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--color-m3-on-surface-variant)] ">
                    <span className="truncate">{t(`route.${ev.route}`)}</span>
                    {ev.extras?.[ExtraKey.releaseRateUGPerDay] ? (
                        <>
                            <span className="opacity-40">·</span>
                            <span className="text-[var(--color-m3-on-surface)] ">{`${ev.extras[ExtraKey.releaseRateUGPerDay]} µg/d`}</span>
                        </>
                    ) : ev.route !== Route.patchRemove && (
                        <>
                            <span className="opacity-40">·</span>
                            <span className="text-[var(--color-m3-on-surface)]  font-medium">{`${ev.doseMG.toFixed(2)} mg`}</span>
                            {ev.ester !== Ester.E2 && !isAntiandrogen(ev.ester) && !isTestosteroneEster(ev.ester) && (
                                <span className="opacity-70">
                                    {`(${t('label.e2')} eq: ${(ev.doseMG * getToE2Factor(ev.ester)).toFixed(2)} mg)`}
                                </span>
                            )}
                            {isTestosteroneEster(ev.ester) && ev.ester !== Ester.T && (
                                <span className="opacity-70">
                                    {`(${t('label.t')} eq: ${(ev.doseMG * getToE2Factor(ev.ester)).toFixed(2)} mg)`}
                                </span>
                            )}
                        </>
                    )}
                    {ev.route === Route.patchApply && typeof ev.extras?.[ExtraKey.patchWearH] === 'number' && ev.extras[ExtraKey.patchWearH]! > 0 && (
                        <>
                            <span className="opacity-40">·</span>
                            <span className="text-[var(--color-m3-on-surface)] ">{`${formatWearDays(ev.extras[ExtraKey.patchWearH]! / 24)} ${t('unit.day_short')}`}</span>
                        </>
                    )}
                </div>
            </div>
        </div>

        <Collapsible open={isEditing && !selectMode}>
            {/* Mounted only for the row being edited — with hundreds of
                records, keeping every row's form mounted (even collapsed
                to zero height) made every dose add/edit re-render all of
                them at once. `Collapsible` holds it just long enough to
                collapse. */}
            <div className="pb-4 pt-1">
                <DoseForm
                    eventToEdit={ev}
                    onSave={(e) => { onSaveEvent(e); onCloseEdit(); }}
                    onCancel={onCloseEdit}
                    onDelete={(id) => { onDeleteEvent(id); onCloseEdit(); }}
                    templates={doseTemplates}
                    onSaveTemplate={onSaveTemplate}
                    onDeleteTemplate={onDeleteTemplate}
                    isInline={true}
                    hideHeader={true}
                    events={allEvents}
                    activeEngine={activeEngine}
                />
            </div>
        </Collapsible>
    </div>
);

const MemoHistoryRow = React.memo(HistoryRow);

/**
 * Virtuoso's pinned group-header container.
 *
 * It parks the current day's header at the top of the scroll surface by default
 * (`top: 0`). This page's own header is sticky at `top: 0` too (z-20), so at the
 * default offset the day label vanished behind it — measured, the label landed at
 * y≈13 with the page header bottom at 102. Moving the container down to the header's
 * own height (6.375rem = 102px) restores the pre-virtualisation look, where the label
 * rides just under the header. Overriding the component is the supported way to
 * change this; a CSS rule against Virtuoso's inline styles would be version-brittle.
 */
const DayHeaderContainer = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    (props, ref) => <div {...props} ref={ref} style={{ ...props.style, top: '6.375rem' }} />,
);
DayHeaderContainer.displayName = 'DayHeaderContainer';
const VIRTUOSO_COMPONENTS = { TopItemList: DayHeaderContainer };



interface HistoryProps {
    t: (key: string) => string;
    isQuickAddOpen: boolean;
    setIsQuickAddOpen: (isOpen: boolean) => void;
    doseTemplates: DoseTemplate[];
    onSaveEvent: (e: DoseEvent) => void;
    onDeleteEvent: (id: string) => void;
    onAddEvents: (events: DoseEvent[]) => void;
    onDeleteEvents: (ids: string[]) => void;
    onSaveTemplate: (t: DoseTemplate) => void;
    onDeleteTemplate: (id: string) => void;
    groupedEvents: DoseDayGroup[];
    /** The engine in use, so the dose form can hide the gel fields it does not read. */
    activeEngine?: PkEngineId;
}

const History: React.FC<HistoryProps> = ({
    t,
    isQuickAddOpen,
    setIsQuickAddOpen,
    doseTemplates,
    onSaveEvent,
    onDeleteEvent,
    onAddEvents,
    onDeleteEvents,
    onSaveTemplate,
    onDeleteTemplate,
    groupedEvents,
    activeEngine = 'builtin',
}) => {
    const { isTransmasc } = useHRTMode();
    const { showDialog } = useDialog();
    // The shell's scroll element, found by walking up from this page's root — the one
    // ancestor that actually scrolls (see `useScrollParent`).
    const rootRef = React.useRef<HTMLDivElement>(null);
    const scrollParent = useScrollParent(rootRef);
    const [editingId, setEditingId] = useState<string | null>(null);

    // Batch add: repeat the quick-add dose at a fixed interval.
    const [batchOn, setBatchOn] = useState(false);
    const [batchIntervalDays, setBatchIntervalDays] = useState('1');
    const [batchCount, setBatchCount] = useState('7');

    // Batch delete: selection mode over the list.
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const allEvents = React.useMemo(() => groupedEvents.flatMap(g => g.events), [groupedEvents]);
    const totalRecords = allEvents.length;
    const nowH = Date.now() / 3600000;

    // Stable row handlers, so a memoised row does not re-render on every parent render.
    const closeEdit = React.useCallback(() => setEditingId(null), []);
    const toggleRow = React.useCallback((id: string) => {
        if (selectMode) {
            setSelectedIds(prev => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
            });
        } else {
            setEditingId(prev => (prev === id ? null : id));
        }
    }, [selectMode]);

    const handleQuickSave = (e: DoseEvent) => {
        const interval = parseFloat(batchIntervalDays);
        const count = Math.min(MAX_BATCH_COUNT, Math.floor(parseFloat(batchCount)));
        if (batchOn && Number.isFinite(interval) && interval > 0 && Number.isFinite(count) && count > 1) {
            const list: DoseEvent[] = [];
            for (let k = 0; k < count; k++) {
                list.push({
                    ...e,
                    id: k === 0 ? e.id : uuidv4(),
                    timeH: e.timeH + k * interval * 24,
                    extras: { ...e.extras },
                });
            }
            onAddEvents(list);
        } else {
            onSaveEvent(e);
        }
        setIsQuickAddOpen(false);
    };

    const enterSelectMode = () => {
        setSelectMode(true);
        setSelectedIds(new Set());
        setEditingId(null);
        if (isQuickAddOpen) setIsQuickAddOpen(false);
    };

    const exitSelectMode = () => {
        setSelectMode(false);
        setSelectedIds(new Set());
    };

    const toggleSelected = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleSelectAll = () => {
        setSelectedIds(prev =>
            prev.size === totalRecords ? new Set() : new Set(allEvents.map(e => e.id))
        );
    };

    const handleDeleteSelected = () => {
        if (!selectedIds.size) return;
        const msg = t('timeline.batch_delete_confirm').replace('{n}', String(selectedIds.size));
        showDialog('confirm', msg, () => {
            onDeleteEvents([...selectedIds]);
            exitSelectMode();
        });
    };

    const batchHint = t('timeline.batch_hint')
        .replace('{d}', batchIntervalDays || '?')
        .replace('{n}', batchCount || '?');

    return (
        <div className="relative pb-32" ref={rootRef}>
            <div className="sticky top-0 z-20 w-full bg-[var(--color-m3-surface-dim)]">
              <div className="mx-auto w-full max-w-2xl px-6 md:px-8 pt-8 pb-3 flex items-center justify-between">
                <div>
                    <h1 className={`text-m3-title-xl ${on}`}>
                        {t('timeline.title')}
                    </h1>
                    <p className={`text-sm ${muted} mt-0.5`}>
                        {totalRecords} {t('timeline.records')}
                    </p>
                </div>
                {selectMode ? (
                    <div className="flex items-center gap-1 -mr-2">
                        <button onClick={toggleSelectAll} className={`${headerBtn} ${muted}`}>
                            <Icon icon={ListChecks} size={15} strokeWidth={1.5} />
                            <span>{t('timeline.select_all')}</span>
                        </button>
                        <button
                            onClick={handleDeleteSelected}
                            disabled={!selectedIds.size}
                            className={`${headerBtn} text-cos-error  disabled:opacity-40`}
                        >
                            <Icon icon={Trash2} size={15} strokeWidth={1.5} />
                            <span>{t('btn.delete')}{selectedIds.size ? ` (${selectedIds.size})` : ''}</span>
                        </button>
                        <button onClick={exitSelectMode} className={`${headerBtn} ${muted}`}>
                            <span>{t('btn.cancel')}</span>
                        </button>
                    </div>
                ) : (
                    <div className="flex items-center gap-1 -mr-2">
                        {totalRecords > 0 && (
                            <button onClick={enterSelectMode} className={`${headerBtn} ${muted}`}>
                                <Icon icon={ListChecks} size={15} strokeWidth={1.5} />
                                <span>{t('timeline.select')}</span>
                            </button>
                        )}
                        <button
                            onClick={() => setIsQuickAddOpen(!isQuickAddOpen)}
                            className={`${headerBtn} text-[var(--color-m3-primary)] `}
                        >
                            <Icon icon={Plus} size={15} className={isQuickAddOpen ? 'rotate-45' : ''} />
                            <span>{isQuickAddOpen ? t('btn.cancel') : t('btn.add') || '添加'}</span>
                        </button>
                    </div>
                )}
              </div>
            </div>

            {/* The dose form is always mounted here, so this pair animates both ways
                on its own — see Collapsible for why the row editors below cannot. */}
            <div className={`mt-4 grid transition-[grid-template-rows] duration-[250ms] ease-out ${isQuickAddOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className={`overflow-hidden transition-opacity duration-[250ms] ease-out ${isQuickAddOpen ? 'opacity-100' : 'opacity-0'}`}>
                    <div className="mx-auto w-full px-4 md:px-8 mb-6 max-w-2xl">
                        <div className="flex items-center justify-between py-3">
                            <div>
                                <p className={`text-sm font-medium ${on}`}>{t('timeline.batch')}</p>
                                <p className={`text-xs ${muted} mt-0.5`}>{t('timeline.batch_desc')}</p>
                            </div>
                            <Switch checked={batchOn} onChange={setBatchOn} />
                        </div>
                        {/* The switch reveals the interval and count below it, so the
                            disclosure has to be the same grid-rows pair the form above
                            uses — this was a bare `batchOn &&` mount, which snapped the
                            section in and out and shifted the page under the switch. */}
                        <Collapsible open={batchOn}>
                            <div className="pb-3">
                                <div className="flex items-center gap-5 flex-wrap">
                                    <label className={`flex items-center gap-2 text-xs font-semibold text-cos-on-surface-variant `}>
                                        {t('timeline.batch_interval')}
                                        <input
                                            type="number"
                                            min="0.25"
                                            step="0.25"
                                            value={batchIntervalDays}
                                            onChange={e => setBatchIntervalDays(e.target.value)}
                                            className={numInput}
                                        />
                                    </label>
                                    <label className={`flex items-center gap-2 text-xs font-semibold text-cos-on-surface-variant `}>
                                        {t('timeline.batch_count')}
                                        <input
                                            type="number"
                                            min="2"
                                            max={MAX_BATCH_COUNT}
                                            step="1"
                                            value={batchCount}
                                            onChange={e => setBatchCount(e.target.value)}
                                            className={numInput}
                                        />
                                    </label>
                                </div>
                                <p className={`text-xs ${muted} mt-2`}>{batchHint}</p>
                            </div>
                        </Collapsible>
                        <DoseForm
                            // Force remount on open so the default date resets to "now" (this row never unmounts, only collapses via CSS).
                            key={isQuickAddOpen ? 'open' : 'closed'}
                            eventToEdit={null}
                            onSave={handleQuickSave}
                            onCancel={() => setIsQuickAddOpen(false)}
                            onDelete={() => { }}
                            templates={doseTemplates}
                            onSaveTemplate={onSaveTemplate}
                            onDeleteTemplate={onDeleteTemplate}
                            isInline={true}
                            events={allEvents}
                            activeEngine={activeEngine}
                        />
                    </div>
                </div>
            </div>

            {groupedEvents.length === 0 && (
                <div className="mx-auto w-full px-6 md:px-8 flex flex-col items-center text-center py-20 max-w-2xl text-[var(--color-m3-on-surface-variant)] ">
                    {/* Empty, because it is: no doses logged, nothing in the tube. */}
                    <BloodVial level={0} mode={isTransmasc ? 'transmasc' : 'transfem'} size={64} className="mb-4" />
                    <p className="text-sm">{t('timeline.empty')}</p>
                </div>
            )}

            {groupedEvents.length > 0 && (
            <div className="mx-auto w-full px-6 md:px-8 max-w-2xl">
            <GroupedVirtuoso
                // The app's own scroll surface, so the window is sized from its
                // viewport — without it Virtuoso measures against `window` and renders
                // every row (the 1000-row jank this exists to fix).
                customScrollParent={scrollParent ?? undefined}
                components={VIRTUOSO_COMPONENTS}
                groupCounts={groupedEvents.map(g => g.events.length)}
                groupContent={(index) => (
                    // The pinning is Virtuoso's (see `DayHeaderContainer`); this is just
                    // the label's own box. The header is opaque so rows scroll under it.
                    <div className="bg-[var(--color-m3-surface-dim)] py-2">
                        <span className="text-xs font-semibold text-[var(--color-m3-on-surface-variant)] ">{groupedEvents[index].label}</span>
                    </div>
                )}
                itemContent={(index) => {
                    const ev = allEvents[index];
                    if (!ev) return null;
                    return (
                        <MemoHistoryRow
                            ev={ev}
                            isEditing={editingId === ev.id}
                            isSelected={selectedIds.has(ev.id)}
                            isFuture={ev.timeH > nowH}
                            selectMode={selectMode}
                            t={t}
                            onToggle={toggleRow}
                            onSaveEvent={onSaveEvent}
                            onDeleteEvent={onDeleteEvent}
                            onCloseEdit={closeEdit}
                            doseTemplates={doseTemplates}
                            onSaveTemplate={onSaveTemplate}
                            onDeleteTemplate={onDeleteTemplate}
                            allEvents={allEvents}
                            activeEngine={activeEngine}
                        />
                    );
                }}
                className="relative"
            />
            </div>
            )}

        </div>
    );
};

export default History;
