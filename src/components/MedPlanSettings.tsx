import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import Switch from './Switch';
import { useTranslation } from '../contexts/LanguageContext';
import { Ester, Route, isAntiandrogen, isTestosteroneEster, ExtraKey } from '../../logic';
import DateTimePicker from './DateTimePicker';
import { ChevronRight, Clock3 as Clock, Plus, Trash2, Bookmark, Check } from '../icons';
import type { DoseTemplate } from './DoseForm';
import { PillRail, type PillItem } from './dose_form/FormControls';
import { RouteGlyph, compoundIcon } from './compoundIcons';
import PatchFields from './dose_form/PatchFields';
import {
    readMedPlans, writeMedPlans, sanitizeMedPlans, isSavedTemplate, type MedPlan, type PlanStatus, type PlanTime,
    planStatuses, migrateOldRemindersToPlans,
    isPlanNotificationGranted, requestPlanNotificationPermission,
} from '../utils/medPlanNotify';
import { plansForMode, availablePlanRoutes, availablePlanEsters, availablePlanRoutesForEster, localDateKey } from '../utils/medPlan';
import { reschedulePlanNotifications } from '../utils/medPlanNotify';
import { syncPushRegistration } from '../utils/pushRegister';
import { isNativeApp } from '../utils/platform';
import { useCoreSession } from '../hooks/useCoreSession';
import { useHRTMode } from '../contexts/HRTModeContext';

type PlanMode = 'times' | 'hours' | 'days';

const MODES: readonly PlanMode[] = ['times', 'hours', 'days'];

const fieldLabel = 'block text-xs font-semibold text-[var(--color-m3-on-surface-variant)] pl-1 mb-1.5';
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const hhmmOf = (t: PlanTime) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;

/**
 * The medication plan (用药方案), its own settings section.
 *
 * One block owns the whole lifecycle: the schedule list, the add form, and the
 * notification permission for this transport (browser on web, the system channel
 * on the APK). Self-contained on purpose — the plans live in their own store and
 * sync to the account as their own sealed scalar, so nothing here reaches the dose
 * data or the sync engine.
 */
const MedPlanSettings: React.FC<{ muted: string; on: string; doseTemplates?: DoseTemplate[] }> = ({ muted, on, doseTemplates = [] }) => {
    const { t } = useTranslation();
    const session = useCoreSession();
    const { isTransmasc, mode: hrtMode } = useHRTMode();
    // Only the user's own saved templates — never a plan's auto-generated entry.
    const importable = useMemo(() => doseTemplates.filter(t => isSavedTemplate(t.id)), [doseTemplates]);
    const [plans, setPlans] = useState<MedPlan[]>(() => {
        migrateOldRemindersToPlans();
        return readMedPlans();
    });
    const [webPermission, setWebPermission] = useState(false);
    const visiblePlans = useMemo(() => plansForMode(plans, hrtMode), [plans, hrtMode]);

    // Add-form state.
    const [ester, setEster] = useState<Ester>(Ester.E2);
    const [route, setRoute] = useState<Route>(() => (isTransmasc ? Route.injection : Route.sublingual));
    const routeChoices = useMemo(() => availablePlanRoutesForEster(hrtMode, ester), [hrtMode, ester]);
    const esterChoices = useMemo(() => availablePlanEsters(hrtMode, route), [hrtMode, route]);
    const [patchMode, setPatchMode] = useState<'dose' | 'rate'>('rate');
    const [patchRate, setPatchRate] = useState('50');
    const [patchWearDays, setPatchWearDays] = useState('');
    const [alias, setAlias] = useState('');
    const [dose, setDose] = useState('');
    const [mode, setMode] = useState<PlanMode>('times');
    const [intervalHours, setIntervalHours] = useState(8);
    const [everyDays, setEveryDays] = useState(2);
    const [firstTime, setFirstTime] = useState<Date>(() => {
        const d = new Date();
        d.setHours(9, 0, 0, 0);
        return d;
    });
    // The extra doses ("第 2 剂", "第 3 剂" …) each with a stable id so the picker
    // state and keys survive a delete of a middle row.
    const [extraTimes, setExtraTimes] = useState<{ id: string; date: Date }[]>([]);
    /** Which time picker is open: 'first', an extra row's id, or null. */
    const [openPicker, setOpenPicker] = useState<string | null>(null);
    /** The plan being edited, or null when the form is adding a new one. Tapping a
     *  plan loads it here; the submit button then saves in place instead of adding. */
    const [editingId, setEditingId] = useState<string | null>(null);
    /** Whether the add/edit form is open. Collapsed by default so an account with a
     *  plan or two is not staring at the whole scheduling form. */
    const [formOpen, setFormOpen] = useState(false);

    // Read the current permission on mount (async: the native check hits the plugin).
    useEffect(() => {
        let cancelled = false;
        void isPlanNotificationGranted().then(v => { if (!cancelled) setWebPermission(v); }).catch(() => undefined);
        return () => { cancelled = true; };
    }, []);

    const commit = (next: MedPlan[]): void => {
        const clean = sanitizeMedPlans(next);
        setPlans(clean);
        writeMedPlans(clean);
        void reschedulePlanNotifications(true).catch(() => undefined);
        // No explicit upload here: the plan is a synced scalar now (buildExportPayload
        // includes it, applySyncedState applies it), so the change fingerprint arms the
        // ordinary sync. The old pushMedPlan call wrote the same record out of band,
        // which is what let the plan go up but never come back down.
    };

    const status = useMemo<{ plan: MedPlan; overdue: boolean }[]>(() => {
        // The badge state shown here is a local read: the overdue badge lives on the
        // quick-record button, this row just marks the plan red when it is behind.
        return planStatuses(plansForMode(readMedPlans(), hrtMode), [], Date.now(), new Date().getTimezoneOffset()).map(st => ({ plan: st.plan, overdue: st.overdue }));
        // Recomputed when the plan list changes; a stale "overdue" here corrects
        // itself on the next visit or the next edit.
    }, [plans, hrtMode]);

    const overdueOf = (id: string): boolean => status.find(s => s.plan.id === id)?.overdue ?? false;

    /**
     * The plan's dose is a milligram amount — the unit is fixed, not typed.
     *
     * It used to be free text (placeholder `2mg`) on the reasoning that a plan's dose
     * is the user's own note. But every consumer already treats the leading number as
     * milligrams (`parseDoseMG`, and the logged record's `doseMG`), so the unit was
     * never optional — it was just something the user had to remember to type, and a
     * unit-free "2" silently read as 2 mg anyway.
     *
     * The input therefore holds the bare number the user types (so a trailing "." is
     * not eaten mid-keystroke), and `submitPlan` appends `mg` — the `"<n>mg"` form is
     * what already round-trips through every plan, the import path and the displays.
     */
    const stripMG = (s: string): string => {
        const m = /(\d+(?:\.\d+)?)/.exec(s);
        return m ? m[1] : '';
    };

    const emptyForm = (): void => {
        setEster(Ester.E2);
        setRoute(isTransmasc ? Route.injection : Route.sublingual);
        setAlias('');
        setDose('');
        setPatchMode('rate');
        setPatchRate('50');
        setPatchWearDays('');
        setMode('times');
        setIntervalHours(8);
        setEveryDays(2);
        const d = new Date();
        d.setHours(9, 0, 0, 0);
        setFirstTime(d);
        setExtraTimes([]);
        setEditingId(null);
    };

    /** Open the form on an existing plan, prefilled, so it can be changed rather than
     *  only toggled. The row used to toggle enabled on tap with no way to edit. */
    const editPlan = (p: MedPlan): void => {
        setEster(p.ester);
        setRoute(p.route ?? (isTransmasc ? Route.injection : Route.sublingual));
        setAlias(p.alias ?? '');
        setDose(stripMG(p.dose ?? ''));
        setPatchMode(typeof p.extras?.[ExtraKey.releaseRateUGPerDay] === 'number' ? 'rate' : 'dose');
        setPatchRate(String(p.extras?.[ExtraKey.releaseRateUGPerDay] ?? 50));
        setPatchWearDays(typeof p.extras?.[ExtraKey.patchWearH] === 'number' ? String(p.extras[ExtraKey.patchWearH]! / 24) : '');
        setMode(p.mode);
        setIntervalHours(p.intervalHours ?? 8);
        setEveryDays(p.everyDays ?? 2);
        const d = new Date();
        d.setHours(p.firstHour, p.firstMinute, 0, 0);
        setFirstTime(d);
        setExtraTimes((p.doseTimes ?? []).map((tt) => {
            const x = new Date();
            x.setHours(tt.hour, tt.minute, 0, 0);
            return { id: crypto.randomUUID(), date: x };
        }));
        setEditingId(p.id);
        setFormOpen(true);
    };

    const closeForm = (): void => {
        emptyForm();
        setFormOpen(false);
        setOpenPicker(null);
    };

    const submitPlan = (): void => {
        const selected = routeChoices.includes(route) && esterChoices.includes(ester)
            ? { route, ester }
            : (() => {
                const fallbackRoute = availablePlanRoutes(hrtMode)[0];
                const fallbackEster = availablePlanEsters(hrtMode, fallbackRoute)[0];
                return { route: fallbackRoute, ester: fallbackEster };
            })();
        const selectedRoute = selected.route;
        const selectedEster = selected.ester;
        const extras: Record<string, number> = {};
        if (selectedRoute === Route.patchApply) {
            if (patchMode === 'rate') {
                const rate = Number(patchRate);
                if (!Number.isFinite(rate) || rate <= 0) return;
                extras[ExtraKey.releaseRateUGPerDay] = rate;
            }
            const wearDays = Number(patchWearDays);
            if (patchWearDays.trim() && Number.isFinite(wearDays) && wearDays > 0) extras[ExtraKey.patchWearH] = wearDays * 24;
        }
        const plan: MedPlan = {
            id: editingId ?? crypto.randomUUID(),
            ester: selectedEster,
            hrtMode,
            route: selectedRoute,
            alias: alias.trim() || undefined,
            dose: selectedRoute === Route.patchApply && patchMode === 'rate' ? '' : (dose.trim() ? `${dose.trim()}mg` : ''),
            extras: Object.keys(extras).length ? extras : undefined,
            anchorDate: mode === 'days' ? (editingId ? readMedPlans().find(p => p.id === editingId)?.anchorDate : undefined) ?? localDateKey(new Date()) : undefined,
            mode,
            doseTimes: mode === 'times'
                ? extraTimes.map(e => ({ hour: e.date.getHours(), minute: e.date.getMinutes() }))
                : undefined,
            intervalHours: mode === 'hours' ? intervalHours : undefined,
            everyDays: mode === 'days' ? everyDays : undefined,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
            firstHour: firstTime.getHours(),
            firstMinute: firstTime.getMinutes(),
            // A new plan is on; an edit keeps whatever the row's switch says.
            enabled: editingId ? (readMedPlans().find(p => p.id === editingId)?.enabled ?? true) : true,
        };
        commit(editingId
            ? readMedPlans().map(p => p.id === editingId ? plan : p)
            : [...readMedPlans(), plan]);
        closeForm();
    };

    const removePlan = (id: string): void => {
        commit(readMedPlans().filter(p => p.id !== id));
        if (editingId === id) closeForm();
    };
    const togglePlan = (id: string): void => commit(readMedPlans().map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));

    /** Fill the form from a saved quick-template (its drug, route and dose). */
    const importTemplate = (tpl: DoseTemplate): void => {
            const templateSelection = availablePlanRoutes(hrtMode).includes(tpl.route)
                ? { route: tpl.route, ester: availablePlanEsters(hrtMode, tpl.route).includes(tpl.ester) ? tpl.ester : availablePlanEsters(hrtMode, tpl.route)[0] }
                : null;
            if (templateSelection) {
                setRoute(templateSelection.route);
                setEster(templateSelection.ester);
            }
            setDose(String(tpl.doseMG));

        setAlias(tpl.name);
    };

    const addExtraTime = (): void => {
        const d = new Date(firstTime);
        // The next dose defaults an hour after the first, so a fresh row reads as a
        // schedule rather than duplicating the first time.
        d.setHours(d.getHours() + 1 + extraTimes.length);
        setExtraTimes(prev => [...prev, { id: crypto.randomUUID(), date: d }]);
    };

    const askWebPermission = async (): Promise<void> => {
        const granted = await requestPlanNotificationPermission();
        setWebPermission(granted);
        if (granted) {
            // Native: (re)schedule the repeating system reminders now that it is allowed.
            // Web: start the 60-second in-app check.
            if (isNativeApp()) {
                void reschedulePlanNotifications().catch(() => undefined);
            } else {
                const { startPlanWebNotifications } = await import('../utils/medPlanNotify');
                startPlanWebNotifications();
            }
            // Bind this device's FCM token so the server can send a catch-up nudge
            // for a dose that was never logged. Both transports; no-op until signed in.
            if (session.token) void syncPushRegistration(session.token).catch(() => undefined);
        }
    };

    const scheduleSummary = (p: MedPlan): string => {
        const time = `${String(p.firstHour).padStart(2, '0')}:${String(p.firstMinute).padStart(2, '0')}`;
        if (p.mode === 'times') {
            const all = [time, ...(p.doseTimes ?? []).map(hhmmOf)];
            return all.join(' · ');
        }
        if (p.mode === 'hours') return t('plan.sum.hours').replace('{h}', String(p.intervalHours ?? 24)).replace('{time}', time);
        return t('plan.sum.days').replace('{d}', String(p.everyDays ?? 2)).replace('{time}', time);
    };

    const modeLabel = (m: PlanMode): string => m === 'times' ? t('plan.mode.times') : m === 'hours' ? t('plan.mode.hours') : t('plan.mode.days');

    useEffect(() => {
        if (!routeChoices.includes(route)) setRoute(routeChoices[0]);
    }, [routeChoices, route]);
    useEffect(() => {
        if (!esterChoices.includes(ester)) setEster(esterChoices[0]);
    }, [esterChoices, ester]);

    // The same picture-pill rails the record form uses, so a plan's drug and route read
    // exactly like a logged dose's.
    const toneOf = (e: Ester): PillItem['tone'] =>
        isAntiandrogen(e) ? 'A' : isTestosteroneEster(e) ? 'T' : 'E';
    const esterItems: PillItem[] = useMemo(
        () => esterChoices.map(e => ({ value: e, label: t(`pill.ester.${e}`), icon: compoundIcon(e), tone: toneOf(e) })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [esterChoices, t],
    );
    const routeItems: PillItem[] = useMemo(
        () => routeChoices.map(r => ({ value: r, label: t(`pill.route.${r}`), icon: RouteGlyph[r] ?? RouteGlyph.oral })),
        [routeChoices, t],
    );

    const numField = (label: string, value: number, set: (v: number) => void, min: number, max: number) => (
        <label className="block">
            <span className="block text-xs font-semibold text-[var(--color-m3-on-surface-variant)] mb-1.5">{label}</span>
            <input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                value={value}
                onChange={e => set(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
                className="input-base tabular-nums"
            />
        </label>
    );

    // A time field: a button showing HH:MM that opens the picker, keyed so only one
    // picker is open at a time.
    const timeField = (label: string, key: string, date: Date, onPick: (d: Date) => void, onRemove?: () => void) => (
        <div>
            <span className={fieldLabel}>{label}</span>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => setOpenPicker(v => v === key ? null : key)}
                    aria-expanded={openPicker === key}
                    className="input-base flex items-center justify-between tabular-nums text-start"
                >
                    <span>{hhmm(date)}</span>
                    <Icon icon={ChevronRight} size={16} className={`shrink-0 transition-transform duration-200 ${openPicker === key ? 'rotate-90' : ''}`} />
                </button>
                {onRemove && (
                    <button type="button" onClick={onRemove} aria-label={t('plan.remove')} className={`shrink-0 p-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] ${muted}`}>
                        <Icon icon={Trash2} size={16} />
                    </button>
                )}
            </div>
            <DateTimePicker
                isOpen={openPicker === key}
                inline
                mode="time"
                onClose={() => setOpenPicker(null)}
                onConfirm={(d) => { onPick(d); setOpenPicker(null); }}
                initialDate={date}
                title={label}
            />
        </div>
    );

    return (
        <div>
            <div className="flex items-center gap-2 mb-2.5 pt-1">
                <Icon icon={Clock} size={16} className={muted} />
                <span className={`text-m3-body-medium font-medium ${on}`}>{t('plan.title')}</span>
            </div>

            {/* Notification permission, per transport — the APK asks the system, the
                web asks the browser; both surface the same button so the section does
                not branch. Granted, it says so instead. */}
            {!webPermission ? (
                <button
                    type="button"
                    onClick={() => void askWebPermission()}
                    className="m3-btn m3-btn-tonal m3-btn-sm w-full mb-4"
                >
                    {isNativeApp() ? t('plan.enable') : t('plan.web_enable')}
                </button>
            ) : (
                <p className="text-xs text-[var(--color-m3-success)] mb-4">
                    {isNativeApp() ? t('plan.on') : t('plan.web_on')}
                </p>
            )}

            {/* ── Existing plans ───────────────────────────────────────────── */}
            {visiblePlans.length === 0
                ? <p className={`text-xs ${muted} mb-2`}>{t('plan.empty')}</p>
                : visiblePlans.map(p => {
                    const overdue = overdueOf(p.id);
                    const editing = editingId === p.id;
                    return (
                        <div key={p.id} className={`py-3 border-b border-[var(--color-m3-outline-variant)] flex items-center gap-3 ${editing ? 'bg-[var(--color-m3-surface-container)] -mx-2 px-2 rounded-[var(--radius-md)]' : ''}`}>
                            {/* Tapping the plan opens it for editing — it used to toggle
                                enabled on tap, which was the reported "点一下就变灰但改不了". */}
                            <button
                                type="button"
                                onClick={() => (editing ? closeForm() : editPlan(p))}
                                aria-expanded={editing}
                                className="flex-1 min-w-0 text-start"
                            >
                                <span className={`text-m3-body-medium font-medium block truncate ${p.enabled ? on : muted}`}>
                                    {p.alias || t(`ester.${p.ester}`)}
                                    {overdue && p.enabled && <span className="text-[var(--color-m3-warning)]"> ⚠</span>}
                                </span>
                                <span className={`text-xs block truncate ${muted} mt-0.5`}>
                                    {t(`ester.${p.ester}`)}{p.route ? ` · ${t(`route.${p.route}`)}` : ''}{p.route === Route.patchApply && typeof p.extras?.[ExtraKey.releaseRateUGPerDay] === 'number' ? ` · ${p.extras[ExtraKey.releaseRateUGPerDay]} µg/day` : p.dose ? ` · ${p.dose}` : ''}{` · ${scheduleSummary(p)}`}
                                </span>
                            </button>
                            {/* The on/off is its own switch now, so the row's tap target
                                means "edit" rather than silently changing state. */}
                            <Switch checked={p.enabled} onChange={() => togglePlan(p.id)} label={t('plan.enabled_label')} />
                            <button type="button" onClick={() => removePlan(p.id)} aria-label={t('plan.remove')} className={`shrink-0 p-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] ${muted}`}>
                                <Icon icon={Trash2} size={16} />
                            </button>
                        </div>
                    );
                })}

            {/* ── Add / edit form ─────────────────────────────────────────── */}
            {/* Collapsed, this is a single button; open, it is the form. The body
                animates with the grid-template-rows 0fr↔1fr trick — a smooth height
                change with no JS measurement and no layout thrash — while the header
                (button ↔ title + Cancel) swaps instantly. The fields stay mounted so
                the picker state survives, and `inert` keeps the hidden form out of the
                tab order. */}
            <div className="mt-4">
                {!formOpen ? (
                    <button
                        type="button"
                        onClick={() => { emptyForm(); setFormOpen(true); }}
                        className="m3-btn m3-btn-tonal w-full"
                    >
                        <span className="inline-flex items-center gap-1.5"><Icon icon={Plus} size={16} />{t('plan.add_open')}</span>
                    </button>
                ) : (
                    <div className="flex items-center justify-between px-1">
                        <span className={`text-m3-body-medium font-medium ${on}`}>{editingId ? t('plan.edit_title') : t('plan.add_title')}</span>
                        <button type="button" onClick={closeForm} className={`text-xs font-medium ${muted} px-2 py-1`}>{t('plan.cancel')}</button>
                    </div>
                )}
                <div
                    className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
                    style={{ gridTemplateRows: formOpen ? '1fr' : '0fr', opacity: formOpen ? 1 : 0 }}
                    inert={!formOpen}
                >
                    <div className="overflow-hidden">
                        <div className="space-y-4 pt-3">
                {/* Import a drug from a saved quick-template: fills the drug, route,
                    dose and alias. Kept to the app's quiet chip style (a caption plus
                    small bordered chips, as in the quick-dose row) so it reads as a
                    helper beside the form rather than a standalone button. */}
                {importable.length > 0 && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <span className={`text-xs ${muted}`}>{t('plan.from_template')}</span>
                        {importable.map(tpl => (
                            <button
                                key={tpl.id}
                                type="button"
                                onClick={() => importTemplate(tpl)}
                                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-m3-outline-variant)] px-2.5 py-1 text-xs font-medium text-[var(--color-m3-on-surface)] transition-colors hover:bg-[var(--color-m3-surface-container)]"
                            >
                                <Icon icon={Bookmark} size={11} />
                                {tpl.name}
                            </button>
                        ))}
                    </div>
                )}

                <div className="space-y-4">
                    <div>
                        <p className={`text-xs ${muted} mb-2`}>{t('pill.sec.route')}</p>                        <PillRail items={routeItems} value={route} onSelect={(v) => setRoute(v as Route)} dense ariaLabel={t('plan.add_route')} />
                    </div>
                    <div>
                        <p className={`text-xs ${muted} mb-2`}>{t('pill.sec.drug')}</p>
                        <PillRail items={esterItems} value={ester} onSelect={(v) => setEster(v as Ester)} dense animateKey={route} ariaLabel={t('plan.add_drug')} />
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                        <span className={fieldLabel}>{t('plan.add_alias')}</span>
                        <input value={alias} onChange={e => setAlias(e.target.value)} placeholder={t('plan.add_alias_ph')} className="input-base" />
                    </label>
                    {route !== Route.patchApply && (
                        <label className="block">
                            <span className={fieldLabel}>{t('plan.add_dose')}</span>
                            <span className="flex items-center gap-2">
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    step="0.001"
                                    value={dose}
                                    onChange={e => setDose(e.target.value)}
                                    placeholder="2"
                                    className="hrt-num tabular-nums"
                                />
                                <span className="shrink-0 text-xs text-[var(--color-m3-on-surface-variant)]">mg</span>
                            </span>
                        </label>
                    )}
                </div>
                {route === Route.patchApply && (
                    <PatchFields
                        patchMode={patchMode}
                        setPatchMode={setPatchMode}
                        patchRate={patchRate}
                        setPatchRate={setPatchRate}
                        rawDose={dose}
                        onRawChange={setDose}
                        patchWearDays={patchWearDays}
                        setPatchWearDays={setPatchWearDays}
                        route={route}
                    />
                )}

                <div>
                    <span className={fieldLabel}>{t('plan.add_mode')}</span>
                    <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={t('plan.add_mode')}>
                        {MODES.map(m => (
                            <button
                                key={m}
                                type="button"
                                aria-pressed={mode === m}
                                onClick={() => setMode(m)}
                                className={`m3-btn m3-btn-sm ${mode === m ? 'm3-btn-filled' : 'm3-btn-outlined'}`}
                            >
                                {modeLabel(m)}
                            </button>
                        ))}
                    </div>
                </div>

                {/* The first dose is shared by all three modes: a per-day schedule
                    reads as "when is the first one", the extras are what 'times' adds. */}
                {timeField(t('plan.add_first'), 'first', firstTime, setFirstTime)}

                {mode === 'times' && (
                    <div className="space-y-3">
                        {extraTimes.map((e, i) => (
                            <React.Fragment key={e.id}>
                                {timeField(
                                    t('plan.add_dose_n').replace('{n}', String(i + 2)),
                                    e.id,
                                    e.date,
                                    (d) => setExtraTimes(prev => prev.map(x => x.id === e.id ? { ...x, date: d } : x)),
                                    () => setExtraTimes(prev => prev.filter(x => x.id !== e.id)),
                                )}
                            </React.Fragment>
                        ))}
                        <button type="button" onClick={addExtraTime} className="m3-btn m3-btn-outlined m3-btn-sm w-full">
                            <span className="inline-flex items-center gap-1.5"><Icon icon={Plus} size={15} />{t('plan.add_dose_add')}</span>
                        </button>
                    </div>
                )}

                {mode === 'hours' && numField(t('plan.add_interval'), intervalHours, setIntervalHours, 1, 72)}
                {mode === 'days' && numField(t('plan.add_every'), everyDays, setEveryDays, 1, 365)}

                <button
                    type="button"
                    onClick={submitPlan}
                    disabled={route === Route.patchApply ? (patchMode === 'rate' ? !patchRate.trim() : !dose.trim()) : !dose.trim()}
                    className="m3-btn m3-btn-filled w-full"
                >
                    <span className="inline-flex items-center gap-1.5"><Icon icon={editingId ? Check : Plus} size={16} />{editingId ? t('plan.save') : t('plan.add_submit')}</span>
                </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MedPlanSettings;
