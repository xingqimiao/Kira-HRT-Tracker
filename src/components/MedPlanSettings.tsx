import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import CustomSelect from './CustomSelect';
import { useTranslation } from '../contexts/LanguageContext';
import { Ester, Route } from '../../logic';
import DateTimePicker from './DateTimePicker';
import { ChevronRight, Clock3 as Clock, Plus, Trash2, Bookmark } from '../icons';
import type { DoseTemplate } from './DoseForm';
import {
    readMedPlans, writeMedPlans, sanitizeMedPlans, isSavedTemplate, type MedPlan, type PlanStatus, type PlanTime,
    planStatuses, migrateOldRemindersToPlans,
    isPlanNotificationGranted, requestPlanNotificationPermission,
} from '../utils/medPlanNotify';
import { reschedulePlanNotifications } from '../utils/medPlanNotify';
import { syncPushRegistration } from '../utils/pushRegister';
import { isNativeApp } from '../utils/platform';
import { pushMedPlan } from '../services/coreSync';
import { useCoreSession } from '../hooks/useCoreSession';
import { useHRTMode } from '../contexts/HRTModeContext';

type PlanMode = 'times' | 'hours' | 'days';

const ESTERS = Object.values(Ester);
const ROUTES = Object.values(Route);
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
    const { isTransmasc } = useHRTMode();
    // Only the user's own saved templates — never a plan's auto-generated entry.
    const importable = useMemo(() => doseTemplates.filter(t => isSavedTemplate(t.id)), [doseTemplates]);
    const [plans, setPlans] = useState<MedPlan[]>(() => {
        migrateOldRemindersToPlans();
        return readMedPlans();
    });
    const [webPermission, setWebPermission] = useState(false);

    // Add-form state.
    const [ester, setEster] = useState<Ester>(Ester.E2);
    const [route, setRoute] = useState<Route>(() => (isTransmasc ? Route.injection : Route.sublingual));
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
        // The plan travels to the account as its own sealed scalar so an agent (MCP)
        // can read it and tell whether today's doses kept up. A failed push costs
        // nothing: the plan also lives on-device, and the next commit re-uploads.
        if (session.token) void pushMedPlan(session.token, clean).catch(() => undefined);
    };

    // A plan written before this build shipped never reached the server. Push the
    // on-device copy once when a session is available, so an agent sees a plan the
    // user did not re-edit after the upgrade.
    useEffect(() => {
        if (!session.token) return;
        const current = readMedPlans();
        if (current.length > 0) void pushMedPlan(session.token, current).catch(() => undefined);
    }, [session.token]);

    const status = useMemo<{ plan: MedPlan; overdue: boolean }[]>(() => {
        // The badge state shown here is a local read: the overdue badge lives on the
        // quick-record button, this row just marks the plan red when it is behind.
        return planStatuses(readMedPlans(), [], Date.now(), new Date().getTimezoneOffset()).map(st => ({ plan: st.plan, overdue: st.overdue }));
        // Recomputed when the plan list changes; a stale "overdue" here corrects
        // itself on the next visit or the next edit.
    }, [plans]);

    const overdueOf = (id: string): boolean => status.find(s => s.plan.id === id)?.overdue ?? false;

    const addPlan = (): void => {
        const plan: MedPlan = {
            id: crypto.randomUUID(),
            ester,
            route,
            alias: alias.trim() || undefined,
            dose: dose.trim(),
            mode,
            doseTimes: mode === 'times'
                ? extraTimes.map(e => ({ hour: e.date.getHours(), minute: e.date.getMinutes() }))
                : undefined,
            intervalHours: mode === 'hours' ? intervalHours : undefined,
            everyDays: mode === 'days' ? everyDays : undefined,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
            firstHour: firstTime.getHours(),
            firstMinute: firstTime.getMinutes(),
            enabled: true,
        };
        commit([...readMedPlans(), plan]);
        setAlias(''); setDose(''); setExtraTimes([]);
    };

    const removePlan = (id: string): void => commit(readMedPlans().filter(p => p.id !== id));
    const togglePlan = (id: string): void => commit(readMedPlans().map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));

    /** Fill the form from a saved quick-template (its drug, route and dose). */
    const importTemplate = (tpl: DoseTemplate): void => {
        setEster(tpl.ester);
        setRoute(tpl.route);
        setDose(`${tpl.doseMG}mg`);
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
            {plans.length === 0
                ? <p className={`text-xs ${muted} mb-2`}>{t('plan.empty')}</p>
                : plans.map(p => {
                    const overdue = overdueOf(p.id);
                    return (
                        <div key={p.id} className="py-3 border-b border-[var(--color-m3-outline-variant)] flex items-center gap-3">
                            <button
                                type="button"
                                aria-pressed={p.enabled}
                                onClick={() => togglePlan(p.id)}
                                className="flex-1 min-w-0 text-start"
                            >
                                <span className={`text-m3-body-medium font-medium block truncate ${p.enabled ? on : muted}`}>
                                    {p.alias || t(`ester.${p.ester}`)}
                                    {overdue && p.enabled && <span className="text-[var(--color-m3-warning)]"> ⚠</span>}
                                </span>
                                <span className={`text-xs block truncate ${muted} mt-0.5`}>
                                    {t(`ester.${p.ester}`)}{p.route ? ` · ${t(`route.${p.route}`)}` : ''} · {p.dose || '—'}{` · ${scheduleSummary(p)}`}
                                </span>
                            </button>
                            <button type="button" onClick={() => removePlan(p.id)} aria-label={t('plan.remove')} className={`shrink-0 p-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] ${muted}`}>
                                <Icon icon={Trash2} size={16} />
                            </button>
                        </div>
                    );
                })}

            {/* ── Add form ─────────────────────────────────────────────────── */}
            <div className="mt-6 space-y-4">
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <CustomSelect
                        label={t('plan.add_drug')}
                        value={ester}
                        onChange={v => setEster(v as Ester)}
                        options={ESTERS.map(e => ({ value: e, label: t(`ester.${e}`) }))}
                    />
                    <CustomSelect
                        label={t('plan.add_route')}
                        value={route}
                        onChange={v => setRoute(v as Route)}
                        options={ROUTES.map(r => ({ value: r, label: t(`route.${r}`) }))}
                    />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                        <span className={fieldLabel}>{t('plan.add_alias')}</span>
                        <input value={alias} onChange={e => setAlias(e.target.value)} placeholder={t('plan.add_alias_ph')} className="input-base" />
                    </label>
                    <label className="block">
                        <span className={fieldLabel}>{t('plan.add_dose')}</span>
                        <input value={dose} onChange={e => setDose(e.target.value)} placeholder="2mg" className="input-base" />
                    </label>
                </div>

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
                    onClick={addPlan}
                    disabled={!dose.trim()}
                    className="m3-btn m3-btn-filled w-full"
                >
                    <span className="inline-flex items-center gap-1.5"><Icon icon={Plus} size={16} />{t('plan.add_submit')}</span>
                </button>
            </div>
        </div>
    );
};

export default MedPlanSettings;
