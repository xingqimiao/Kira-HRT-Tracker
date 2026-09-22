import { useState, useEffect, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { DoseEvent, Route, Ester, SimulationResult, runSimulation, interpolateConcentration_E2, interpolateConcentration_T, LabResult, computeCalibration, CalibrationMethod, CalibrationHistoryMode, normalizeCalibrationMethod, AntiandrogenChartMode, normalizeAntiandrogenChartMode, isTestosteroneEster, isT_LabUnit, PKCustomParams, applyPKOverrides, sanitizePKParams, isPlausibleBodyWeightKG,
         RecheckIntervals, normalizeRecheckIntervals,
         OcrModelTier, normalizeOcrModelTier,
         PkEngineId, normalizePkEngine, DEFAULT_PK_ENGINE,
         BODY_WEIGHT_KG_MIN, BODY_WEIGHT_KG_MAX, DOSE_MG_MAX, SPIRO_MG_MAX_PER_DAY,
         EVENT_TIME_H_MIN, EVENT_TIME_H_MAX } from '../../logic';
import { builtinEngine, chooseEngine, loadVendorEngine, type PkEngine } from '../engine/registry';
import { createDayLabelFormatter, toDayKey } from '../utils/helpers';
import { useTranslation } from '../contexts/LanguageContext';
import { useHRTMode } from '../contexts/HRTModeContext';
import {
    MODE_KEYS, RecordKind, SyncState, Tombstones,
    pruneTombstones, sanitizeTombstones,
} from '../utils/syncMerge';
import { applyAppSettings, appSettingsStamp, readAppSettings, touchAppSettings } from '../utils/appSettings';
import { JournalEntry, sanitizeJournalEntries } from '../utils/bodyJournal';
import { hrtDaysSince, normalizeHrtStartDate } from '../utils/hrtStart';
import { milestoneFor } from '../utils/hrtMilestone';
import { isThirdDayStreak } from '../utils/hrtStreak';

/** Namespace used while signed out. Its keys are the original, un-prefixed ones. */
const LOCAL_OWNER = 'local';

// Storage keys are namespaced by account as well as by HRT mode. Without the
// account half, a shared device (family tablet, clinic kiosk, installed PWA)
// showed the previous user's full dose history to whoever signed in next, and
// the auto-backup then encrypted those records under the new account's key and
// uploaded them.
//
// Signed-out keys keep their original, un-prefixed names, so records written
// before this change — and by anyone who never signs in — are still found
// exactly where they were.
const nsFor = (owner: string, suffix: string) =>
    owner === LOCAL_OWNER ? `hrt-${suffix}` : `hrt-u${owner}-${suffix}`;

const modeKeyFor = (owner: string, mode: 'transfem' | 'transmasc', suffix: string) =>
    nsFor(owner, mode === 'transmasc' ? `masc-${suffix}` : suffix);

const MODE_SUFFIXES = ['events', 'lab-results', 'dose-templates', 'quick-doses', 'journal', 'deletions'] as const;
const SHARED_SUFFIXES = [
    'weight', 'pk-params', 'cal-method', 'cal-history-mode', 'aa-chart', 'hrt-start',
    'recheck-intervals', 'ocr-model-tier', 'pk-engine',
    'weight-at', 'pk-params-at',
    // Which milestone this device has already celebrated, as `YYYY-MM-DD:key`.
    // Device-local by design — see `pendingMilestone` below.
    'hrt-milestone',
    // Which due re-checks this device has closed, per reminder kind — see
    // `dismissRecheck`. Device-local for the same reason as the milestone.
    'recheck-dismissed',
] as const;

/**
 * First sign-in on this device adopts whatever was recorded while signed out.
 *
 * The entries are *moved*, not copied: leaving a copy behind under the
 * signed-out names is exactly the leak this namespacing exists to close, since
 * the next person to use the device would land on them. Adoption is skipped
 * once the account's namespace holds anything, so signing in on a second device
 * can't overwrite records already there.
 */
function adoptSignedOutData(owner: string): void {
    if (owner === LOCAL_OWNER) return;
    const moves: [string, string][] = [];
    for (const m of ['transfem', 'transmasc'] as const) {
        for (const s of MODE_SUFFIXES) {
            moves.push([modeKeyFor(LOCAL_OWNER, m, s), modeKeyFor(owner, m, s)]);
        }
    }
    for (const s of SHARED_SUFFIXES) moves.push([nsFor(LOCAL_OWNER, s), nsFor(owner, s)]);

    if (moves.some(([, to]) => localStorage.getItem(to) !== null)) return;
    for (const [from, to] of moves) {
        const value = localStorage.getItem(from);
        if (value === null) continue;
        localStorage.setItem(to, value);
        localStorage.removeItem(from);
    }
}

export interface DoseTemplate {
    id: string;
    name: string;
    route: Route;
    ester: Ester;
    doseMG: number;
    extras: any;
    createdAt: number;
    /** Epoch ms of the last edit — see DoseEvent.updatedAt. */
    updatedAt?: number;
}

export interface QuickDose {
    id: string;
    route: Route;
    ester: Ester;
    value: number;
    createdAt: number;
}

/** One day's worth of dose records, as the history list renders them. */
export interface DoseDayGroup {
    /** Stable "YYYY-MM-DD" identity. For grouping and React keys, never for display. */
    key: string;
    /** What the section heading shows, in the reader's language. */
    label: string;
    events: DoseEvent[];
}

export const useAppData = (
    showDialog: (type: 'alert' | 'confirm', message: string, onConfirm?: () => void) => void,
    /**
     * Storage owner: the signed-in account id, or null while signed out.
     *
     * Storage is keyed by this value, so getting it wrong does not error — it
     * silently reads and writes another account's namespace. Hence an explicit
     * parameter rather than something read from a context inside the hook, so the
     * precedence is visible at the call site.
     */
    ownerOverride?: string | null,
) => {
    const { t, lang } = useTranslation();
    const { mode, isTransmasc } = useHRTMode();

    // Everything below is scoped to (account, mode). `scope` is the composite the
    // reload/persist handshake keys on — see loadedScopeRef.
    const owner = ownerOverride ?? LOCAL_OWNER;
    const scope = `${owner}|${mode}`;
    const keyFor = (m: 'transfem' | 'transmasc', suffix: string) => modeKeyFor(owner, m, suffix);
    const sharedKey = (suffix: string) => nsFor(owner, suffix);

    const loadJSON = <T,>(key: string, fallback: T): T => {
        try {
            const s = localStorage.getItem(key);
            return s ? (JSON.parse(s) as T) : fallback;
        } catch { return fallback; }
    };

    // --- Deletion log ------------------------------------------------------
    // Cloud sync unions records by id, so without a record of what was deleted
    // "the cloud has an id we don't" always reads as "another device added it".
    // Every deletion this device makes therefore leaves a tombstone, which is
    // what makes a delete stick instead of coming back on the next sync.
    // Tombstones live outside React state: they are never rendered, and reading
    // them straight from storage keeps deletes correct even when several land in
    // the same commit.
    const readTombstones = (m: 'transfem' | 'transmasc'): Tombstones =>
        sanitizeTombstones(loadJSON<unknown>(keyFor(m, 'deletions'), null));

    const writeTombstones = (m: 'transfem' | 'transmasc', next: Tombstones) => {
        localStorage.setItem(keyFor(m, 'deletions'), JSON.stringify(pruneTombstones(next, Date.now())));
    };

    const recordDeletions = (kind: RecordKind, ids: string[], m: 'transfem' | 'transmasc' = mode) => {
        if (!ids.length) return;
        const current = readTombstones(m);
        const at = Date.now();
        for (const id of ids) if (id) current[kind][id] = at;
        writeTombstones(m, current);
    };

    /**
     * Bringing a record back by hand — a file import, an explicit merge from a
     * backup — has to clear its tombstone, or the sync engine would dutifully
     * delete it again as soon as it ran.
     */
    const forgetDeletions = (kind: RecordKind, ids: string[], m: 'transfem' | 'transmasc' = mode) => {
        if (!ids.length) return;
        const current = readTombstones(m);
        let touched = false;
        for (const id of ids) {
            if (current[kind][id] !== undefined) { delete current[kind][id]; touched = true; }
        }
        if (touched) writeTombstones(m, current);
    };

    /**
     * A replace-style import (including "restore this backup") is a statement
     * about the whole set: whatever it leaves out is meant to be gone. Recording
     * those as deletions is what lets a restore survive the next sync instead of
     * being immediately undone by the cloud copy it was restoring from.
     */
    const reconcileReplacement = (
        m: 'transfem' | 'transmasc',
        kind: RecordKind,
        before: { id: string }[],
        after: { id: string }[],
    ) => {
        const keep = new Set(after.map(r => r.id));
        const gone = before.map(r => r.id).filter(id => id && !keep.has(id));
        forgetDeletions(kind, [...keep], m);
        recordDeletions(kind, gone, m);
    };

    // --- State ---
    const [events, setEvents] = useState<DoseEvent[]>(() => loadJSON(keyFor(mode, 'events'), [] as DoseEvent[]));
    const [weight, setWeightState] = useState<number>(() => {
        // Weight is shared across modes (a physical attribute of the person).
        const saved = localStorage.getItem(sharedKey('weight'));
        return saved ? parseFloat(saved) : 70.0;
    });
    // Weight and the PK overrides are single values, not record sets, so sync
    // resolves them last-write-wins — which needs a "when" alongside the "what".
    // Stamped here at the point of an actual user edit; the reload effect and
    // the sync apply path use the raw setters so neither forges a fresh write.
    const setWeight = (w: number) => {
        setWeightState(w);
        localStorage.setItem(sharedKey('weight-at'), String(Date.now()));
    };
    const [labResults, setLabResults] = useState<LabResult[]>(() => loadJSON(keyFor(mode, 'lab-results'), [] as LabResult[]));
    const [calibrationMethod, setCalibrationMethodState] = useState<CalibrationMethod>(() =>
        // Hybrid-MIPD is the default; legacy 'average'/'adaptive' values are migrated.
        normalizeCalibrationMethod(localStorage.getItem(sharedKey('cal-method')))
    );
    const setCalibrationMethod = (m: CalibrationMethod) => {
        setCalibrationMethodState(m);
        localStorage.setItem(sharedKey('cal-method'), m);
        touchAppSettings();
    };
    const [calibrationHistoryMode, setCalibrationHistoryModeState] = useState<CalibrationHistoryMode>(() => {
        const saved = localStorage.getItem(sharedKey('cal-history-mode'));
        return saved === 'forward' ? 'forward' : 'retrospective';
    });
    const setCalibrationHistoryMode = (m: CalibrationHistoryMode) => {
        setCalibrationHistoryModeState(m);
        localStorage.setItem(sharedKey('cal-history-mode'), m);
        touchAppSettings();
    };
    // Which reading the Home card's anti-androgen column shows. Account-scoped and
    // synced exactly like the two calibration settings above: it is a display
    // preference, so it rides the settings bag rather than the records.
    const [aaChartMode, setAaChartModeState] = useState<AntiandrogenChartMode>(() =>
        normalizeAntiandrogenChartMode(localStorage.getItem(sharedKey('aa-chart')))
    );
    const setAaChartMode = (m: AntiandrogenChartMode) => {
        setAaChartModeState(m);
        localStorage.setItem(sharedKey('aa-chart'), m);
        touchAppSettings();
    };
    // The day the user's HRT began, as `YYYY-MM-DD`. A plain string setting like
    // the three above, for the same reason: it is written in the intro, well
    // before there is any record to attach it to, and it has to reach the next
    // device with the account rather than staying in this browser.
    const [hrtStartDate, setHrtStartDateState] = useState<string>(() =>
        normalizeHrtStartDate(localStorage.getItem(sharedKey('hrt-start'))) ?? ''
    );
    const setHrtStartDate = (value: string) => {
        const normalized = normalizeHrtStartDate(value) ?? '';
        setHrtStartDateState(normalized);
        if (normalized) localStorage.setItem(sharedKey('hrt-start'), normalized);
        else localStorage.removeItem(sharedKey('hrt-start'));
        touchAppSettings();
    };
    // The re-check intervals, each individually adjustable in Settings. Stored as
    // JSON under one per-account key and synced as one setting; the reminder logic
    // (`normalizeRecheckIntervals`) fills in the default for anything absent, so a
    // device that has never opened the page keeps the app's defaults.
    const [recheckIntervals, setRecheckIntervalsState] = useState<RecheckIntervals>(() =>
        normalizeRecheckIntervals(loadJSON<unknown>(sharedKey('recheck-intervals'), null))
    );
    const setRecheckIntervals = (next: RecheckIntervals) => {
        const normalized = normalizeRecheckIntervals(next);
        setRecheckIntervalsState(normalized);
        try { localStorage.setItem(sharedKey('recheck-intervals'), JSON.stringify(normalized)); } catch { /* private mode */ }
        touchAppSettings();
    };
    // Which OCR model tier the scan uses. A preference like the intervals, so it
    // rides the settings bag; the models themselves are fetched only when a scan or
    // a retry actually needs them, never at app start.
    const [ocrModelTier, setOcrModelTierState] = useState<OcrModelTier>(() =>
        normalizeOcrModelTier(localStorage.getItem(sharedKey('ocr-model-tier')))
    );
    const setOcrModelTier = (tier: OcrModelTier) => {
        const normalized = normalizeOcrModelTier(tier);
        setOcrModelTierState(normalized);
        try { localStorage.setItem(sharedKey('ocr-model-tier'), normalized); } catch { /* private mode */ }
        touchAppSettings();
    };

    /**
     * Which pharmacokinetic engine computes the curve. A preference like the rest,
     * so it rides the settings bag and follows the account across devices.
     *
     * Two pieces of state, not one: `pkEngine` is the *preference*, `activeEngine` is
     * what is actually loaded. They differ while the Transmtf engine is being fetched,
     * and they differ permanently for a transmasc account, which the Transmtf engine
     * cannot serve at all (no testosterone model) — see `chooseEngine`.
     */
    const [pkEngine, setPkEngineState] = useState<PkEngineId>(() =>
        normalizePkEngine(localStorage.getItem(sharedKey('pk-engine')))
    );
    const setPkEngine = (id: PkEngineId) => {
        const normalized = normalizePkEngine(id);
        setPkEngineState(normalized);
        try { localStorage.setItem(sharedKey('pk-engine'), normalized); } catch { /* private mode */ }
        touchAppSettings();
    };

    // The loaded engine. The built-in one from the first render, so the default path
    // never waits on an import; the vendor engine replaces it only once fetched.
    // `isTransmasc` is a dependency because the choice is overruled by mode, not just
    // by the setting: switching to transfem mode is what makes the vendor engine usable.
    const [activeEngine, setActiveEngine] = useState<PkEngine>(builtinEngine);
    useEffect(() => {
        if (chooseEngine(pkEngine, isTransmasc) === 'builtin') {
            setActiveEngine(builtinEngine);
            return;
        }
        let cancelled = false;
        // Lazy: this is the only path that pulls the vendor chunk in. A failure —
        // offline, a blocked request — falls back to the built-in engine rather than
        // leaving the curve undefined, because an empty curve reads as "no doses".
        void loadVendorEngine()
            .then(engine => { if (!cancelled) setActiveEngine(engine); })
            .catch(() => { if (!cancelled) setActiveEngine(builtinEngine); });
        return () => { cancelled = true; };
    }, [pkEngine, isTransmasc]);
    /**
     * Which due re-check each reminder kind was last closed at, as
     * `<startH>:<intervalMonths>` per kind.
     *
     * A dismissal that only lasted the page view would not be a dismissal — the
     * reminder would be back the moment the Lab page was re-opened. So it is
     * stored, per account, in this device's `hrt-…-recheck-dismissed` key, and
     * deliberately not synced or exported (like `hrt-milestone`): it records
     * what *this* device has already shown, and showing it once more on a second
     * device is a smaller failure than a reminder silently suppressed. The due
     * date in the value is what brings it back — a later interval boundary
     * writes a new one and the reminder returns on schedule.
     */
    const [dismissedRechecks, setDismissedRechecksState] = useState<Record<string, string>>(() =>
        loadJSON(sharedKey('recheck-dismissed'), {} as Record<string, string>)
    );
    const dismissRecheck = (kind: string, due: string) => {
        // Read storage rather than the closed-over state so two dismissals in one
        // commit cannot lose the first.
        const next = { ...loadJSON(sharedKey('recheck-dismissed'), {} as Record<string, string>), [kind]: due };
        setDismissedRechecksState(next);
        try { localStorage.setItem(sharedKey('recheck-dismissed'), JSON.stringify(next)); } catch { /* private mode */ }
    };
    /**
     * A milestone the account page should celebrate this visit, as
     * `<days>:<cake|confetti>`, or '' for an ordinary day.
     *
     * ── Where "already shown" is stored, and the multi-device answer ─────────
     *
     * In this device's `hrt-…-hrt-milestone` key, as `YYYY-MM-DD:key` — the
     * *day the celebration was seen*, plus which one, so a milestone the user
     * skipped (never opened the page that day) is still owed on the next visit
     * rather than missed forever.
     *
     * It is deliberately **not** in `AppSettings`, and so does not ride the
     * Core sync. The bag is resolved whole and newest-wins, so a device writing
     * "I showed 365" would push its own stamp over a newer one and, worse, a
     * device that merely *read* the account would carry another device's
     * "shown" back with it. Celebrating twice — once here, once on the phone —
     * is a smaller failure than a celebration silently suppressed because some
     * other device claimed it. So: **per device.** Login on a second device and
     * you get the burst there too, once.
     *
     * The key is stamped the moment the milestone is armed, not when the
     * celebration ends: a reload mid-animation must not replay it, which is the
     * requirement, and the cost of the other ordering is exactly that replay.
     *
     * Because it is stamped rather than held, this value is only correct on the
     * mount that *did* the stamping — see `armMilestone` in
     * src/utils/hrtMilestone.ts for the half that keeps it alive across the
     * remount `CoreSessionProvider` performs while the session restores.
     */
    const [pendingMilestone] = useState<string>(() => {
        if (!hrtStartDate) return '';
        const days = hrtDaysSince(hrtStartDate);
        const milestone = milestoneFor(days);
        if (milestone === null || days === null) return '';
        const today = toDayKey(new Date());
        const key = sharedKey('hrt-milestone');
        // Unreadable storage is treated as "not shown yet": the alternative is
        // swallowing a celebration because a write once threw.
        try { if (localStorage.getItem(key) === `${today}:${milestone}`) return ''; } catch { /* see above */ }
        try { localStorage.setItem(key, `${today}:${milestone}`); } catch { /* see above */ }
        return `${days}:${milestone}`;
    });

    /**
     * The one-off third-day note, shown at most once on this device, ever.
     *
     * ── Why this reacts to `events` rather than being read once at mount ────────
     *
     * The note is earned by *adding a record on the third consecutive day*, so it
     * has to be able to appear the moment that record lands. Reading it in a
     * `useState` initialiser — the way `pendingMilestone` beside it is read —
     * would answer only for the records that existed at mount, and the ordinary
     * case is someone mid-session: they log Monday, Tuesday, then Wednesday's
     * dose while the app is open. So it watches `events` and fires when they say
     * today is the third day.
     *
     * ── One trigger for every way a record arrives ──────────────────────────────
     *
     * Because it watches the day keys of `events`, it does not care *how* today's
     * record appeared: the dose form, the home quick-add, or an MCP write that
     * arrived as a sync and was applied to `events`. The user asked for all three,
     * and one rule over the resulting records is what covers them without a
     * trigger planted in each writer.
     *
     * ── Once, per device, and never again ───────────────────────────────────────
     *
     * The shown-flag lives in this device's `hrt-…-streak3` key, like the
     * milestone's, and for the same reason: it records what *this* device has
     * already told the user, and showing it once more on a second device is a
     * smaller failure than silently suppressing it. The ref is a second guard for
     * the same session — the effect reruns on every `events` change, and without
     * it the note would re-arm at the next add even though the flag is written.
     */
    const [showStreakNotice, setShowStreakNotice] = useState(false);
    const streakArmedRef = useRef(false);
    useEffect(() => {
        if (streakArmedRef.current) return;
        const today = toDayKey(new Date());
        const days = new Set(events.map(e => toDayKey(new Date(e.timeH * 3600000))));
        if (!isThirdDayStreak(days, today)) return;
        // Claim it in storage before showing: a reload mid-notice must not replay it.
        const key = sharedKey('streak3');
        try { if (localStorage.getItem(key) === 'shown') { streakArmedRef.current = true; return; } } catch { /* private mode */ }
        try { localStorage.setItem(key, 'shown'); } catch { /* private mode */ }
        streakArmedRef.current = true;
        setShowStreakNotice(true);
    }, [events]);
    const dismissStreakNotice = () => setShowStreakNotice(false);
    const [doseTemplates, setDoseTemplates] = useState<DoseTemplate[]>(() => loadJSON(keyFor(mode, 'dose-templates'), [] as DoseTemplate[]));
    const [quickDoses, setQuickDoses] = useState<QuickDose[]>(() => loadJSON(keyFor(mode, 'quick-doses'), [] as QuickDose[]));
    // The private body-and-mood log. Unlike the monitoring bloods and quick
    // doses above, this one *is* a record: it is exported and synced, so it has
    // tombstones and a real merge path (see "journal" in syncMerge.ts).
    const [journal, setJournal] = useState<JournalEntry[]>(() => loadJSON(keyFor(mode, 'journal'), [] as JournalEntry[]));
    const [pkParams, setPkParamsState] = useState<PKCustomParams | null>(() => {
        const saved = localStorage.getItem(sharedKey('pk-params'));
        if (!saved) return null;
        try {
            const parsed = sanitizePKParams(JSON.parse(saved));
            applyPKOverrides(parsed); // Apply immediately so first simulation uses custom params
            return parsed;
        } catch { return null; }
    });

    const [simulation, setSimulation] = useState<SimulationResult | null>(null);
    const [currentTime, setCurrentTime] = useState(new Date());

    // --- Effects ---
    // Tracks the (account, mode) scope whose data is currently held in state.
    // Persist effects must wait until the reload effect has swapped state to the
    // new scope's data, otherwise stale state would overwrite the newly-selected
    // scope's localStorage entries — writing the previous mode's doses into this
    // mode, or worse, the previous account's into this one.
    //
    // IMPORTANT: setState calls inside the reload effect do NOT apply to the
    // current commit — they schedule a re-render. Any persist effect that also
    // runs in the *same* commit (because `scope` is in its dep array) would
    // therefore observe stale state. We mark the ref as `null` during reload so
    // persist effects skip, and re-establish it only after the new data has
    // actually flushed into state (detected in a follow-up effect that also
    // watches the data itself).
    const loadedScopeRef = useRef<string | null>(scope);

    // Reload every piece of scoped state whenever the HRT mode OR the signed-in
    // account changes. Signing out drops `owner` back to the signed-out
    // namespace, which is empty once the account adopted it — that is what stops
    // the next person on a shared device from seeing the last one's records.
    //
    // Declared before the persist effects on purpose: on mount it runs first, so
    // adoption happens before any persist effect can write an empty array into
    // the account's namespace and make adoption think it was already used.
    useEffect(() => {
        adoptSignedOutData(owner);
        loadedScopeRef.current = null;
        setEvents(loadJSON(keyFor(mode, 'events'), [] as DoseEvent[]));
        setLabResults(loadJSON(keyFor(mode, 'lab-results'), [] as LabResult[]));
        setDoseTemplates(loadJSON(keyFor(mode, 'dose-templates'), [] as DoseTemplate[]));
        setQuickDoses(loadJSON(keyFor(mode, 'quick-doses'), [] as QuickDose[]));
        setJournal(loadJSON(keyFor(mode, 'journal'), [] as JournalEntry[]));
        // Mode-independent, but still per-account, so they reload on the same beat.
        const savedWeight = localStorage.getItem(sharedKey('weight'));
        setWeightState(savedWeight ? parseFloat(savedWeight) : 70.0);
        setCalibrationMethodState(normalizeCalibrationMethod(localStorage.getItem(sharedKey('cal-method'))));
        setCalibrationHistoryModeState(localStorage.getItem(sharedKey('cal-history-mode')) === 'forward' ? 'forward' : 'retrospective');
        setAaChartModeState(normalizeAntiandrogenChartMode(localStorage.getItem(sharedKey('aa-chart'))));
        setHrtStartDateState(normalizeHrtStartDate(localStorage.getItem(sharedKey('hrt-start'))) ?? '');
        setRecheckIntervalsState(normalizeRecheckIntervals(loadJSON<unknown>(sharedKey('recheck-intervals'), null)));
        setOcrModelTierState(normalizeOcrModelTier(localStorage.getItem(sharedKey('ocr-model-tier'))));
        setPkEngineState(normalizePkEngine(localStorage.getItem(sharedKey('pk-engine'))));
        setDismissedRechecksState(loadJSON(sharedKey('recheck-dismissed'), {} as Record<string, string>));
        setPkParamsState(sanitizePKParams(loadJSON<unknown>(sharedKey('pk-params'), null)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope]);

    // Mark the ref as "loaded for this mode" only after state updates have
    // flushed. Runs on every data mutation for the current mode, which is
    // harmless (idempotent assignment).
    //
    // `mode` is intentionally NOT in the dep array: including it would cause
    // this effect to fire in the same commit as the reload effect (which also
    // depends on `mode`), re-setting the ref to the new mode *before* the
    // reload's setState calls have flushed. The persist effects — which also
    // depend on `mode` and run in that same commit — would then observe
    // ref === mode and overwrite the new mode's localStorage with stale
    // previous-mode state. Watching only the data ensures we re-arm the ref
    // exactly when the reload's setState calls have actually committed
    // (because loadJSON always returns fresh array references).
    //
    // `readyScope` mirrors the ref into render output for the same reason, but
    // for consumers outside this hook: cloud sync must not read (let alone
    // upload) a payload assembled mid-switch, when in-memory state still belongs
    // to the previous account while the storage keys already point at the new
    // one. It waits for readyScope === scope.
    const [readyScope, setReadyScope] = useState<string>(scope);
    useEffect(() => {
        loadedScopeRef.current = scope;
        setReadyScope(prev => (prev === scope ? prev : scope));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [events, labResults, doseTemplates, quickDoses, journal]);


    useEffect(() => {
        if (loadedScopeRef.current !== scope) return;
        localStorage.setItem(keyFor(mode, 'events'), JSON.stringify(events));
    }, [events, scope]);
    useEffect(() => {
        if (loadedScopeRef.current !== scope) return;
        localStorage.setItem(sharedKey('weight'), weight.toString());
    }, [weight, scope]);
    useEffect(() => {
        // The override is applied unconditionally — the simulation must track
        // whatever is in state right now. Only the *write* waits for the scope
        // handshake, so a mid-switch commit can't persist the previous account's
        // parameters into this one's namespace.
        applyPKOverrides(pkParams);
        if (loadedScopeRef.current !== scope) return;
        if (pkParams) {
            localStorage.setItem(sharedKey('pk-params'), JSON.stringify(pkParams));
        } else {
            localStorage.removeItem(sharedKey('pk-params'));
        }
    }, [pkParams, scope]);
    useEffect(() => {
        if (loadedScopeRef.current !== scope) return;
        localStorage.setItem(keyFor(mode, 'lab-results'), JSON.stringify(labResults));
    }, [labResults, scope]);
    useEffect(() => {
        if (loadedScopeRef.current !== scope) return;
        localStorage.setItem(keyFor(mode, 'dose-templates'), JSON.stringify(doseTemplates));
    }, [doseTemplates, scope]);
    useEffect(() => {
        if (loadedScopeRef.current !== scope) return;
        localStorage.setItem(keyFor(mode, 'quick-doses'), JSON.stringify(quickDoses));
    }, [quickDoses, scope]);
    useEffect(() => {
        if (loadedScopeRef.current !== scope) return;
        localStorage.setItem(keyFor(mode, 'journal'), JSON.stringify(journal));
    }, [journal, scope]);

    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (events.length > 0) {
            // Through the registry, so the selected engine computes the curve. The
            // built-in engine is what `activeEngine` holds until the Transmtf engine
            // is asked for and fetched, so this line is unchanged for anyone who
            // never switches.
            setSimulation(activeEngine.runSimulation(events, weight));
        } else {
            setSimulation(null);
        }
    }, [events, weight, activeEngine]);

    // --- Derived State ---
    // Self-learning calibration: fits a personal amplitude (+ clearance, for the
    // EKF/MIPD models) to the user's labs via the selected estimator and history
    // mode. Returns the scale function plus the learned parameters and per-lab
    // comparison used by the Lab page UI.
    const calibration = useMemo(() => {
        return activeEngine.computeCalibration(simulation, events, weight, labResults, calibrationMethod, calibrationHistoryMode);
    }, [simulation, events, weight, labResults, calibrationMethod, calibrationHistoryMode, activeEngine]);
    const calibrationFn = calibration.factorFn;

    const currentLevel = useMemo(() => {
        if (!simulation) return 0;
        const h = currentTime.getTime() / 3600000;
        const baseE2 = activeEngine.interpolateConcentration_E2(simulation, h) || 0;
        return baseE2 * calibrationFn(h);
    }, [simulation, currentTime, calibrationFn, activeEngine]);

    // Total testosterone (ng/dL) at the current time — only meaningful in transmasc mode.
    const currentT = useMemo(() => {
        if (!simulation) return 0;
        const h = currentTime.getTime() / 3600000;
        return activeEngine.interpolateConcentration_T(simulation, h) || 0;
    }, [simulation, currentTime, activeEngine]);

    // One section per local calendar day, newest first.
    //
    // #69: this used to accumulate into an object keyed by the day's *display*
    // label, which carries no year, so a dose on 2025-08-27 and one on 2026-08-27
    // hashed to the same bucket and rendered under a single "8月27日" heading.
    // Key and heading are two separate values now.
    //
    // An array rather than a Record, because `sorted` is already newest-first and
    // run-length grouping keeps that order structurally. Object key enumeration
    // would not: it quietly re-sorts any key that looks like an array index, so a
    // key such as "20260827" would have come back oldest-first.
    const groupedEvents = useMemo<DoseDayGroup[]>(() => {
        const formatLabel = createDayLabelFormatter(lang);
        const sorted = [...events].sort((a, b) => b.timeH - a.timeH);
        const groups: DoseDayGroup[] = [];
        for (const e of sorted) {
            const at = new Date(e.timeH * 3600000);
            const key = toDayKey(at);
            const last = groups[groups.length - 1];
            if (last && last.key === key) last.events.push(e);
            else groups.push({ key, label: formatLabel(at), events: [e] });
        }
        return groups;
    }, [events, lang]);

    const currentStatus = useMemo(() => {
        if (isTransmasc) {
            // Transmasc: total T status bands (ng/dL). Reference: male range 300–1000 ng/dL.
            if (currentT > 0) {
                const c = currentT;
                if (c > 1000) return { label: 'status.level.t_high',    color: 'text-cos-warning', bg: 'bg-cos-warning-container',  border: 'border-cos-warning' };
                if (c >= 600) return { label: 'status.level.t_upper',   color: 'text-cos-success', bg: 'bg-cos-success-container', border: 'border-cos-success' };
                if (c >= 300) return { label: 'status.level.t_male',    color: 'text-cos-success', bg: 'bg-cos-success-container', border: 'border-cos-success' };
                if (c >= 100) return { label: 'status.level.t_subtarget', color: 'text-cos-accent', bg: 'bg-indigo-50', border: 'border-indigo-200' };
                return { label: 'status.level.t_low', color: 'text-cos-on-surface-variant', bg: 'bg-cos-surface-container', border: 'border-cos-outline' };
            }
            return null;
        }
        if (currentLevel > 0) {
            const conc = currentLevel;
            if (conc > 300) return { label: 'status.level.high', color: 'text-cos-warning', bg: 'bg-cos-warning-container', border: 'border-cos-warning' };
            if (conc >= 100 && conc <= 200) return { label: 'status.level.mtf', color: 'text-cos-success', bg: 'bg-cos-success-container', border: 'border-cos-success' };
            if (conc >= 70 && conc <= 300) return { label: 'status.level.luteal', color: 'text-cos-accent', bg: 'bg-blue-50', border: 'border-blue-200' };
            if (conc >= 30 && conc < 70) return { label: 'status.level.follicular', color: 'text-cos-accent', bg: 'bg-indigo-50', border: 'border-indigo-200' };
            if (conc >= 8 && conc < 30) return { label: 'status.level.male', color: 'text-cos-on-surface-variant', bg: 'bg-cos-surface-container', border: 'border-cos-outline' };
            return { label: 'status.level.low', color: 'text-cos-warning', bg: 'bg-cos-warning-container', border: 'border-cos-warning' };
        }
        return null;
    }, [currentLevel, currentT, isTransmasc]);


    // --- Actions ---
    // Every write goes through here, which makes this the one place that has to
    // stamp `updatedAt`. Sync uses the stamp to tell an edit from its older
    // twin; an unstamped record silently loses that argument.
    const stamp = <T extends object>(record: T): T & { updatedAt: number } =>
        ({ ...record, updatedAt: Date.now() });

    const addEvent = (e: DoseEvent) => {
        forgetDeletions('events', [e.id]);
        setEvents(prev => [...prev, stamp(e)]);
    };
    const addEvents = (list: DoseEvent[]) => {
        if (!list.length) return;
        forgetDeletions('events', list.map(e => e.id));
        setEvents(prev => [...prev, ...list.map(stamp)]);
    };
    const updateEvent = (e: DoseEvent) => {
        const next = stamp(e);
        setEvents(prev => prev.map(p => p.id === e.id ? next : p));
    };
    const deleteEvent = (id: string) => {
        recordDeletions('events', [id]);
        setEvents(prev => prev.filter(e => e.id !== id));
    };
    const deleteEvents = (ids: string[]) => {
        if (!ids.length) return;
        recordDeletions('events', ids);
        const idSet = new Set(ids);
        setEvents(prev => prev.filter(e => !idSet.has(e.id)));
    };
    const clearAllEvents = () => {
        if (!events.length) return;
        showDialog('confirm', t('drawer.clear_confirm'), () => {
            recordDeletions('events', events.map(e => e.id));
            setEvents([]);
        });
    }

    const addLabResult = (res: LabResult) => {
        forgetDeletions('labResults', [res.id]);
        setLabResults(prev => [...prev, stamp(res)]);
    };
    const updateLabResult = (res: LabResult) => {
        const next = stamp(res);
        setLabResults(prev => prev.map(r => r.id === res.id ? next : r));
    };
    const deleteLabResult = (id: string) => {
        recordDeletions('labResults', [id]);
        setLabResults(prev => prev.filter(r => r.id !== id));
    };
    const clearLabResults = () => {
        if (!labResults.length) return;
        showDialog('confirm', t('lab.clear_confirm'), () => {
            recordDeletions('labResults', labResults.map(r => r.id));
            setLabResults([]);
        });
    }

    // A check-in is added, edited, or deleted like a dose: the tombstone is what
    // stops another device pulling a deleted entry back out of the cloud.
    const addJournalEntry = (entry: JournalEntry) => {
        forgetDeletions('journal', [entry.id]);
        setJournal(prev => [...prev, stamp(entry)]);
    };
    const updateJournalEntry = (entry: JournalEntry) => {
        forgetDeletions('journal', [entry.id]);
        const next = stamp(entry);
        setJournal(prev => prev.map(p => p.id === entry.id ? next : p));
    };
    const deleteJournalEntry = (id: string) => {
        recordDeletions('journal', [id]);
        setJournal(prev => prev.filter(e => e.id !== id));
    };

    const addTemplate = (template: DoseTemplate) => {
        forgetDeletions('doseTemplates', [template.id]);
        setDoseTemplates(prev => [...prev, stamp(template)]);
    };
    const deleteTemplate = (id: string) => {
        recordDeletions('doseTemplates', [id]);
        setDoseTemplates(prev => prev.filter(t => t.id !== id));
    };

    // Quick doses are a per-device shortcut list, not part of the record — they
    // are neither exported nor synced, so no tombstone is needed.
    const addQuickDose = (dose: QuickDose) => setQuickDoses(prev => [...prev, dose]);
    const deleteQuickDose = (id: string) => setQuickDoses(prev => prev.filter(d => d.id !== id));

    const touchPkParams = () => localStorage.setItem(sharedKey('pk-params-at'), String(Date.now()));
    const setPkParams = (params: PKCustomParams) => { touchPkParams(); setPkParamsState(params); };
    const clearPkParams = () => { touchPkParams(); setPkParamsState(null); };
    const resetPkParams = () => {
        showDialog('confirm', t('pk.reset_confirm'), () => {
            clearPkParams();
        });
    };

    // A backup with hundreds of thousands of same-day events makes the
    // simulation's peri-event sampling explode into a synchronous loop that
    // never finishes — and because state is persisted before the simulation
    // runs, the wedged data is reloaded on every subsequent open. Reject the
    // file outright so nothing is written.
    const MAX_IMPORT_ENTRIES = 20000;

    /** Carry a record's edit stamp through sanitising; absent or junk becomes undefined. */
    const keepStamp = (raw: any): number | undefined => {
        const n = Number(raw?.updatedAt);
        return Number.isFinite(n) && n > 0 ? n : undefined;
    };

    const sanitizeImportedEvents = (raw: any): DoseEvent[] => {
        if (!Array.isArray(raw)) throw new Error('Invalid format');
        if (raw.length > MAX_IMPORT_ENTRIES) throw new Error('Too many entries');
        return raw.map((item: any) => {
            if (!item || typeof item !== 'object') return null;
            const { route, timeH, doseMG, ester, extras } = item;
            if (!Object.values(Route).includes(route)) return null;
            const timeNum = Number(timeH);
            // Out-of-range timestamps are dropped rather than clamped: moving a
            // record to a date the user never chose is worse than losing it, and
            // a stray one stretches the simulation grid over the whole span.
            if (!Number.isFinite(timeNum) || timeNum < EVENT_TIME_H_MIN || timeNum > EVENT_TIME_H_MAX) return null;
            const doseNum = Number(doseMG);
            const validEster = Object.values(Ester).includes(ester) ? ester : Ester.E2;
            const sanitizedExtras = (extras && typeof extras === 'object') ? extras : {};
            return {
                id: typeof item.id === 'string' ? item.id : uuidv4(),
                route,
                timeH: timeNum,
                // The ceiling is per compound: `DOSE_MG_MAX` is estradiol's, and an
                // anti-androgen is dosed in the hundreds of mg, so importing a 200 mg
                // spironolactone record must not clip it to 10 g… it would not, but a
                // future edit lowering DOSE_MG_MAX to an estradiol-sized bound would.
                doseMG: Number.isFinite(doseNum)
                    ? Math.min(validEster === Ester.SPIRO ? SPIRO_MG_MAX_PER_DAY : DOSE_MG_MAX, Math.max(0, doseNum))
                    : 0,
                ester: validEster,
                extras: sanitizedExtras,
                updatedAt: keepStamp(item)
            } as DoseEvent;
        }).filter((item): item is DoseEvent => item !== null);
    };

    const sanitizeImportedLabResults = (raw: any): LabResult[] => {
        if (!Array.isArray(raw)) return [];
        if (raw.length > MAX_IMPORT_ENTRIES) throw new Error('Too many entries');
        // A record may carry an estradiol/testosterone reading, monitoring bloods,
        // or both. The old parallel `monitoring-labs` store is gone, so any payload
        // still carrying those fields is read here.
        const num = (v: unknown): number | undefined => {
            if (v === null || v === undefined || v === '') return undefined;
            const n = Number(v);
            return Number.isFinite(n) && n >= 0 ? n : undefined;
        };
        return raw.map((item: any) => {
            if (!item || typeof item !== 'object') return null;
            const timeNum = Number(item.timeH);
            if (!Number.isFinite(timeNum)) return null;
            const valNum = num(item.concValue);
            const prolactin = num(item.prolactin);
            const alt = num(item.alt);
            const ast = num(item.ast);
            const potassium = num(item.potassium);
            const hasMonitoring = prolactin !== undefined || alt !== undefined || ast !== undefined || potassium !== undefined;
            // Neither a hormone nor a monitoring reading: nothing to store.
            if (valNum === undefined && !hasMonitoring) return null;
            // Explicit flag wins; otherwise a record with no hormone value is
            // monitoring-only by construction.
            const monitoringOnly = item.monitoringOnly === true || valNum === undefined;
            const unitVal = (item.unit === 'pg/ml' || item.unit === 'pmol/l' || item.unit === 'ng/dl' || item.unit === 'nmol/l') ? item.unit : 'pmol/l';
            const prolactinUln = num(item.prolactinUln);
            const altUln = num(item.altUln);
            return {
                id: typeof item.id === 'string' ? item.id : uuidv4(),
                timeH: timeNum,
                // A monitoring-only record keeps the neutral placeholder the type
                // requires; `monitoringOnly` is what tells readers to ignore it.
                concValue: valNum ?? 0,
                unit: unitVal,
                ...(prolactin !== undefined ? { prolactin } : {}),
                ...(prolactin !== undefined && prolactinUln !== undefined ? { prolactinUln } : {}),
                ...(alt !== undefined ? { alt } : {}),
                ...(alt !== undefined && altUln !== undefined ? { altUln } : {}),
                ...(ast !== undefined ? { ast } : {}),
                ...(potassium !== undefined ? { potassium } : {}),
                ...(monitoringOnly ? { monitoringOnly: true } : {}),
                updatedAt: keepStamp(item)
            } as LabResult;
        }).filter((item): item is LabResult => item !== null);
    };

    const sanitizeImportedTemplates = (raw: any): DoseTemplate[] => {
        if (!Array.isArray(raw)) return [];
        if (raw.length > MAX_IMPORT_ENTRIES) throw new Error('Too many entries');
        return raw.map((item: any) => {
            if (!item || typeof item !== 'object') return null;
            const { name, route, ester, doseMG, extras, createdAt } = item;
            if (!Object.values(Route).includes(route)) return null;
            if (!Object.values(Ester).includes(ester)) return null;
            const doseNum = Number(doseMG);
            if (!Number.isFinite(doseNum) || doseNum < 0) return null;
            return {
                id: typeof item.id === 'string' ? item.id : uuidv4(),
                name: typeof name === 'string' ? name : 'Template',
                route,
                ester,
                doseMG: doseNum,
                extras: (extras && typeof extras === 'object') ? extras : {},
                createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
                updatedAt: keepStamp(item)
            } as DoseTemplate;
        }).filter((item): item is DoseTemplate => item !== null);
    };

    const processImportedData = (parsed: any): boolean => {
        try {
            let newEvents: DoseEvent[] = [];
            let newWeight: number | undefined = undefined;
            let newLabs: LabResult[] = [];
            let newTemplates: DoseTemplate[] = [];
            let newPkParams: PKCustomParams | undefined = undefined;
            let importedOtherMode = false;
            // Which kinds the payload actually *speaks about*, tracked one by
            // one. A single "it had something for this mode" flag replaced all
            // three lists, so a file carrying only `events` — the shape a v1
            // export or a hand-written file often has — cleared the user's lab
            // results and templates as a side effect of importing doses.
            //
            // A present-but-empty array still means "none", so restoring a
            // backup with no labs still clears them. Only an absent key is
            // silence. The distinction matters more now that a replace-import
            // records what it drops as deletions: silence used to cost a wipe
            // this device might get back from another one, and would now cost
            // the same wipe on every device.
            const replaced = { events: false, labResults: false, doseTemplates: false, journal: false };
            let newJournal: JournalEntry[] = [];

            // New multi-mode payload: { modes: { transfem: {...}, transmasc: {...} } }
            if (parsed && typeof parsed === 'object' && parsed.modes && typeof parsed.modes === 'object') {
                const modesBlock = parsed.modes as Record<string, any>;
                for (const m of ['transfem', 'transmasc'] as const) {
                    const block = modesBlock[m];
                    if (!block || typeof block !== 'object') continue;
                    const evs = Array.isArray(block.events) ? sanitizeImportedEvents(block.events) : [];
                    const ls = Array.isArray(block.labResults) ? sanitizeImportedLabResults(block.labResults) : [];
                    const tmps = Array.isArray(block.doseTemplates) ? sanitizeImportedTemplates(block.doseTemplates) : [];
                    if (m === mode) {
                        if (Array.isArray(block.events)) { newEvents = evs; replaced.events = true; }
                        if (Array.isArray(block.labResults)) { newLabs = ls; replaced.labResults = true; }
                        if (Array.isArray(block.doseTemplates)) { newTemplates = tmps; replaced.doseTemplates = true; }
                        if (Array.isArray(block.journal)) { newJournal = sanitizeJournalEntries(block.journal); replaced.journal = true; }
                    } else {
                        // Write other mode's data straight to localStorage.
                        if (Array.isArray(block.events)) {
                            reconcileReplacement(m, 'events', loadJSON<DoseEvent[]>(keyFor(m, 'events'), []), evs);
                            localStorage.setItem(keyFor(m, 'events'), JSON.stringify(evs));
                            importedOtherMode = true;
                        }
                        if (Array.isArray(block.labResults)) {
                            reconcileReplacement(m, 'labResults', loadJSON<LabResult[]>(keyFor(m, 'lab-results'), []), ls);
                            localStorage.setItem(keyFor(m, 'lab-results'), JSON.stringify(ls));
                            importedOtherMode = true;
                        }
                        if (Array.isArray(block.doseTemplates)) {
                            reconcileReplacement(m, 'doseTemplates', loadJSON<DoseTemplate[]>(keyFor(m, 'dose-templates'), []), tmps);
                            localStorage.setItem(keyFor(m, 'dose-templates'), JSON.stringify(tmps));
                            importedOtherMode = true;
                        }
                        if (Array.isArray(block.journal)) {
                            const jour = sanitizeJournalEntries(block.journal);
                            reconcileReplacement(m, 'journal', loadJSON<JournalEntry[]>(keyFor(m, 'journal'), []), jour);
                            localStorage.setItem(keyFor(m, 'journal'), JSON.stringify(jour));
                            importedOtherMode = true;
                        }
                    }
                }
                if (typeof parsed.weight === 'number' && Number.isFinite(parsed.weight) && parsed.weight > 0) {
                    newWeight = Math.min(BODY_WEIGHT_KG_MAX, Math.max(BODY_WEIGHT_KG_MIN, parsed.weight));
                }
                if (parsed.pkParams && typeof parsed.pkParams === 'object') {
                    newPkParams = sanitizePKParams(parsed.pkParams) ?? undefined;
                }
            } else if (Array.isArray(parsed)) {
                newEvents = sanitizeImportedEvents(parsed);
                replaced.events = true;
            } else if (typeof parsed === 'object' && parsed !== null) {
                if (Array.isArray(parsed.events)) {
                    newEvents = sanitizeImportedEvents(parsed.events);
                    replaced.events = true;
                }
                if (typeof parsed.weight === 'number' && Number.isFinite(parsed.weight) && parsed.weight > 0) {
                    newWeight = Math.min(BODY_WEIGHT_KG_MAX, Math.max(BODY_WEIGHT_KG_MIN, parsed.weight));
                }
                if (Array.isArray(parsed.labResults)) {
                    newLabs = sanitizeImportedLabResults(parsed.labResults);
                    replaced.labResults = true;
                }
                if (Array.isArray(parsed.doseTemplates)) {
                    newTemplates = sanitizeImportedTemplates(parsed.doseTemplates);
                    replaced.doseTemplates = true;
                }
                if (Array.isArray(parsed.journal)) {
                    newJournal = sanitizeJournalEntries(parsed.journal);
                    replaced.journal = true;
                }
                if (parsed.pkParams && typeof parsed.pkParams === 'object') {
                    newPkParams = sanitizePKParams(parsed.pkParams) ?? undefined;
                }
            }

            // v1 flat-format safety: if the payload contains items that belong to
            // the *other* HRT mode (T esters / T-unit labs), siphon them into that
            // mode's storage so they don't silently corrupt the active record.
            if (!('modes' in (parsed || {}))) {
                const otherMode: 'transfem' | 'transmasc' = mode === 'transmasc' ? 'transfem' : 'transmasc';
                const eventBelongs = (e: DoseEvent) =>
                    // Only a testosterone ester belongs to transmasc. Spironolactone
                    // is an anti-androgen and sits in a transfem regimen, so it must not
                    // be mistakable for a T record — which the bare `!isTestosteroneEster`
                    // test this replaces would have done if it had been written the other
                    // way round.
                    mode === 'transmasc' ? isTestosteroneEster(e.ester) : !isTestosteroneEster(e.ester);
                const keepEvs: DoseEvent[] = [];
                const otherEvs: DoseEvent[] = [];
                for (const e of newEvents) (eventBelongs(e) ? keepEvs : otherEvs).push(e);
                if (otherEvs.length) {
                    const existing = loadJSON<DoseEvent[]>(keyFor(otherMode, 'events'), []);
                    const existingIds = new Set(existing.map(x => x.id));
                    forgetDeletions('events', otherEvs.map(e => e.id), otherMode);
                    localStorage.setItem(
                        keyFor(otherMode, 'events'),
                        JSON.stringify([...existing, ...otherEvs.filter(e => !existingIds.has(e.id))])
                    );
                    importedOtherMode = true;
                    newEvents = keepEvs;
                }
                const labBelongs = (l: LabResult) =>
                    mode === 'transmasc' ? isT_LabUnit(l.unit) : !isT_LabUnit(l.unit);
                const keepLs: LabResult[] = [];
                const otherLs: LabResult[] = [];
                for (const l of newLabs) (labBelongs(l) ? keepLs : otherLs).push(l);
                if (otherLs.length) {
                    const existing = loadJSON<LabResult[]>(keyFor(otherMode, 'lab-results'), []);
                    const existingIds = new Set(existing.map(x => x.id));
                    forgetDeletions('labResults', otherLs.map(l => l.id), otherMode);
                    localStorage.setItem(
                        keyFor(otherMode, 'lab-results'),
                        JSON.stringify([...existing, ...otherLs.filter(l => !existingIds.has(l.id))])
                    );
                    importedOtherMode = true;
                    newLabs = keepLs;
                }
            }

            if (!importedOtherMode && !newEvents.length && !newWeight && !newLabs.length && !newTemplates.length && !newJournal.length && !newPkParams) throw new Error('No valid entries');

            // A replace-import states the whole set for each kind it mentions,
            // so anything it drops from one is a deletion. Recording it is what
            // stops the next sync from pulling the dropped records straight back
            // out of the cloud — which would make "restore this backup" a no-op.
            if (replaced.events) {
                reconcileReplacement(mode, 'events', events, newEvents);
                setEvents(newEvents);
            }
            if (replaced.labResults) {
                reconcileReplacement(mode, 'labResults', labResults, newLabs);
                setLabResults(newLabs);
            }
            if (replaced.doseTemplates) {
                reconcileReplacement(mode, 'doseTemplates', doseTemplates, newTemplates);
                setDoseTemplates(newTemplates);
            }
            if (replaced.journal) {
                reconcileReplacement(mode, 'journal', journal, newJournal);
                setJournal(newJournal);
            }
            if (newWeight !== undefined) setWeight(newWeight);
            if (newPkParams !== undefined) setPkParams(newPkParams);

            showDialog('alert', t('drawer.import_success'));
            return true;
        } catch (err) {
            console.error(err);
            showDialog('alert', t('drawer.import_error'));
            return false;
        }
    };

    const mergeImportedData = (parsed: any): boolean => {
        try {
            let incomingEvents: DoseEvent[] = [];
            let incomingWeight: number | undefined = undefined;
            let incomingLabs: LabResult[] = [];
            let incomingTemplates: DoseTemplate[] = [];
            let incomingJournal: JournalEntry[] = [];
            let mergedOther = 0;

            if (parsed && typeof parsed === 'object' && parsed.modes && typeof parsed.modes === 'object') {
                const modesBlock = parsed.modes as Record<string, any>;
                for (const m of ['transfem', 'transmasc'] as const) {
                    const block = modesBlock[m];
                    if (!block || typeof block !== 'object') continue;
                    const evs = Array.isArray(block.events) ? sanitizeImportedEvents(block.events) : [];
                    const ls = Array.isArray(block.labResults) ? sanitizeImportedLabResults(block.labResults) : [];
                    const tmps = Array.isArray(block.doseTemplates) ? sanitizeImportedTemplates(block.doseTemplates) : [];
                    if (m === mode) {
                        incomingEvents = evs;
                        incomingLabs = ls;
                        incomingTemplates = tmps;
                        if (Array.isArray(block.journal)) incomingJournal = sanitizeJournalEntries(block.journal);
                    } else {
                        // Merge into the other mode's localStorage directly.
                        const existingEvs = loadJSON<DoseEvent[]>(keyFor(m, 'events'), []);
                        const existingLs = loadJSON<LabResult[]>(keyFor(m, 'lab-results'), []);
                        const existingTmps = loadJSON<DoseTemplate[]>(keyFor(m, 'dose-templates'), []);
                        const existingJour = loadJSON<JournalEntry[]>(keyFor(m, 'journal'), []);
                        const evIds = new Set(existingEvs.map(e => e.id));
                        const lsIds = new Set(existingLs.map(l => l.id));
                        const tmpIds = new Set(existingTmps.map(tm => tm.id));
                        const jourIds = new Set(existingJour.map(j => j.id));
                        const newEvs = evs.filter(e => !evIds.has(e.id));
                        const newLs = ls.filter(l => !lsIds.has(l.id));
                        const newTmps = tmps.filter(tm => !tmpIds.has(tm.id));
                        const jour = Array.isArray(block.journal) ? sanitizeJournalEntries(block.journal) : [];
                        const newJour = jour.filter(j => !jourIds.has(j.id));
                        // An explicit merge is the user asking for these records
                        // back, so any tombstone standing in the way goes.
                        forgetDeletions('events', evs.map(e => e.id), m);
                        forgetDeletions('labResults', ls.map(l => l.id), m);
                        forgetDeletions('doseTemplates', tmps.map(tm => tm.id), m);
                        forgetDeletions('journal', jour.map(j => j.id), m);
                        if (newEvs.length) localStorage.setItem(keyFor(m, 'events'), JSON.stringify([...existingEvs, ...newEvs]));
                        if (newLs.length) localStorage.setItem(keyFor(m, 'lab-results'), JSON.stringify([...existingLs, ...newLs]));
                        if (newTmps.length) localStorage.setItem(keyFor(m, 'dose-templates'), JSON.stringify([...existingTmps, ...newTmps]));
                        if (newJour.length) localStorage.setItem(keyFor(m, 'journal'), JSON.stringify([...existingJour, ...newJour]));
                        mergedOther += newEvs.length + newLs.length + newJour.length;
                    }
                }
                if (typeof parsed.weight === 'number' && parsed.weight > 0) incomingWeight = parsed.weight;
            } else if (Array.isArray(parsed)) {
                incomingEvents = sanitizeImportedEvents(parsed);
            } else if (typeof parsed === 'object' && parsed !== null) {
                if (Array.isArray(parsed.events)) incomingEvents = sanitizeImportedEvents(parsed.events);
                if (typeof parsed.weight === 'number' && parsed.weight > 0) incomingWeight = parsed.weight;
                if (Array.isArray(parsed.labResults)) incomingLabs = sanitizeImportedLabResults(parsed.labResults);
                if (Array.isArray(parsed.doseTemplates)) incomingTemplates = sanitizeImportedTemplates(parsed.doseTemplates);
                if (Array.isArray(parsed.journal)) incomingJournal = sanitizeJournalEntries(parsed.journal);
            }

            // v1 flat-format safety (merge): siphon wrong-mode events *and labs*
            // into the other mode's store so a transfem backup merged from
            // transmasc mode doesn't contaminate the transmasc record.
            if (!('modes' in (parsed || {}))) {
                const otherMode: 'transfem' | 'transmasc' = mode === 'transmasc' ? 'transfem' : 'transmasc';
                const eventBelongs = (e: DoseEvent) =>
                    // Only a testosterone ester belongs to transmasc. Spironolactone
                    // is an anti-androgen and sits in a transfem regimen, so it must not
                    // be mistakable for a T record — which the bare `!isTestosteroneEster`
                    // test this replaces would have done if it had been written the other
                    // way round.
                    mode === 'transmasc' ? isTestosteroneEster(e.ester) : !isTestosteroneEster(e.ester);
                const keepEvs: DoseEvent[] = [];
                const otherEvs: DoseEvent[] = [];
                for (const e of incomingEvents) (eventBelongs(e) ? keepEvs : otherEvs).push(e);
                if (otherEvs.length) {
                    const existing = loadJSON<DoseEvent[]>(keyFor(otherMode, 'events'), []);
                    const existingIds = new Set(existing.map(x => x.id));
                    const newOnes = otherEvs.filter(e => !existingIds.has(e.id));
                    forgetDeletions('events', otherEvs.map(e => e.id), otherMode);
                    if (newOnes.length) {
                        localStorage.setItem(keyFor(otherMode, 'events'), JSON.stringify([...existing, ...newOnes]));
                        mergedOther += newOnes.length;
                    }
                    incomingEvents = keepEvs;
                }
                const labBelongs = (l: LabResult) =>
                    mode === 'transmasc' ? isT_LabUnit(l.unit) : !isT_LabUnit(l.unit);
                const keepLs: LabResult[] = [];
                const otherLs: LabResult[] = [];
                for (const l of incomingLabs) (labBelongs(l) ? keepLs : otherLs).push(l);
                if (otherLs.length) {
                    const existing = loadJSON<LabResult[]>(keyFor(otherMode, 'lab-results'), []);
                    const existingIds = new Set(existing.map(x => x.id));
                    const newOnes = otherLs.filter(l => !existingIds.has(l.id));
                    forgetDeletions('labResults', otherLs.map(l => l.id), otherMode);
                    if (newOnes.length) {
                        localStorage.setItem(keyFor(otherMode, 'lab-results'), JSON.stringify([...existing, ...newOnes]));
                        mergedOther += newOnes.length;
                    }
                    incomingLabs = keepLs;
                }
            }

            if (!mergedOther && !incomingEvents.length && !incomingWeight && !incomingLabs.length && !incomingTemplates.length && !incomingJournal.length) throw new Error('No valid entries');

            let merged = mergedOther;

            // Compute diffs synchronously against current state so the count is
            // available immediately when showDialog is called (setter callbacks
            // are invoked asynchronously by React and would not update `merged`
            // in time).
            if (incomingEvents.length > 0) {
                const existingIds = new Set(events.map(e => e.id));
                const newOnes = incomingEvents.filter(e => !existingIds.has(e.id));
                merged += newOnes.length;
                forgetDeletions('events', incomingEvents.map(e => e.id));
                if (newOnes.length > 0) setEvents(prev => [...prev, ...newOnes]);
            }

            if (incomingWeight !== undefined && incomingWeight > weight) {
                setWeight(incomingWeight);
            }

            if (incomingLabs.length > 0) {
                const existingIds = new Set(labResults.map(r => r.id));
                const newOnes = incomingLabs.filter(r => !existingIds.has(r.id));
                merged += newOnes.length;
                forgetDeletions('labResults', incomingLabs.map(r => r.id));
                if (newOnes.length > 0) setLabResults(prev => [...prev, ...newOnes]);
            }

            if (incomingTemplates.length > 0) {
                const existingIds = new Set(doseTemplates.map(t => t.id));
                const newOnes = incomingTemplates.filter(t => !existingIds.has(t.id));
                merged += newOnes.length;
                forgetDeletions('doseTemplates', incomingTemplates.map(t => t.id));
                if (newOnes.length > 0) setDoseTemplates(prev => [...prev, ...newOnes]);
            }

            if (incomingJournal.length > 0) {
                const existingIds = new Set(journal.map(e => e.id));
                const newOnes = incomingJournal.filter(e => !existingIds.has(e.id));
                merged += newOnes.length;
                forgetDeletions('journal', incomingJournal.map(e => e.id));
                if (newOnes.length > 0) setJournal(prev => [...prev, ...newOnes]);
            }

            showDialog('alert', (t('account.merge_success') as string).replace('{n}', String(merged)));
            return true;
        } catch (err) {
            console.error(err);
            showDialog('alert', t('account.merge_failed'));
            return false;
        }
    };

    const buildExportPayload = () => {
        const readMode = (m: 'transfem' | 'transmasc') => ({
            events: loadJSON<DoseEvent[]>(keyFor(m, 'events'), []),
            labResults: loadJSON<LabResult[]>(keyFor(m, 'lab-results'), []),
            doseTemplates: loadJSON<DoseTemplate[]>(keyFor(m, 'dose-templates'), []),
            quickDoses: loadJSON<QuickDose[]>(keyFor(m, 'quick-doses'), []),
            journal: loadJSON<JournalEntry[]>(keyFor(m, 'journal'), []),
            deletions: readTombstones(m),
        });
        const modes = {
            transfem: readMode('transfem'),
            transmasc: readMode('transmasc'),
        };
        // Overlay current in-memory state for the active mode.
        modes[mode] = {
            events, labResults, doseTemplates, quickDoses, journal,
            deletions: readTombstones(mode),
        };

        return {
            // 3 adds the journal collection to each mode block.
            meta: { version: 3, exportedAt: new Date().toISOString() },
            mode,
            weight,
            // Last-write stamps for the two values sync can't merge per record.
            // Missing on payloads written before sync existed, which is exactly
            // how they should lose to a stamped one.
            weightUpdatedAt: Number(localStorage.getItem(sharedKey('weight-at'))) || undefined,
            modes,
            // Flat v1-compatible fields mirror the currently active mode.
            events,
            labResults,
            doseTemplates,
            // PK parameter overrides. Explicitly `null` when the user cleared
            // them — omitting the key would read as "this payload says nothing
            // about PK params", and the cleared state would never propagate.
            pkParams: pkParams ?? null,
            pkParamsUpdatedAt: Number(localStorage.getItem(sharedKey('pk-params-at'))) || undefined,
            // App-only collections. The Core stores this verbatim in
            // `user_settings.app_state` and is the *only* place templates and
            // quick doses persist — it does not read them out of `modes` — so
            // omitting this key silently dropped them on every Core sync. The
            // calibration settings ride along for the same reason: they are
            // account-scoped, and nothing else moves them between devices.
            appState: {
                modes: {
                    transfem: {
                        doseTemplates: modes.transfem.doseTemplates,
                        quickDoses: modes.transfem.quickDoses,
                    },
                    transmasc: {
                        doseTemplates: modes.transmasc.doseTemplates,
                        quickDoses: modes.transmasc.quickDoses,
                    },
                },
                settings: {
                    ...readAppSettings(),
                    calMethod: calibrationMethod,
                    calHistoryMode: calibrationHistoryMode,
                    aaChartMode,
                    // The re-check intervals ride the settings bag, so changing one
                    // on this device reaches the next one. Always present rather than
                    // omitted at the default, so resetting an interval to the default
                    // propagates instead of leaving the other device customized.
                    recheckIntervals: JSON.stringify(recheckIntervals),
                    ocrModelTier,
                    pkEngine,
                    // Absent when never answered, which is exactly how "skipped"
                    // has to travel: an empty string is not a date.
                    ...(hrtStartDate ? { hrtStartDate } : {}),
                },
                // The stamp lives inside the blob because `appState` is the only
                // part the Core stores verbatim — a sibling top-level field would
                // be dropped on the way in and read back as "never edited".
                settingsUpdatedAt: appSettingsStamp() || undefined,
            },
        };
    };

    /**
     * Install the result of a cloud sync. Deliberately silent: this runs on its
     * own schedule, not because anyone pressed anything, and a dialog for it
     * would fire at arbitrary moments.
     *
     * Records go through the same sanitisers as a file import — the payload has
     * made a round trip through storage this device does not control, and the
     * import limits (entry ceiling, field validation, timestamp range) are the
     * reason a malformed one can't wedge the simulation.
     */
    const applySyncedState = (state: SyncState): void => {
        // Sanitise both modes up front: the sanitisers throw on an oversized
        // payload, and doing that halfway through the writes would leave one
        // mode updated and the other not.
        const clean = MODE_KEYS.map(m => ({
            m,
            events: sanitizeImportedEvents(state.modes[m].events),
            labResults: sanitizeImportedLabResults(state.modes[m].labResults),
            doseTemplates: sanitizeImportedTemplates(state.modes[m].doseTemplates),
            quickDoses: state.modes[m].quickDoses ?? [],
            journal: sanitizeJournalEntries(state.modes[m].journal ?? []),
            deletions: state.modes[m].deletions,
        }));

        for (const block of clean) {
            writeTombstones(block.m, block.deletions);
            localStorage.setItem(keyFor(block.m, 'events'), JSON.stringify(block.events));
            localStorage.setItem(keyFor(block.m, 'lab-results'), JSON.stringify(block.labResults));
            localStorage.setItem(keyFor(block.m, 'dose-templates'), JSON.stringify(block.doseTemplates));
            localStorage.setItem(keyFor(block.m, 'quick-doses'), JSON.stringify(block.quickDoses));
            localStorage.setItem(keyFor(block.m, 'journal'), JSON.stringify(block.journal));
            if (block.m === mode) {
                setEvents(block.events);
                setLabResults(block.labResults);
                setDoseTemplates(block.doseTemplates);
                setQuickDoses(block.quickDoses);
                setJournal(block.journal);
            }
        }

        // App-only settings, including whichever ones the merge decided this
        // device should adopt. Writing the storage keys is only half of it — the
        // contexts that own them have to be told, or the theme on screen stays
        // the one this device booted with until the next reload.
        if (state.appSettings) {
            const { calMethod, calHistoryMode, aaChartMode, hrtStartDate, recheckIntervals, ocrModelTier, pkEngine: syncedPkEngine, ...global } = state.appSettings;
            // The merge's stamp is handed to `applyAppSettings` so this device
            // records the account's settings as *adopted*, not as an edit of its
            // own — otherwise it would immediately look newer and push the same
            // values straight back.
            applyAppSettings(global, state.appSettingsUpdatedAt);
            if (calMethod) {
                const normalized = normalizeCalibrationMethod(calMethod);
                setCalibrationMethodState(normalized);
                localStorage.setItem(sharedKey('cal-method'), normalized);
            }
            if (calHistoryMode) {
                const normalized: CalibrationHistoryMode = calHistoryMode === 'forward' ? 'forward' : 'retrospective';
                setCalibrationHistoryModeState(normalized);
                localStorage.setItem(sharedKey('cal-history-mode'), normalized);
            }
            if (aaChartMode) {
                const normalized = normalizeAntiandrogenChartMode(aaChartMode);
                setAaChartModeState(normalized);
                localStorage.setItem(sharedKey('aa-chart'), normalized);
            }
            // Set on the raw setter, not `setRecheckIntervals`: adopting the
            // account's value must not stamp it as this device's edit.
            if (recheckIntervals !== undefined) {
                const normalized = normalizeRecheckIntervals(recheckIntervals);
                setRecheckIntervalsState(normalized);
                try { localStorage.setItem(sharedKey('recheck-intervals'), JSON.stringify(normalized)); } catch { /* private mode */ }
            }
            if (ocrModelTier !== undefined) {
                const normalized = normalizeOcrModelTier(ocrModelTier);
                setOcrModelTierState(normalized);
                try { localStorage.setItem(sharedKey('ocr-model-tier'), normalized); } catch { /* private mode */ }
            }
            // Raw setter again: the engine choice follows the account, so adopting it
            // must not look like this device's own edit and bounce back.
            if (syncedPkEngine !== undefined) {
                const normalized = normalizePkEngine(syncedPkEngine);
                setPkEngineState(normalized);
                try { localStorage.setItem(sharedKey('pk-engine'), normalized); } catch { /* private mode */ }
            }
            // Set on the raw setters, not `setHrtStartDate`: adopting the
            // account's value must not stamp it as this device's edit.
            if (hrtStartDate !== undefined) {
                const normalized = normalizeHrtStartDate(hrtStartDate) ?? '';
                setHrtStartDateState(normalized);
                if (normalized) localStorage.setItem(sharedKey('hrt-start'), normalized);
                else localStorage.removeItem(sharedKey('hrt-start'));
            }
        }

        // Scalars keep the winning side's stamp rather than being restamped
        // "now" — restamping would make every sync look like a fresh local edit
        // and let a stale value beat a newer one on the next round.
        if (state.weight !== undefined && isPlausibleBodyWeightKG(state.weight)) {
            setWeightState(state.weight);
            localStorage.setItem(sharedKey('weight'), String(state.weight));
            if (state.weightUpdatedAt > 0) localStorage.setItem(sharedKey('weight-at'), String(state.weightUpdatedAt));
        }
        if (state.pkParams !== undefined) {
            const next = sanitizePKParams(state.pkParams);
            setPkParamsState(next);
            if (next) localStorage.setItem(sharedKey('pk-params'), JSON.stringify(next));
            else localStorage.removeItem(sharedKey('pk-params'));
            if (state.pkParamsUpdatedAt > 0) localStorage.setItem(sharedKey('pk-params-at'), String(state.pkParamsUpdatedAt));
        }
    };

    return {
        events, setEvents,
        weight, setWeight,
        labResults, setLabResults,
        doseTemplates, setDoseTemplates,
        quickDoses, setQuickDoses,
        pkParams,
        setPkParams,
        clearPkParams,
        resetPkParams,
        simulation,
        currentTime,
        calibrationFn,
        calibrationMethod, setCalibrationMethod,
        calibrationHistoryMode, setCalibrationHistoryMode,
        aaChartMode, setAaChartMode,
        hrtStartDate, setHrtStartDate,
        recheckIntervals, setRecheckIntervals,
        ocrModelTier, setOcrModelTier,
        pkEngine, setPkEngine,
        dismissedRechecks, dismissRecheck,
        pendingMilestone,
        showStreakNotice, dismissStreakNotice,
        calibration,
        currentLevel,
        currentT,
        currentStatus,
        groupedEvents,
        addEvent, addEvents, updateEvent, deleteEvent, deleteEvents, clearAllEvents,
        addLabResult, updateLabResult, deleteLabResult, clearLabResults,
        journal, setJournal, addJournalEntry, updateJournalEntry, deleteJournalEntry,
        addTemplate, deleteTemplate,
        addQuickDose, deleteQuickDose,
        processImportedData,
        mergeImportedData,
        buildExportPayload,
        applySyncedState,
        // (account, mode) currently selected vs. the one whose data is actually
        // in state. Cloud sync waits for the two to agree — see readyScope.
        scope,
        readyScope,
    };
};
