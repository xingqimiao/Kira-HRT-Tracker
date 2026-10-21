import React, { useState, useEffect } from 'react';
import { GroupedVirtuoso } from 'react-virtuoso';
import Icon from '../components/Icon';
import { Check, Trash2, ListChecks } from '../icons';
import { DoseEvent, Route, Ester, ExtraKey, getToE2Factor, isTestosteroneEster, isAntiandrogen, isUnmodelledCompound, type PkEngineId } from '../../logic';
import { formatTime } from '../utils/helpers';
import { useDialog } from '../contexts/DialogContext';
import DoseForm from '../components/DoseForm';
import { categoryForEster, modeOf } from '../components/dose_form/catalog';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import BloodVial from '../components/BloodVial';
import { useHRTMode } from '../contexts/HRTModeContext';
import { FullScreenSheet } from '../ui/FullScreenSheet';
import { DoseTemplate } from '../components/DoseFormModal';
import { DoseDayGroup } from '../hooks/useAppData';
import { useScrollParent } from '../hooks/useScrollParent';
import { FloatingToolbar, FloatingToolbarAction } from '../ui/proto';
import { rememberTransformSource } from '../ui/ContainerTransform';

// Trim trailing zeros so wear durations read "3.5" / "7" rather than "3.50".
const formatWearDays = (days: number): string =>
    (Math.round(days * 100) / 100).toString();

/** Which records the list shows, in the active HRT mode's own vocabulary. */
type RecordFilter = 'all' | 'e2' | 'aa' | 't' | 'cycle';

interface HistoryRowProps {
    ev: DoseEvent;
    isSelected: boolean;
    isFuture: boolean;
    selectMode: boolean;
    radius: string;
    t: (key: string) => string;
    onToggle: (id: string) => void;
}

const ROUTE_ICON_ID: Record<string, string> = {
    [Route.oral]: 'pill',
    [Route.sublingual]: 'tongue',
    [Route.gel]: 'gel',
    [Route.injection]: 'syr',
    [Route.patchApply]: 'patch',
    [Route.patchRemove]: 'peel',
};

const HistoryRow: React.FC<HistoryRowProps> = ({
    ev, isSelected, isFuture, selectMode, radius, t, onToggle,
}) => {
    const { isTransmasc } = useHRTMode();
    const rowCategory = categoryForEster(modeOf(isTransmasc), ev.ester);
    const iconTone = rowCategory === 'aa' || rowCategory === 'cycle'
        ? 'am'
        : rowCategory === 'progest' || rowCategory === 'hair'
            ? 'sec'
            : 'p';
    const title = ev.route === Route.patchRemove ? t('route.patchRemove') : t(`ester.${ev.ester}`);
    const detail: string[] = [t(`route.${ev.route}`)];
    if (ev.extras?.[ExtraKey.releaseRateUGPerDay]) {
        detail.push(`${ev.extras[ExtraKey.releaseRateUGPerDay]} µg/d`);
    } else if (ev.route !== Route.patchRemove) {
        detail.push(`${ev.doseMG.toFixed(2)} mg`);
        if (ev.ester !== Ester.E2 && !isAntiandrogen(ev.ester) && !isTestosteroneEster(ev.ester) && !isUnmodelledCompound(ev.ester)) {
            detail.push(`${t('label.e2')} eq ${(ev.doseMG * getToE2Factor(ev.ester)).toFixed(2)} mg`);
        }
        if (isTestosteroneEster(ev.ester) && ev.ester !== Ester.T) {
            detail.push(`${t('label.t')} eq ${(ev.doseMG * getToE2Factor(ev.ester)).toFixed(2)} mg`);
        }
    }
    if (ev.route === Route.patchApply && typeof ev.extras?.[ExtraKey.patchWearH] === 'number' && ev.extras[ExtraKey.patchWearH]! > 0) {
        detail.push(`${formatWearDays(ev.extras[ExtraKey.patchWearH]! / 24)} ${t('unit.day_short')}`);
    }

    return (
        <div style={{ paddingBottom: 3 }}>
            <div
                role="button"
                tabIndex={0}
                onClick={(event) => {
                    rememberTransformSource(event.currentTarget);
                    onToggle(ev.id);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        rememberTransformSource(event.currentTarget);
                        onToggle(ev.id);
                    }
                }}
                className="li"
                style={{
                    borderRadius: radius,
                    width: '100%',
                    textAlign: 'left',
                    background: isSelected && selectMode ? 'var(--pric)' : undefined,
                    color: isSelected && selectMode ? 'var(--onpric)' : undefined,
                }}
            >
                {selectMode ? (
                    <span className={`sel-box${isSelected ? ' on' : ''}`} aria-hidden="true">
                        {isSelected ? <Icon icon={Check} size={15} strokeWidth={2.8} /> : null}
                    </span>
                ) : (
                    <span className={`ic ${iconTone}`} aria-hidden="true" style={{ width: 50, height: 50 }}>
                        <SpriteIcon id={ROUTE_ICON_ID[ev.route] ?? 'pill'} />
                    </span>
                )}
                <div className="t">
                    <b>
                        {title}
                        {isFuture ? <span className="chip" style={{ background: 'var(--secc)', color: 'var(--onsecc)', padding: '3px 8px' }}>{t('timeline.future')}</span> : null}
                    </b>
                    <span className="s">{detail.join(' · ')}</span>
                </div>
                <div className="r">{formatTime(new Date(ev.timeH * 3600000))}</div>
            </div>
        </div>
    );
};

const MemoHistoryRow = React.memo(HistoryRow);

/** Virtuoso's group-header container. The library makes it sticky by default;
 *  the prototype's date label scrolls with its group, and pinning it at `top: 0`
 *  covered the card above (and clipped the first row under it). */
const DayHeaderContainer = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    (props, ref) => (
        <div
            {...props}
            ref={ref}
            style={{ ...props.style, position: 'static', top: 'auto', zIndex: 'auto' }}
        />
    ),
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
    onDeleteEvents,
    onSaveTemplate,
    onDeleteTemplate,
    groupedEvents,
    activeEngine = 'builtin',
}) => {
    const { isTransmasc } = useHRTMode();
    const { showDialog } = useDialog();
    const rootRef = React.useRef<HTMLDivElement>(null);
    const scrollParent = useScrollParent(rootRef);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [filter, setFilter] = useState<RecordFilter>('all');
    // The filter values are mode-specific: an `aa` selection has no button (and
    // no meaning) after switching to masculinising HRT.
    useEffect(() => {
        setFilter('all');
    }, [isTransmasc]);

    // Keep Virtuoso's viewport offsetTop honest when the fixed overlay closes or
    // the filter changes the height of what is above it.
    useEffect(() => {
        if (!scrollParent) return;
        let animId: number;
        const start = performance.now();
        const tick = () => {
            scrollParent.dispatchEvent(new Event('scroll'));
            if (performance.now() - start < 350) animId = requestAnimationFrame(tick);
        };
        animId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animId);
    }, [isQuickAddOpen, filter, scrollParent]);

    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const allRecords = React.useMemo(() => groupedEvents.flatMap(g => g.events), [groupedEvents]);
    const totalRecords = allRecords.length;
    const nowH = Date.now() / 3600000;

    const groups = React.useMemo(() => {
        if (filter === 'all') return groupedEvents;
        const band = modeOf(isTransmasc);
        return groupedEvents
            .map(g => ({
                ...g,
                events: g.events.filter(ev => {
                    const cat = categoryForEster(band, ev.ester);
                    if (filter === 'e2' || filter === 't') return cat === 'hrt';
                    if (filter === 'aa') return cat === 'aa';
                    return cat === 'cycle';
                }),
            }))
            .filter(g => g.events.length > 0);
    }, [groupedEvents, filter, isTransmasc]);

    const allEvents = React.useMemo(() => groups.flatMap(g => g.events), [groups]);
    const editingEvent = React.useMemo(
        () => (editingId ? allEvents.find(e => e.id === editingId) ?? null : null),
        [allEvents, editingId],
    );

    /**
     * What the editing sheet renders, which is not the same as what is selected.
     *
     * Deleting the open record empties `editingEvent` on the same frame the sheet
     * starts closing, and an empty sheet collapses to its header while it fades —
     * the form vanishing under the animation. Holding the last event keeps the
     * content in place for the exit; it is only ever rendered inside a sheet that
     * is already on its way out.
     */
    const lastEditingEvent = React.useRef<DoseEvent | null>(null);
    if (editingEvent) lastEditingEvent.current = editingEvent;
    const sheetEvent = editingEvent ?? lastEditingEvent.current;

    const stats = React.useMemo(() => ({ total: totalRecords }), [totalRecords]);

    const bounds = React.useMemo(() => {
        const first = new Set<number>();
        const last = new Set<number>();
        let index = 0;
        for (const group of groups) {
            if (group.events.length === 0) continue;
            first.add(index);
            last.add(index + group.events.length - 1);
            index += group.events.length;
        }
        return { first, last };
    }, [groups]);

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
        onSaveEvent(e);
        setIsQuickAddOpen(false);
        if (scrollParent && scrollParent.scrollTop > 0) {
            scrollParent.scrollTo({ top: 0, behavior: 'smooth' });
        }
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

    const toggleSelectAll = () => {
        setSelectedIds(prev =>
            prev.size === totalRecords ? new Set() : new Set(allEvents.map(e => e.id)),
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

    return (
        <div className="pg on long relative" id="p1" ref={rootRef}>
            <FullScreenSheet bare open={isQuickAddOpen} onClose={() => setIsQuickAddOpen(false)} title={t('timeline.add_title')}>
                <DoseForm
                    key={isQuickAddOpen ? 'open' : 'closed'}
                    eventToEdit={null}
                    onSave={handleQuickSave}
                    onCancel={() => setIsQuickAddOpen(false)}
                    onDelete={() => { }}
                    templates={doseTemplates}
                    onSaveTemplate={onSaveTemplate}
                    onDeleteTemplate={onDeleteTemplate}
                    events={allRecords}
                    activeEngine={activeEngine}
                />
            </FullScreenSheet>

            <FullScreenSheet bare open={!!editingEvent} onClose={() => setEditingId(null)} title={t('modal.dose.edit_title')}>
                {sheetEvent && (
                    <DoseForm
                        key={sheetEvent.id}
                        eventToEdit={sheetEvent}
                        onSave={(e) => { onSaveEvent(e); setEditingId(null); }}
                        onCancel={() => setEditingId(null)}
                        onDelete={(id) => { onDeleteEvent(id); setEditingId(null); }}
                        templates={doseTemplates}
                        onSaveTemplate={onSaveTemplate}
                        onDeleteTemplate={onDeleteTemplate}
                        events={allRecords}
                        activeEngine={activeEngine}
                    />
                )}
            </FullScreenSheet>

            <div className="hrow">
                <h1 style={{ margin: 0 }}>{t('nav.history')}</h1>
                {totalRecords > 0 ? (
                    <button type="button" onClick={selectMode ? exitSelectMode : enterSelectMode} className="btn t" data-m style={{ ['--mo' as string]: '14px', minWidth: 0 }}>
                        <Icon icon={ListChecks} size={17} />
                        <span key={selectMode ? 'cancel' : 'select'} className="m3e-swap">
                            {selectMode ? t('btn.cancel') : t('timeline.select')}
                        </span>
                    </button>
                ) : null}
            </div>

            <div className="d-grid records-grid">
                <div className="d-col">
                    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div className="hrow" style={{ alignItems: 'baseline' }}>
                            <div className="sub" style={{ margin: 0 }}>{t('timeline.stats')}</div>
                            {/* Reserved even outside selection mode: inserting this
                                line used to grow the stats card and shove the whole
                                virtual list down the instant batch mode opened. */}
                            <span
                                className="chip"
                                aria-live="polite"
                                style={{
                                    padding: '4px 9px',
                                    background: 'var(--secc)',
                                    color: 'var(--onsecc)',
                                    opacity: selectMode ? 1 : 0,
                                    transform: selectMode ? 'none' : 'translateY(-3px)',
                                    transition: 'opacity .2s ease, transform .25s cubic-bezier(.2,.9,.2,1)',
                                    pointerEvents: 'none',
                                }}
                            >
                                {selectedIds.size} / {allEvents.length}
                            </span>
                        </div>
                        <div style={{ fontSize: 36, fontWeight: 800, lineHeight: 1 }}>
                            {stats.total} <small style={{ fontSize: 15, fontWeight: 600, color: 'var(--var)' }}>{t('timeline.records')}</small>
                        </div>
                        <div className="cg" style={{ marginTop: 4 }}>
                            {(isTransmasc
                                ? [
                                    { value: 'all' as const, label: t('chart.range_all') },
                                    { value: 't' as const, label: t('m3e.cat.hrt_ftm') },
                                    { value: 'cycle' as const, label: t('m3e.cat.cycle') },
                                ]
                                : [
                                    { value: 'all' as const, label: t('chart.range_all') },
                                    { value: 'e2' as const, label: t('m3e.cat.hrt_mtf') },
                                    { value: 'aa' as const, label: t('m3e.cat.aa') },
                                ]).map(option => (
                                <button type="button" key={option.value} className={filter === option.value ? 'on' : ''} onClick={() => setFilter(option.value)}>
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="d-col" style={{ minWidth: 0 }}>
                    {groups.length === 0 ? (
                        <div className="card">
                            <div className="empty" style={{ padding: '36px 0' }}>
                                <BloodVial level={0} mode={isTransmasc ? 'transmasc' : 'transfem'} size={64} />
                                <p style={{ marginTop: 10 }}>{t('timeline.empty')}</p>
                            </div>
                        </div>
                    ) : (
                        <GroupedVirtuoso
                            customScrollParent={scrollParent ?? undefined}
                            components={VIRTUOSO_COMPONENTS}
                            groupCounts={groups.map(g => g.events.length)}
                            groupContent={(index) => (
                                /* The date label is a group header, and Virtuoso measures
                                   its offsetHeight — which excludes margins. A margin here
                                   made the header's painted box overlap the first row by
                                   ~10px, flattening its top corners ("顶端被削平").
                                   Padding is part of the measured height, so the gap is
                                   inside the header instead. */
                                <div
                                    className="lab"
                                    style={{ background: 'var(--bg)', margin: 0, padding: '10px 8px 4px' }}
                                >
                                    {groups[index].label}
                                </div>
                            )}
                            itemContent={(index) => {
                                const ev = allEvents[index];
                                if (!ev) return null;
                                const isFirst = bounds.first.has(index);
                                const isLast = bounds.last.has(index);
                                const radius = isFirst && isLast
                                    ? '26px'
                                    : isFirst
                                        ? '26px 26px 8px 8px'
                                        : isLast
                                            ? '8px 8px 26px 26px'
                                            : '8px';
                                return (
                                    <MemoHistoryRow
                                        ev={ev}
                                        isSelected={selectedIds.has(ev.id)}
                                        isFuture={ev.timeH > nowH}
                                        selectMode={selectMode}
                                        radius={radius}
                                        t={t}
                                        onToggle={toggleRow}
                                    />
                                );
                            }}
                            className="relative"
                        />
                    )}
                </div>
            </div>

            <FloatingToolbar open={selectMode} label={t('timeline.select')}>
                <FloatingToolbarAction icon={<Icon icon={ListChecks} size={17} />} label={t('timeline.select_all')} onClick={toggleSelectAll} />
                <FloatingToolbarAction icon={<Icon icon={Trash2} size={17} />} label={t('btn.delete')} onClick={handleDeleteSelected} disabled={selectedIds.size === 0} />
            </FloatingToolbar>
        </div>
    );
};

export default History;

