import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import Switch from './Switch';
import { useTranslation } from '../contexts/LanguageContext';
import { Ester, Route, ExtraKey } from '../../logic';
import { TimePage } from './TimePage';
import { Clock3 as Clock, Plus, Trash2, Check } from '../icons';
import type { DoseTemplate } from './DoseForm';

import PatchFields from './dose_form/PatchFields';
import { SegmentedList, SegmentedListItem } from '../ui/proto';
import { FullScreenSheet } from '../ui/FullScreenSheet';
import { rememberTransformSource } from '../ui/ContainerTransform';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import { cookie } from '../ui/cookie';
import {
    readMedPlans, writeMedPlans, sanitizeMedPlans, isSavedTemplate, type MedPlan, type PlanTime,
    migrateOldRemindersToPlans,
    isPlanNotificationGranted, requestPlanNotificationPermission, openNativeNotificationSettings,
    arePlanNotificationsMuted, resumePlanNotifications, stopPlanWebNotifications,
} from '../utils/medPlanNotify';
import { plansForMode, localDateKey } from '../utils/medPlan';
import {
    categoriesOf,
    categoryForEster,
    drugTitle,
    drugsFor,
    matchDrug,
    modeOf,
    routesFor,
    type CatId,
} from './dose_form/catalog';
import { reschedulePlanNotifications } from '../utils/medPlanNotify';
import { syncPushRegistration } from '../utils/pushRegister';
import { isNativeApp } from '../utils/platform';
import { useCoreSession } from '../hooks/useCoreSession';
import { useHRTMode } from '../contexts/HRTModeContext';

type PlanMode = 'times' | 'hours' | 'days';

const MODES: readonly PlanMode[] = ['times', 'hours', 'days'];
const HERO_COOKIE_D = cookie(0, 0, 72, 9, 0.09).d;

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
    /**
     * The user's own off switch, which is a different thing from the permission.
     *
     * A page cannot take back a browser permission and an Android app cannot
     * disable its own channel, so "already granted" used to be the only state the
     * screen could show — there was nothing to tap to stop the reminders. This is
     * that tap.
     */
    const [mutedPref, setMutedPref] = useState(() => arePlanNotificationsMuted());
    const notifyOn = webPermission && !mutedPref;
    const visiblePlans = useMemo(() => plansForMode(plans, hrtMode), [plans, hrtMode]);

    // Add-form state. The picker is the record panel's catalogue: category first,
    // then that category's routes, then its drugs. The old route→ester matrix
    // dropped the category entirely, so picking an anti-androgen erased the rail.
    const doseMode = modeOf(isTransmasc);
    const initialCat = categoryForEster(doseMode, Ester.E2);
    const [cat, setCat] = useState<CatId>(initialCat);
    const [ester, setEster] = useState<Ester>(Ester.E2);
    const [route, setRoute] = useState<Route>(() => routesFor(doseMode, initialCat)[0].id);
    const [cookieDeg, setCookieDeg] = useState(0);
    const routeChoices = useMemo(() => routesFor(doseMode, cat).map(r => r.id), [doseMode, cat]);
    const routeDrugs = useMemo(
        () => drugsFor(doseMode, cat).filter(d => d.route === route),
        [doseMode, cat, route],
    );
    const esterChoices = useMemo(() => routeDrugs.map(d => d.ester), [routeDrugs]);
    const selectedDrug = useMemo(
        () => drugsFor(doseMode, cat).find(d => d.route === route && d.ester === ester)
            ?? drugsFor(doseMode, cat).find(d => d.route === route)
            ?? drugsFor(doseMode, cat)[0],
        [doseMode, cat, route, ester],
    );
    useEffect(() => {
        setCookieDeg(degrees => degrees + 40);
    }, [selectedDrug?.id]);
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
        void isPlanNotificationGranted().then(v => {
            if (cancelled) return;
            setWebPermission(v);
            setMutedPref(arePlanNotificationsMuted());
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, []);

    // The permission can change while this section is open — most of all when the
    // native "enable" button sent the user to the system notification settings. Re-read
    // it on return (a read, not a request, so nothing prompts on every focus) and flip
    // the button. Native reminders are rescheduled by App's own focus handler.
    useEffect(() => {
        const recheck = (): void => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            void isPlanNotificationGranted().then(v => {
                setWebPermission(v);
                setMutedPref(arePlanNotificationsMuted());
            }).catch(() => undefined);
        };
        document.addEventListener('visibilitychange', recheck);
        window.addEventListener('focus', recheck);
        return () => {
            document.removeEventListener('visibilitychange', recheck);
            window.removeEventListener('focus', recheck);
        };
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

    // No overdue marker in this list: a plan is a standing schedule, not a to-do, so
    // flagging it here duplicated the home banner on every visit and read as an alarm
    // the user could not clear. The home banner is the single place that says "behind".

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
        const firstCat = categoryForEster(doseMode, Ester.E2);
        const firstRoute = routesFor(doseMode, firstCat)[0].id;
        const firstDrug = drugsFor(doseMode, firstCat).find(d => d.route === firstRoute);
        setCat(firstCat);
        setEster(firstDrug?.ester ?? Ester.E2);
        setRoute(firstRoute);
        setAlias('');
        setDose(firstDrug ? String(firstDrug.def) : '');
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
        setCat(categoryForEster(doseMode, p.ester));
        setEster(p.ester);
        setRoute(p.route ?? routesFor(doseMode, categoryForEster(doseMode, p.ester))[0].id);
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
                const fallbackRoute = routeChoices[0];
                const fallbackEster = esterChoices[0];
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
        const matched = matchDrug(doseMode, tpl.route, tpl.ester);
        if (!matched) return;
        setCat(matched.cat);
        setRoute(matched.route);
        setEster(matched.ester);
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
            // Clearing the opt-out is part of enabling: a device that was muted
            // keeps the permission, so without this the button would look dead.
            setMutedPref(false);
            resumePlanNotifications();
            // Native: (re)schedule the repeating system reminders now that it is allowed.
            // Web: start the 60-second in-app check.
            if (isNativeApp()) {
                void reschedulePlanNotifications().catch(() => undefined);
            }
            // Bind this device's FCM token so the server can send a catch-up nudge
            // for a dose that was never logged. Both transports; no-op until signed in.
            if (session.token) void syncPushRegistration(session.token).catch(() => undefined);
        } else if (isNativeApp()) {
            // The plugin cannot re-ask once notifications are off in system settings, so
            // the in-app button would appear inert. Send the user to the one screen that
            // can turn them back on; the focus/visibility recheck above flips this state
            // when they return.
            openNativeNotificationSettings();
        }
    };

    /**
     * The off switch beside the granted state.
     *
     * Web: clears the interval and records the opt-out, so App's launch-time start
     * refuses to re-arm it. Native: the app cannot revoke its own channel, so the
     * control opens the system screen where it can be turned off — labelled for
     * what it does rather than pretending to be a local switch.
     */
    const turnNotificationsOff = (): void => {
        if (isNativeApp()) {
            openNativeNotificationSettings();
            return;
        }
        stopPlanWebNotifications();
        setMutedPref(true);
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
        // Never write `undefined` when the mode change temporarily leaves no
        // compatible route: that made the two reconciliation effects oscillate
        // until React hit "Maximum update depth".
        if (routeChoices.length === 0) return;
        if (!routeChoices.includes(route)) setRoute(routeChoices[0]);
    }, [routeChoices, route]);
    useEffect(() => {
        if (esterChoices.length === 0) return;
        if (!esterChoices.includes(ester)) setEster(esterChoices[0]);
    }, [esterChoices, ester]);

    // A mode switch can remove the selected category entirely (anti-androgens
    // do not exist in masculinising mode). Land on the first category of the new
    // catalogue instead of leaving the picker empty.
    useEffect(() => {
        if (categoriesOf(doseMode).some(category => category.id === cat)) return;
        const nextCat = categoryForEster(doseMode, Ester.E2);
        const nextRoute = routesFor(doseMode, nextCat)[0].id;
        const nextDrug = drugsFor(doseMode, nextCat).find(d => d.route === nextRoute);
        setCat(nextCat);
        setRoute(nextRoute);
        if (nextDrug) {
            setEster(nextDrug.ester);
            setDose(String(nextDrug.def));
        }
    }, [doseMode, cat]);

    // The plan editor uses the same route box and drug pills as the record
    // panel. Two selectors for the same choice is how they drift.
    const ROUTE_ICON: Record<Route, string> = {
        [Route.oral]: 'pill',
        [Route.sublingual]: 'tongue',
        [Route.gel]: 'gel',
        [Route.injection]: 'syr',
        [Route.patchApply]: 'patch',
        [Route.patchRemove]: 'peel',
    };

    // A time row in the same `.li` vocabulary as the record panel: clock glyph,
    // HH:MM, caption, chevron. The old white `.input-base` box was the visual
    // seam the user kept seeing.
    const timeField = (label: string, key: string, date: Date, onPick: (d: Date) => void, onRemove?: () => void) => (
        <React.Fragment>
            <div
                className="li"
                role="button"
                tabIndex={0}
                aria-expanded={openPicker === key}
                onClick={() => setOpenPicker(v => v === key ? null : key)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setOpenPicker(v => v === key ? null : key);
                    }
                }}
            >
                <div className="ic p"><SpriteIcon id="clock" /></div>
                <div className="tx">
                    <div className="t">{hhmm(date)}</div>
                    <div className="s">{label}</div>
                </div>
                {onRemove && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onRemove(); }}
                        aria-label={t('plan.remove')}
                        className="icon-del"
                    >
                        <Icon icon={Trash2} size={17} />
                    </button>
                )}
                <SpriteIcon id="chev" />
            </div>
            {/* Sibling, not a child, of the row: React portals bubble synthetic
                events through the React tree. Nested inside the row, every click
                in the time page reached the row's onClick and closed it at once. */}
            <TimePage
                open={openPicker === key}
                mode="time"
                onClose={() => setOpenPicker(null)}
                onConfirm={(d) => { onPick(d); setOpenPicker(null); }}
                initialDate={date}
                title={label}
            />
        </React.Fragment>
    );

    const chooseCategory = (nextCat: CatId) => {
        const nextRoute = routesFor(doseMode, nextCat)[0].id;
        const nextDrug = drugsFor(doseMode, nextCat).find(d => d.route === nextRoute);
        setCat(nextCat);
        setRoute(nextRoute);
        if (nextDrug) {
            setEster(nextDrug.ester);
            if (nextRoute === Route.patchApply) setPatchRate(String(nextDrug.def));
            else setDose(String(nextDrug.def));
        }
        setPatchMode('rate');
    };

    const chooseRoute = (nextRoute: Route) => {
        const nextDrug = drugsFor(doseMode, cat).find(d => d.route === nextRoute);
        setRoute(nextRoute);
        if (nextDrug) {
            setEster(nextDrug.ester);
            if (nextRoute === Route.patchApply) setPatchRate(String(nextDrug.def));
            else setDose(String(nextDrug.def));
        }
        if (nextRoute === Route.patchApply) setPatchMode('rate');
    };

    const chooseDrug = (nextDrug: { ester: Ester; route: Route; def: number }) => {
        setEster(nextDrug.ester);
        if (nextDrug.route === Route.patchApply) {
            setPatchMode('rate');
            setPatchRate(String(nextDrug.def));
        } else {
            setDose(String(nextDrug.def));
        }
    };

    const heroTone = cat === 'aa' || cat === 'cycle'
        ? ' aux-mode'
        : cat === 'progest' || cat === 'hair'
            ? ' progest-mode'
            : '';

    const planHeroValue = route === Route.patchApply
        ? (patchMode === 'rate' ? patchRate : dose)
        : dose;
    const planHeroUnit = route === Route.patchApply && patchMode === 'rate' ? 'µg/d' : 'mg';
    const setPlanHeroValue = (value: string) => {
        if (route === Route.patchApply && patchMode === 'rate') setPatchRate(value);
        else setDose(value);
    };
    const nudgePlanDose = (direction: number) => {
        const step = route === Route.patchApply && patchMode === 'rate' ? 25 : 0.5;
        const current = Number.parseFloat(planHeroValue) || 0;
        setPlanHeroValue(String(Math.max(0, current + direction * step)));
    };

    return (
        <div className="d-col" style={{ gap: 10 }}>
            <div className="hrow">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon icon={Clock} size={16} className={muted} />
                    <span className={`text-m3-body-medium font-medium ${on}`}>{t('plan.title')}</span>
                </div>
            </div>

            {/* Notification permission, per transport — the APK asks the system, the
                web asks the browser; both surface the same control. Once granted,
                the state is a row with a switch-off beside it: a bare green "已开启"
                line was neither a button nor a container, and left the user with no
                way back. */}
            {!notifyOn ? (
                <button type="button" onClick={() => void askWebPermission()} className="btn tonal-add" style={{ marginTop: 0 }}>
                    {isNativeApp() ? t('plan.enable') : t('plan.web_enable')}
                </button>
            ) : (
                <div className="list">
                    <div className="li is-static" style={{ cursor: 'default' }}>
                        <span className="ic p"><SpriteIcon id="bell" /></span>
                        <div className="t">
                            <b>{t('plan.notify_title')}</b>
                            <span className="s">{isNativeApp() ? t('plan.on') : t('plan.web_on')}</span>
                        </div>
                        {/* Tonal, not `.btn.x`: this row is already `--sch`, so a
                            surface-container button on it would have no visible
                            container at all. */}
                        <button type="button" onClick={turnNotificationsOff} className="btn t" style={{ minWidth: 0 }}>
                            {isNativeApp() ? t('plan.system_settings') : t('plan.disable')}
                        </button>
                    </div>
                </div>
            )}

            {/* ── Existing plans ───────────────────────────────────────────── */}
            {visiblePlans.length === 0 ? (
                <div className="card">
                    <div className="empty" style={{ padding: '20px 0 12px' }}>
                        <p style={{ margin: 0 }}>{t('plan.empty')}</p>
                    </div>
                </div>
            ) : (
                <SegmentedList label={t('plan.title')}>
                    {visiblePlans.map(p => {
                        return (
                            <div key={p.id} className="li" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                                <button
                                    type="button"
                                    onClick={() => editPlan(p)}
                                    aria-expanded={editingId === p.id}
                                    style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'none', font: 'inherit', color: 'inherit', padding: 0 }}
                                >
                                    <b style={{ color: p.enabled ? 'var(--on)' : 'var(--var)' }}>
                                        {p.alias || t(`ester.${p.ester}`)}
                                    </b>
                                    <span className="s" style={{ whiteSpace: 'normal' }}>
                                        {t(`ester.${p.ester}`)}
                                        {p.route ? ` · ${t(`route.${p.route}`)}` : ''}
                                        {p.route === Route.patchApply && typeof p.extras?.[ExtraKey.releaseRateUGPerDay] === 'number'
                                            ? ` · ${p.extras[ExtraKey.releaseRateUGPerDay]} µg/day`
                                            : p.dose ? ` · ${p.dose}` : ''}
                                        {` · ${scheduleSummary(p)}`}
                                    </span>
                                </button>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
                                    <Switch checked={p.enabled} onChange={() => togglePlan(p.id)} label={t('plan.enabled_label')} />
                                    <button
                                        type="button"
                                        onClick={() => removePlan(p.id)}
                                        aria-label={t('plan.remove')}
                                        title={t('plan.remove')}
                                        className="ic-btn danger"
                                        style={{ width: 38, height: 38, borderRadius: 19 }}
                                    >
                                        <Icon icon={Trash2} size={16} />
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </SegmentedList>
            )}

            <button
                type="button"
                onClick={(e) => { rememberTransformSource(e.currentTarget); emptyForm(); setFormOpen(true); }}
                className="btn tonal-add"
            >
                <Icon icon={Plus} size={17} />
                {t('plan.add_open')}
            </button>

            {/* The editor is its own full-screen page. It used to grow inline under
                the list, which made a long scheduling form share a scroll with the
                plans and left the drug picker in the old picture-rail style. */}
            <FullScreenSheet bare open={formOpen} onClose={closeForm} title={editingId ? t('plan.edit_title') : t('plan.add_title')}>
                <div className="dose-panel">
                    <div className="hdr">
                        <div className="hdr-l">
                            <button type="button" onClick={closeForm} className="ic-btn" aria-label={t('plan.cancel')}>
                                <SpriteIcon id="chev" style={{ transform: 'rotate(180deg)' }} />
                            </button>
                            <span className="hdr-title">{editingId ? t('plan.edit_title') : t('plan.add_title')}</span>
                        </div>
                        <div className="hdr-r">
                            {editingId ? (
                                <button type="button" onClick={() => removePlan(editingId)} className="ic-btn" aria-label={t('plan.remove')} style={{ color: 'var(--err)' }}>
                                    <Icon icon={Trash2} size={19} />
                                </button>
                            ) : null}
                        </div>
                    </div>

                    <div className="dose-body">
                        {importable.length > 0 && (
                            <div className="tpl-strip" style={{ padding: '4px 0 10px' }}>
                                <span className="tpl-empty">{t('plan.from_template')}</span>
                                {importable.map(tpl => (
                                    <button key={tpl.id} type="button" onClick={() => importTemplate(tpl)} className="tpl-chip">
                                        <SpriteIcon id="mark" />
                                        {tpl.name}
                                    </button>
                                ))}
                            </div>
                        )}

                        <div className="cg" aria-label={t('plan.add_drug')}>
                            {categoriesOf(doseMode).map(category => (
                                <button
                                    type="button"
                                    key={category.id}
                                    className={cat === category.id ? 'on' : ''}
                                    data-m
                                    style={{ ['--mo' as string]: '12px' }}
                                    onClick={() => chooseCategory(category.id)}
                                >
                                    {t(category.nameKey)}
                                </button>
                            ))}
                        </div>

                        <div className="desk-grid">
                            <div>
                                <div className={`route-box${routeChoices.length <= 1 ? ' single' : ''}`} role="group" aria-label={t('plan.add_route')}>
                                    <div className="rg-strip">
                                        {routeChoices.map(r => (
                                            <button
                                                type="button"
                                                key={r}
                                                className={`rt-item${route === r ? ' on' : ''}`}
                                                data-m
                                                style={{ ['--mo' as string]: '14px' }}
                                                aria-pressed={route === r}
                                                onClick={() => chooseRoute(r)}
                                            >
                                                <SpriteIcon id={ROUTE_ICON[r]} />
                                                {t(`pill.route.${r}`)}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="drug-sub" key={`drugs-${cat}-${route}`} role="group" aria-label={t('plan.add_drug')}>
                                        {routeDrugs.map((drug, idx) => (
                                            <button
                                                type="button"
                                                key={drug.id}
                                                className={`drug-pill anim-in${ester === drug.ester ? ' on' : ''}`}
                                                style={{ animationDelay: `${idx * 35}ms`, ['--mo' as string]: '10px' }}
                                                data-m
                                                aria-pressed={ester === drug.ester}
                                                onClick={() => chooseDrug(drug)}
                                            >
                                                {drugTitle(drug, t)}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className={`dose-hero anim-in${heroTone}`}>
                                    <svg className="hero-cookie" viewBox="-80 -80 160 160" style={{ transform: `rotate(${cookieDeg}deg)` }} aria-hidden="true">
                                        <path d={HERO_COOKIE_D} fill="currentColor" />
                                    </svg>
                                    <div className="dh-top">
                                        <div className="dh-drug">{selectedDrug ? drugTitle(selectedDrug, t) : t(`ester.${ester}`)}</div>
                                    </div>
                                    <div className="dh-main">
                                        <button
                                            type="button"
                                            className="step-btn"
                                            data-m
                                            style={{ ['--mo' as string]: '26px 10px 26px 10px' }}
                                            onClick={() => nudgePlanDose(-1)}
                                            aria-label="-"
                                        >
                                            −
                                        </button>
                                        <div className="dh-val-wrap">
                                            <div className="dh-num-row">
                                                <input
                                                    className="dh-input"
                                                    type="text"
                                                    inputMode="decimal"
                                                    value={planHeroValue}
                                                    placeholder="0.0"
                                                    aria-label={t('plan.add_dose')}
                                                    onChange={(e) => setPlanHeroValue(e.target.value.replace(/[^\d.]/g, ''))}
                                                />
                                                <span className="dh-unit">{planHeroUnit}</span>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="step-btn"
                                            data-m
                                            style={{ ['--mo' as string]: '10px 26px 10px 26px' }}
                                            onClick={() => nudgePlanDose(1)}
                                            aria-label="+"
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>

                                {route === Route.patchApply && (
                                    <PatchFields
                                        patchMode={patchMode}
                                        setPatchMode={setPatchMode}
                                        patchWearDays={patchWearDays}
                                        setPatchWearDays={setPatchWearDays}
                                    />
                                )}
                            </div>

                            <div>
                                <div className="list">
                                    <label className="li" style={{ cursor: 'default' }}>
                                        <div className="ic"><SpriteIcon id="note" /></div>
                                        <div className="tx">
                                            <div className="t">{t('plan.add_alias')}</div>
                                        </div>
                                        <input
                                            className="plan-input"
                                            value={alias}
                                            onChange={e => setAlias(e.target.value)}
                                            placeholder={t('plan.add_alias_ph')}
                                        />
                                    </label>
                                </div>

                                <div className="lab" style={{ marginTop: 14 }}>{t('plan.add_mode')}</div>
                                <div className="cg">
                                    {MODES.map(m => (
                                        <button
                                            type="button"
                                            key={m}
                                            className={mode === m ? 'on' : ''}
                                            data-m
                                            style={{ ['--mo' as string]: '12px' }}
                                            onClick={() => setMode(m)}
                                        >
                                            {modeLabel(m)}
                                        </button>
                                    ))}
                                </div>

                                <div className="list" style={{ marginTop: 10 }}>
                                    {timeField(t('plan.add_first'), 'first', firstTime, setFirstTime)}
                                    {mode === 'times' && extraTimes.map((e, i) => (
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
                                    {mode === 'hours' && (
                                        <label className="li" style={{ cursor: 'default' }}>
                                            <div className="t"><b>{t('plan.add_interval')}</b></div>
                                            <input
                                                type="number"
                                                inputMode="numeric"
                                                min={1}
                                                max={72}
                                                value={intervalHours}
                                                onChange={e => setIntervalHours(Math.max(1, Math.min(72, Number(e.target.value) || 1)))}
                                                className="num-pill tabular-nums"
                                            />
                                        </label>
                                    )}
                                    {mode === 'days' && (
                                        <label className="li" style={{ cursor: 'default' }}>
                                            <div className="t"><b>{t('plan.add_every')}</b></div>
                                            <input
                                                type="number"
                                                inputMode="numeric"
                                                min={1}
                                                max={365}
                                                value={everyDays}
                                                onChange={e => setEveryDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
                                                className="num-pill tabular-nums"
                                            />
                                        </label>
                                    )}
                                </div>

                                {mode === 'times' && (
                                    <button type="button" onClick={addExtraTime} className="btn tonal-add" style={{ marginTop: 10 }}>
                                        <Icon icon={Plus} size={16} />
                                        {t('plan.add_dose_add')}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="bot-bar">
                        <button type="button" onClick={closeForm} className="tpl-toggle" data-m style={{ ['--mo' as string]: '14px' }}>
                            <SpriteIcon id="chev" style={{ transform: 'rotate(180deg)' }} />
                            {t('plan.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={submitPlan}
                            disabled={route === Route.patchApply ? (patchMode === 'rate' ? !patchRate.trim() : !dose.trim()) : !dose.trim()}
                            className="save-btn"
                            data-m
                            style={{ ['--mo' as string]: '16px' }}
                        >
                            <Icon icon={editingId ? Check : Plus} size={17} />
                            {editingId ? t('plan.save') : t('plan.add_submit')}
                        </button>
                    </div>
                </div>
            </FullScreenSheet>
        </div>
    );
};

export default MedPlanSettings;

