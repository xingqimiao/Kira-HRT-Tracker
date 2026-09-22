/**
 * Two-way merge between this device's records and the newest cloud backup.
 *
 * Replaces the old "detect a difference and ask the user what to do" flow. The
 * prompt could not actually resolve anything — its only action added records
 * the cloud had and this device lacked, so an edit or a deletion left the two
 * sides diverged and the dialog returned on every launch.
 *
 * The merge here is deterministic and symmetric: run it on either device with
 * the same pair of inputs and you get the same result, which is what lets both
 * sides converge without a server-side resolver.
 *
 * Three rules do the work:
 *
 *   - **Records union by id.** Anything either side has, the merge has.
 *   - **Deletions are recorded, not inferred.** Removing a record leaves a
 *     tombstone (id + when). "Absent here, present there" is otherwise
 *     ambiguous — added over there, or deleted over here? — and a plain union
 *     resolves that ambiguity the wrong way every time, resurrecting records
 *     the user deliberately removed. A tombstone answers it outright.
 *   - **Same id, different contents → newest `updatedAt` wins.** Ties (and
 *     records predating `updatedAt`) fall back to comparing the content
 *     fingerprint, purely so both devices pick the *same* side; without a
 *     deterministic tiebreak each keeps its own and the two flip-flop the cloud
 *     backup between them forever.
 *
 * Scalars that aren't records — body weight, PK overrides — carry their own
 * last-write timestamp and are resolved last-write-wins.
 */

import { isTestosteroneEster, isT_LabUnit } from '../../logic';

export type ModeKey = 'transfem' | 'transmasc';
export const MODE_KEYS: readonly ModeKey[] = ['transfem', 'transmasc'];

export type RecordKind = 'events' | 'labResults' | 'doseTemplates' | 'journal';
export const RECORD_KINDS: readonly RecordKind[] = ['events', 'labResults', 'doseTemplates', 'journal'];

/** id -> epoch ms the record was deleted. */
export type TombstoneMap = Record<string, number>;
export type Tombstones = Record<RecordKind, TombstoneMap>;

export interface ModeBlock {
    events: any[];
    labResults: any[];
    doseTemplates: any[];
    /**
     * Quick-add buttons. An app convenience rather than a clinical record, but it
     * still has to round-trip: they live per mode on the client, and the Core
     * carries them in `app_state.modes[mode].quickDoses`.
     */
    quickDoses: any[];
    /**
     * Private body-and-mood check-ins. One person's own records, stored like every
     * other collection and merged by the same union-plus-tombstone rules.
     */
    journal: any[];
    deletions: Tombstones;
}

/**
 * The app-only settings a user configures once and expects on every device:
 * theme, key colour, language, HRT mode, vial visibility, and the calibration
 * method and history window.
 *
 * These are not clinical records and nothing here validates them beyond their
 * type — but they are the difference between a new device being ready to use and
 * the user configuring everything again by hand. They travel in the Core's
 * `user_settings.app_state` blob.
 *
 * Settings alone never count as "content" for the first upload (see
 * `hasContent`), matching how the default body weight is treated: they ride along
 * with the first record rather than minting an otherwise-empty backup.
 */
export interface AppSettings {
    theme?: string;
    keyColor?: string;
    lang?: string;
    hrtMode?: string;
    showVial?: boolean;
    calMethod?: string;
    calHistoryMode?: string;
    /** How the Home card's anti-androgen column reads — see antiandrogenReading. */
    aaChartMode?: string;
    /**
     * `YYYY-MM-DD` the user's HRT began, or absent when they never said. Only the
     * account line "HRT started N days ago" reads it — see hrtStart.ts.
     */
    hrtStartDate?: string;
    /**
     * The re-check intervals, JSON-encoded (see `RecheckIntervals` in logic.ts).
     *
     * A preference, so it syncs — unlike the *dismissal* state, which stays on the
     * device it was closed on. A medical reminder should reappear on a second
     * device rather than be silently suppressed by the first.
     */
    recheckIntervals?: string;
    /**
     * Which OCR model tier the lab scan uses.
     *
     * A string rather than the union on purpose: this is a synced payload, so it can
     * carry a tier this build has retired ('tiny'). `normalizeOcrModelTier` is what
     * settles it — reading the type as the union here would be a claim about the data
     * that a payload from an older client is free to break.
     */
    ocrModelTier?: string;
    /**
     * Which pharmacokinetic engine computes the curve: 'builtin' (default) or
     * 'transmtf'.
     *
     * A string for the same reason as `ocrModelTier`: this is a synced payload, so
     * it may name an engine this build does not have, and `normalizePkEngine` is what
     * settles it. The preference travels with the account so two devices show the
     * same curve.
     */
    pkEngine?: string;
    /**
     * IANA timezone the account's times are read in, e.g. `Asia/Tokyo`.
     *
     * The app has no control for it yet, so it is usually only ever written by an
     * agent through `hrt_update_settings`. It travels with the rest of the bag
     * anyway: a setting the server holds and the app silently drops is exactly the
     * one-way street this transport exists to close.
     */
    timezone?: string;
}

/** Every key `sanitizeAppSettings` will carry. An unknown key is dropped. */
export const APP_SETTING_KEYS: readonly (keyof AppSettings)[] = [
    'theme', 'keyColor', 'lang', 'hrtMode', 'showVial', 'calMethod', 'calHistoryMode', 'aaChartMode',
    'hrtStartDate', 'recheckIntervals', 'ocrModelTier', 'pkEngine', 'timezone',
];

export interface SyncState {
    modes: Record<ModeKey, ModeBlock>;
    /** `undefined` = the payload said nothing about weight. */
    weight?: number;
    weightUpdatedAt: number;
    /** `undefined` = unstated; `null` = explicitly "no overrides". */
    pkParams?: any;
    pkParamsUpdatedAt: number;
    /**
     * App-only configuration, carried in `app_state.settings`.
     *
     * Resolved as a *whole bag* on its stamp, like the two scalars above, rather
     * than per key. Per-key "local wins" cannot be used here: it is not
     * symmetric, so two configured devices would each decide the other was wrong
     * and rewrite the account forever — the same flip-flop the scalar rule's
     * deterministic tiebreak exists to stop. A whole-bag rule is sound because
     * every key is written on first boot, so a device that has run the app at all
     * holds a complete bag.
     */
    appSettings?: AppSettings;
    appSettingsUpdatedAt: number;
}

/**
 * The scalars that travel beside the mode blocks, each with its own stamp.
 *
 * Listed once so the compile-time assertion below can refuse a new `SyncState`
 * field that has no home on the record path. The transport used to name these in
 * three places (`toLocalPayload`, `recordsToPayload`, `normalizeSyncState`) and
 * `toLocalPayload` built only `weight`, so PK overrides were dropped before a
 * record was ever written and nothing failed.
 */
export const SYNC_SCALARS = ['weight', 'pkParams', 'appSettings'] as const;

type SyncScalarField = (typeof SYNC_SCALARS)[number] | `${(typeof SYNC_SCALARS)[number]}UpdatedAt`;
type UnaccountedSyncField = Exclude<keyof SyncState, 'modes' | SyncScalarField>;
const _everySyncFieldIsAScalar: [UnaccountedSyncField] extends [never]
  ? true
  : ['SyncState field is not a declared scalar', UnaccountedSyncField] = true;
void _everySyncFieldIsAScalar;

export interface MergeStats {
    /** Records the cloud had that this device did not. */
    added: number;
    /** Records replaced by a newer version from the cloud. */
    updated: number;
    /** Records dropped here because another device deleted them. */
    removed: number;
}

export interface MergeResult {
    merged: SyncState;
    stats: MergeStats;
    /** The merge changed what this device holds — apply it locally. */
    localChanged: boolean;
    /** The merge holds something the cloud backup does not — push it. */
    remoteStale: boolean;
}

/**
 * Tombstones are kept long enough to reach a device that has been offline for a
 * season, and no longer. A device that misses the window resurrects the record
 * — the same failure any tombstone-expiring system has, traded against a
 * deletion log that grows without bound.
 */
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling per kind, so a mass delete can't push the backup past the 2 MiB
 * the endpoint accepts. Past it the oldest tombstones are dropped, and records
 * they covered come back if another device still holds them — clearing a
 * history longer than this in one go is the only way to reach that.
 */
export const TOMBSTONE_MAX_PER_KIND = 5000;

// --- Shapes -----------------------------------------------------------------

export function emptyTombstones(): Tombstones {
    return { events: {}, labResults: {}, doseTemplates: {}, journal: {} };
}

function emptyModeBlock(): ModeBlock {
    return { events: [], labResults: [], doseTemplates: [], quickDoses: [], journal: [], deletions: emptyTombstones() };
}

export function emptySyncState(): SyncState {
    return {
        modes: { transfem: emptyModeBlock(), transmasc: emptyModeBlock() },
        weightUpdatedAt: 0,
        pkParamsUpdatedAt: 0,
        appSettingsUpdatedAt: 0,
    };
}

function asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

function asTimestamp(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function sanitizeTombstoneMap(raw: unknown): TombstoneMap {
    const out: TombstoneMap = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
        if (!id) continue;
        const ts = asTimestamp(at);
        if (ts > 0) out[id] = ts;
    }
    return out;
}

export function sanitizeTombstones(raw: unknown): Tombstones {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        events: sanitizeTombstoneMap(src.events),
        labResults: sanitizeTombstoneMap(src.labResults),
        doseTemplates: sanitizeTombstoneMap(src.doseTemplates),
        journal: sanitizeTombstoneMap(src.journal),
    };
}

/**
 * Keep only known settings keys with a usable value.
 *
 * A payload from a future build (or a hand-edited file) must not be able to put
 * this build into a state its own readers do not understand, so an unrecognised
 * key is dropped rather than stored. The value is carried as-is otherwise: these
 * are the user's choices in their own language, not enumerations this module
 * ought to police.
 */
/**
 * Post-upgrade compatibility: `showVial` is the one non-string setting, so the
 * per-key value type is decided by the key rather than by the value. Accepting a
 * string for every key (the obvious `typeof value === 'string'` check) would let a
 * payload put `showVial: 'false'` into state, where its own reader — which
 * compares against the string 'false' — would read it as *true*.
 */
const BOOLEAN_SETTING_KEYS: ReadonlySet<keyof AppSettings> = new Set(['showVial']);

export function sanitizeAppSettings(raw: unknown): AppSettings {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const src = raw as Record<string, unknown>;
    // Accumulated as `unknown` and cast once: under the key union the write type
    // is the *intersection* of the member types, so `showVial`'s boolean and the
    // rest's string collapse to `never` and no per-key assignment type-checks —
    // even though each branch here has just checked the value's type.
    const out: Record<string, unknown> = {};
    for (const key of APP_SETTING_KEYS) {
        const value = src[key];
        if (BOOLEAN_SETTING_KEYS.has(key)) {
            if (typeof value === 'boolean') out[key] = value;
        } else if (typeof value === 'string' && value !== '') {
            out[key] = value;
        }
    }
    return out as AppSettings;
}

/** Drop expired entries, then the oldest ones once the per-kind ceiling is hit. */
export function pruneTombstoneMap(map: TombstoneMap, now: number): TombstoneMap {
    const live = Object.entries(map).filter(([, at]) => now - at < TOMBSTONE_TTL_MS);
    if (live.length > TOMBSTONE_MAX_PER_KIND) {
        live.sort((a, b) => b[1] - a[1]);
        live.length = TOMBSTONE_MAX_PER_KIND;
    }
    return Object.fromEntries(live);
}

export function pruneTombstones(t: Tombstones, now: number): Tombstones {
    return {
        events: pruneTombstoneMap(t.events, now),
        labResults: pruneTombstoneMap(t.labResults, now),
        doseTemplates: pruneTombstoneMap(t.doseTemplates, now),
        journal: pruneTombstoneMap(t.journal, now),
    };
}

function mergeTombstoneMaps(a: TombstoneMap, b: TombstoneMap): TombstoneMap {
    const out: TombstoneMap = { ...a };
    for (const [id, at] of Object.entries(b)) {
        if (!(id in out) || at > out[id]) out[id] = at;
    }
    return out;
}

// --- Payload normalisation --------------------------------------------------

/**
 * Route a flat (pre-`modes`) payload into the two mode blocks.
 *
 * The payload's own `mode` field is deliberately not trusted: v1 exports
 * predate it entirely, and a payload assembled by hand or by an older build can
 * carry both kinds regardless of what it claims. The ester / lab-unit partition
 * is what the import path already uses to keep testosterone records out of the
 * transfem log, and it answers per record rather than per file.
 */
function routeFlatPayload(payload: any, modes: Record<ModeKey, ModeBlock>): void {    for (const ev of asArray(payload.events)) {
        if (!ev || typeof ev !== 'object') continue;
        modes[isTestosteroneEster(ev.ester) ? 'transmasc' : 'transfem'].events.push(ev);
    }
    for (const lab of asArray(payload.labResults)) {
        if (!lab || typeof lab !== 'object') continue;
        modes[isT_LabUnit(lab.unit) ? 'transmasc' : 'transfem'].labResults.push(lab);
    }
    for (const tpl of asArray(payload.doseTemplates)) {
        if (!tpl || typeof tpl !== 'object') continue;
        modes[isTestosteroneEster(tpl.ester) ? 'transmasc' : 'transfem'].doseTemplates.push(tpl);
    }
}

/** Read any export/backup payload — bare array, flat v1, or v2 `modes` — into a SyncState. */
export function normalizeSyncState(payload: unknown): SyncState {
    const state = emptySyncState();
    if (!payload) return state;

    // Oldest export format: a naked array of dose events.
    if (Array.isArray(payload)) {
        routeFlatPayload({ events: payload }, state.modes);
        return state;
    }
    if (typeof payload !== 'object') return state;

    const p = payload as Record<string, any>;

    if (p.modes && typeof p.modes === 'object' && !Array.isArray(p.modes)) {
        for (const m of MODE_KEYS) {
            const block = p.modes[m];
            if (!block || typeof block !== 'object') continue;
            state.modes[m] = {
                events: asArray(block.events),
                labResults: asArray(block.labResults),
                doseTemplates: asArray(block.doseTemplates),
                quickDoses: asArray(block.quickDoses),
                journal: asArray(block.journal),
                deletions: sanitizeTombstones(block.deletions),
            };
        }
    } else {
        routeFlatPayload(p, state.modes);
    }

    if (typeof p.weight === 'number' && Number.isFinite(p.weight) && p.weight > 0) {
        state.weight = p.weight;
        // A payload from before per-field stamps still has to lose to a stamped
        // one, but must beat "nothing at all" — hence 1 rather than 0.
        state.weightUpdatedAt = asTimestamp(p.weightUpdatedAt) || 1;
    }
    if (p.pkParams !== undefined) {
        state.pkParams = p.pkParams ?? null;
        state.pkParamsUpdatedAt = asTimestamp(p.pkParamsUpdatedAt) || 1;
    }

    // App-only settings ride in the Core's `app_state.settings`, read here rather
    // than at the call site so every surface that consumes a payload — sync, a
    // file import, a hand-written file — applies them the same way.
    const settings = sanitizeAppSettings((p.appState as any)?.settings);
    if (Object.keys(settings).length > 0) {
        state.appSettings = settings;
        // A payload from a build that predates the stamp still has to lose to a
        // stamped one, and beat "nothing at all" — the same floor of 1 the other
        // scalars use.
        state.appSettingsUpdatedAt = asTimestamp((p.appState as any)?.settingsUpdatedAt) || 1;
    }

    return state;
}

// --- Content fingerprints ---------------------------------------------------

/**
 * Fields that decide whether two records with the same id are the same record.
 * `updatedAt` is excluded on purpose: it is bookkeeping, and including it would
 * make two byte-identical records look like a conflict.
 */
const CONTENT_FIELDS: Record<RecordKind, readonly string[]> = {
    events: ['route', 'ester', 'doseMG', 'timeH', 'extras'],
    // Monitoring bloods are part of the record, so a later edit to prolactin/ALT/K
    // has to show up as a content change; omitting them made the merge treat the two
    // versions as the same record and keep whichever copy it already held.
    labResults: ['unit', 'concValue', 'timeH', 'monitoringOnly', 'prolactin', 'prolactinUln', 'alt', 'altUln', 'ast', 'potassium'],
    doseTemplates: ['name', 'route', 'ester', 'doseMG', 'extras'],
    // Everything a check-in holds. The scales may be absent ("not answered"),
    // which stableString renders as an empty slot, so one answered scale is
    // enough to make an edit visible.
    journal: ['timeH', 'urinaryTolerance', 'skinOil', 'hairLoss', 'bodyHair', 'moodTolerance', 'symptoms', 'note'],
};

export function stableString(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
    if (typeof value === 'object') {
        const o = value as Record<string, unknown>;
        return `{${Object.keys(o).sort().map(k => `${k}:${stableString(o[k])}`).join(',')}}`;
    }
    // Normalise numerics so 4, 4.0 and a hand-edited "4" don't read as an edit.
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const n = Number(value);
    return Number.isFinite(n) && String(value).trim() !== '' ? String(n) : String(value);
}

function contentFingerprint(kind: RecordKind, record: any): string {
    return CONTENT_FIELDS[kind].map(f => stableString(record?.[f])).join('|');
}

function recordId(record: any): string | null {
    return record && typeof record.id === 'string' && record.id ? record.id : null;
}

function recordStamp(record: any): number {
    return asTimestamp(record?.updatedAt);
}

/**
 * Union quick-add buttons by id.
 *
 * These carry no `updatedAt`, so newest-wins is not available. The tiebreak is
 * the content fingerprint — the same device-independent choice `resolveScalar`
 * makes for its ties, and for the same reason: "prefer local" has two devices
 * each decide the other is wrong and rewrite the account forever.
 */
function mergeQuickDoses(local: any[], remote: any[]): any[] {
    const out = new Map<string, any>();
    for (const record of local) {
        const id = recordId(record);
        if (id) out.set(id, record);
    }
    for (const record of remote) {
        const id = recordId(record);
        if (!id) continue;
        const mine = out.get(id);
        if (mine === undefined) {
            out.set(id, record);
            continue;
        }
        if (stableString(record) > stableString(mine)) out.set(id, record);
    }
    return [...out.values()];
}

// --- Merge ------------------------------------------------------------------

function mergeKind(
    kind: RecordKind,
    local: any[],
    remote: any[],
    tombstones: TombstoneMap,
    stats: MergeStats,
): any[] {
    const out = new Map<string, any>();
    const dropped = new Set<string>();

    for (const record of local) {
        const id = recordId(record);
        if (!id) continue;
        if (tombstones[id] !== undefined) {
            // Deleted on another device (or on this one, before a restore put it
            // back in the file we are merging).
            if (!dropped.has(id)) {
                dropped.add(id);
                stats.removed++;
            }
            continue;
        }
        out.set(id, record);
    }

    for (const record of remote) {
        const id = recordId(record);
        if (!id) continue;
        if (tombstones[id] !== undefined) continue;

        const mine = out.get(id);
        if (mine === undefined) {
            out.set(id, record);
            stats.added++;
            continue;
        }

        const mineFp = contentFingerprint(kind, mine);
        const theirsFp = contentFingerprint(kind, record);
        if (mineFp === theirsFp) {
            // Same record on both sides. Adopt the later stamp so the two copies
            // stop differing in metadata and the comparison settles.
            const stamp = Math.max(recordStamp(mine), recordStamp(record));
            if (stamp > 0 && recordStamp(mine) !== stamp) out.set(id, { ...mine, updatedAt: stamp });
            continue;
        }

        const mineAt = recordStamp(mine);
        const theirsAt = recordStamp(record);
        const theirsWins = theirsAt !== mineAt
            ? theirsAt > mineAt
            // Neither side is provably newer. Pick by fingerprint so this device
            // and the other one reach the same answer and stop overwriting each
            // other; which of the two it lands on is arbitrary by necessity.
            : theirsFp > mineFp;
        if (theirsWins) {
            out.set(id, record);
            stats.updated++;
        }
    }

    return [...out.values()];
}

/**
 * Later stamp wins; a side that says nothing never beats one that does.
 *
 * The tie needs the same deterministic tiebreak the records get, and for the
 * same reason. Two devices upgrading from a build that never stamped weight
 * both arrive with the floor stamp, so "keep local on a tie" has each of them
 * decide the other is wrong and upload — for as long as both stay open, against
 * an endpoint that keeps ten revisions.
 */
function resolveScalar<T>(
    localValue: T | undefined, localAt: number,
    remoteValue: T | undefined, remoteAt: number,
): { value: T | undefined; at: number } {
    if (localValue === undefined) return { value: remoteValue, at: remoteAt };
    if (remoteValue === undefined) return { value: localValue, at: localAt };
    if (remoteAt !== localAt) {
        return remoteAt > localAt
            ? { value: remoteValue, at: remoteAt }
            : { value: localValue, at: localAt };
    }
    return stableString(remoteValue) > stableString(localValue)
        ? { value: remoteValue, at: remoteAt }
        : { value: localValue, at: localAt };
}

/**
 * Settings are resolved as one bag on their stamp, by the same rule and for the
 * same reason as the two scalars above (see `resolveScalar`) — hence the direct
 * call at the call site rather than a bespoke rule here.
 */

/**
 * Build the `appState` blob the Core stores, from a merged state.
 *
 * The Core keeps two different things in one column: `modes` (templates and
 * quick doses, which the server surfaces back under `modes`) and `settings`
 * (app-only preferences, which only the app reads). Both directions live here so
 * the shape has one definition rather than one per call site — the previous
 * arrangement had the build side and the read side disagreeing, which is exactly
 * how the blob came to be written by nothing.
 */
export function toAppState(state: SyncState): Record<string, unknown> {
    const modes: Record<string, unknown> = {};
    for (const m of MODE_KEYS) {
        modes[m] = {
            doseTemplates: state.modes[m].doseTemplates,
            quickDoses: state.modes[m].quickDoses,
        };
    }
    return {
        modes,
        ...(state.appSettings && Object.keys(state.appSettings).length > 0
            ? { settings: state.appSettings }
            : {}),
        // Inside the blob: the Core stores `appState` verbatim and returns only
        // that, so a stamp kept outside it would not survive the round trip.
        ...(state.appSettingsUpdatedAt > 0
            ? { settingsUpdatedAt: state.appSettingsUpdatedAt }
            : {}),
    };
}

export function mergeSyncStates(local: SyncState, remote: SyncState | null): MergeResult {
    const stats: MergeStats = { added: 0, updated: 0, removed: 0 };

    if (!remote) {
        return {
            merged: local,
            stats,
            localChanged: false,
            // Nothing in the cloud yet — worth uploading only if there is
            // something to upload.
            remoteStale: hasContent(local),
        };
    }

    const merged = emptySyncState();
    for (const m of MODE_KEYS) {
        const deletions: Tombstones = {
            events: mergeTombstoneMaps(local.modes[m].deletions.events, remote.modes[m].deletions.events),
            labResults: mergeTombstoneMaps(local.modes[m].deletions.labResults, remote.modes[m].deletions.labResults),
            doseTemplates: mergeTombstoneMaps(local.modes[m].deletions.doseTemplates, remote.modes[m].deletions.doseTemplates),
            journal: mergeTombstoneMaps(local.modes[m].deletions.journal, remote.modes[m].deletions.journal),
        };
        merged.modes[m] = {
            events: mergeKind('events', local.modes[m].events, remote.modes[m].events, deletions.events, stats),
            labResults: mergeKind('labResults', local.modes[m].labResults, remote.modes[m].labResults, deletions.labResults, stats),
            doseTemplates: mergeKind('doseTemplates', local.modes[m].doseTemplates, remote.modes[m].doseTemplates, deletions.doseTemplates, stats),
            quickDoses: mergeQuickDoses(local.modes[m].quickDoses, remote.modes[m].quickDoses),
            journal: mergeKind('journal', local.modes[m].journal, remote.modes[m].journal, deletions.journal, stats),
            deletions,
        };
    }

    const weight = resolveScalar(local.weight, local.weightUpdatedAt, remote.weight, remote.weightUpdatedAt);
    merged.weight = weight.value;
    merged.weightUpdatedAt = weight.at;

    const pk = resolveScalar(local.pkParams, local.pkParamsUpdatedAt, remote.pkParams, remote.pkParamsUpdatedAt);
    merged.pkParams = pk.value;
    merged.pkParamsUpdatedAt = pk.at;

    const appSettings = resolveScalar(
        local.appSettings, local.appSettingsUpdatedAt,
        remote.appSettings, remote.appSettingsUpdatedAt,
    );
    merged.appSettings = appSettings.value;
    merged.appSettingsUpdatedAt = appSettings.at;

    const mergedFp = fingerprintState(merged);
    return {
        merged,
        stats,
        localChanged: mergedFp !== fingerprintState(local),
        remoteStale: mergedFp !== fingerprintState(remote),
    };
}

/**
 * Whether a state holds anything a user put there.
 *
 * Comparing against an empty state does not answer this: every payload this app
 * builds carries a body weight, defaulted to 70 kg, so "differs from empty" is
 * true the moment you sign in and mints a backup holding nothing but that
 * default. A scalar counts only once it has a real stamp — the floor stamp of 1
 * is what an unstamped payload gets, the untouched default included.
 */
export function hasContent(state: SyncState): boolean {
    for (const m of MODE_KEYS) {
        const block = state.modes[m];
        for (const kind of RECORD_KINDS) {
            if ((block[kind] as any[]).length > 0) return true;
            if (Object.keys(block.deletions[kind]).length > 0) return true;
        }
    }
    return state.weightUpdatedAt > 1 || state.pkParamsUpdatedAt > 1;
}

/**
 * Stable identity of a state's *content*, used to decide whether a write is
 * worth making. Ordering, `updatedAt`, and tombstone timestamps are excluded:
 * two devices legitimately disagree on all three while holding the same data,
 * and counting those as a difference would have them upload to each other in a
 * loop — against a backup endpoint that keeps ten revisions and rate-limits to
 * twenty writes a minute.
 */
export function fingerprintState(state: SyncState): string {
    const parts: string[] = [];
    for (const m of MODE_KEYS) {
        const block = state.modes[m];
        for (const kind of RECORD_KINDS) {
            const rows = (block[kind] as any[])
                .map(r => {
                    const id = recordId(r);
                    return id ? `${id}=${contentFingerprint(kind, r)}` : null;
                })
                .filter((r): r is string => r !== null)
                .sort();
            parts.push(`${m}.${kind}:${rows.join(';')}`);
            parts.push(`${m}.${kind}.del:${Object.keys(block.deletions[kind]).sort().join(';')}`);
        }
        // Sorted by id so two devices holding the same buttons in a different
        // order do not read as a change and push to each other in a loop.
        const quick = block.quickDoses
            .map(r => {
                const id = recordId(r);
                return id ? `${id}=${stableString(r)}` : null;
            })
            .filter((r): r is string => r !== null)
            .sort();
        parts.push(`${m}.quickDoses:${quick.join(';')}`);
    }
    parts.push(`weight:${state.weight === undefined ? '' : stableString(state.weight)}`);
    parts.push(`pkParams:${state.pkParams === undefined ? '' : stableString(state.pkParams)}`);
    // Settings participate: changing the theme is a change worth pushing, and
    // omitting them here would have the change sit locally until some unrelated
    // record edit happened to make the fingerprint differ.
    parts.push(`appSettings:${state.appSettings === undefined ? '' : stableString(state.appSettings)}`);
    return parts.join('\n');
}
