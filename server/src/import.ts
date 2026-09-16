/**
 * Moving records between an account and the web app's own export format.
 *
 * Two directions, one shape. The app already exports JSON (optionally compressed
 * or encrypted) and already knows how to read every shape it has ever written, so
 * this reuses the app's `normalizeSyncState` rather than writing a second parser
 * that would drift from the first. Import and export are deliberately
 * round-trippable: what the app pushes is what it gets back.
 *
 * Deletions travel as tombstones rather than as absence. The app's sync unions
 * records by id, so "the other side lacks this id" is ambiguous — added over
 * there, or deleted over here? Records it as deleted (`deleted_at`, already
 * stored) is what lets a delete stick instead of being resurrected on the next
 * sync, and it is the same reason the app's own cloud sync keeps tombstones.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { normalizeSyncState } from '../../src/utils/syncMerge.ts';
import { decryptData, decompressData, isTestosteroneEster, isT_LabUnit } from '../src/engine.ts';
import { getPool } from '../src/db.ts';
import { medications, labs, settings } from '../src/store.ts';
import { parseMedicationInput, parseLabInput, parseBodyWeight } from '../src/domain.ts';
import type { AuthContext } from '../src/core.ts';
import type { DoseEvent, LabResult } from '../src/engine.ts';
import type { Result } from '../src/domain.ts';

const HOUR = 3_600_000;
type Mode = 'transfem' | 'transmasc';
const MODES: readonly Mode[] = ['transfem', 'transmasc'];

export interface ImportSummary {
  eventsImported: number;
  eventsUpdated: number;
  eventsSkipped: number;
  labsImported: number;
  labsUpdated: number;
  labsSkipped: number;
  eventsRejected: { reason: string; id: string }[];
  labsRejected: { reason: string; id: string }[];
  mode: Mode;
  weight: number | null;
}

function emptySummary(mode: Mode = 'transfem'): ImportSummary {
  return {
    eventsImported: 0,
    eventsUpdated: 0,
    eventsSkipped: 0,
    labsImported: 0,
    labsUpdated: 0,
    labsSkipped: 0,
    eventsRejected: [],
    labsRejected: [],
    mode,
    weight: null,
  };
}

/**
 * Unwrap the file-level container.
 *
 * Two wrappers can be present, and they nest: an encrypted export decrypts to a
 * possibly-compressed payload. The app writes `{encrypted:true, iv, salt, iter,
 * data}` for encryption and `{c:"<base64 gzip>"}` for compression, and applies
 * them in that order on import — matching the app's own order is what makes a
 * file it accepts also work here.
 */
async function unwrap(rawText: string, password?: string): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('file is not valid JSON');
  }

  if (parsed && typeof parsed === 'object' && (parsed as { encrypted?: unknown }).encrypted === true) {
    if (!password) throw new Error('this export is encrypted; pass the password to import it');
    const decrypted = await decryptData(rawText, password);
    if (decrypted === null) throw new Error('wrong password for this encrypted export');
    parsed = JSON.parse(decrypted);
  }

  // Compression can sit inside the encryption, so this is checked afterwards.
  if (parsed && typeof parsed === 'object' && typeof (parsed as { c?: unknown }).c === 'string') {
    parsed = JSON.parse(await decompressData((parsed as { c: string }).c));
  }

  return parsed;
}

/**
 * Import an already-parsed payload.
 *
 * Records are validated with the same rules the live API uses, so a payload
 * carrying something the model cannot represent (a zero dose, a timestamp before
 * 1970) is reported rather than stored. Rejections do not abort: a five-year
 * history with one bad row should land, not fail whole.
 *
 * `updateExisting` is the difference between an import and a sync. An import
 * creates what is missing and leaves existing records alone — a re-import must
 * not overwrite edits made later on another device. A sync also takes incoming
 * changes, but only when the incoming record is genuinely newer by its own
 * `updatedAt`, which is the same rule the app's merge uses.
 */
export async function importPayload(
  ctx: AuthContext,
  payload: unknown,
  opts: { mode?: Mode; updateExisting?: boolean; resurrect?: boolean } = {},
): Promise<ImportSummary> {
  // Defaults differ by intent: a file import is an explicit "here is my record",
  // so it revives deleted rows; a sync must let a tombstone win, or a deletion
  // could never propagate (see `createOrResurrect` in store.ts).
  const resurrect = opts.resurrect ?? false;
  const state = normalizeSyncState(payload);
  const summary = emptySummary(opts.mode ?? 'transfem');

  // Importing both modes by default keeps the record complete rather than silently
  // dropping whichever mode the account is not currently set to — someone who
  // switched modes has real history on both sides.
  const modes = opts.mode ? [opts.mode] : [...MODES];

  for (const mode of modes) {
    const block = state.modes[mode];
    if (!block) continue;

    for (const event of block.events ?? []) {
      const parsed: Result<DoseEvent> = parseMedicationInput(
        {
          id: event?.id,
          route: event?.route,
          ester: event?.ester,
          dose_mg: event?.doseMG,
          at: (event?.timeH ?? 0) * HOUR,
          extras: event?.extras,
        },
        randomUUID(),
      );
      if (!parsed.ok) {
        summary.eventsRejected.push({ id: String(event?.id ?? '(no id)'), reason: parsed.error });
        continue;
      }

      // The incoming stamp travels onto the stored record. Without this the
      // stored record keeps an older stamp than the payload that produced it, so
      // every subsequent sync would read it as stale and update it again forever.
      const incomingUpdatedAt = numericStamp(event?.updatedAt);
      const value: DoseEvent = incomingUpdatedAt
        ? { ...parsed.value, updatedAt: incomingUpdatedAt }
        : parsed.value;

      const existing = await medications.get(ctx.userId, value.id, ctx.dek).catch(() => null);
      if (!existing) {
        const created = await medications.create(ctx.userId, value, ctx.dek, { resurrect });
        if (!created) {
          // Declined: the server still holds this id as deleted, and a sync must
          // not undo that. Counted as skipped, which is what it is.
          summary.eventsSkipped++;
          continue;
        }
        summary.eventsImported++;
        continue;
      }
      if (opts.updateExisting && isNewer(incomingUpdatedAt, existing.value.updatedAt)) {
        await medications.update(ctx.userId, value, existing.version, ctx.dek);
        summary.eventsUpdated++;
        continue;
      }
      summary.eventsSkipped++;
    }

    for (const lab of block.labResults ?? []) {
      const parsed: Result<LabResult> = parseLabInput(
        { id: lab?.id, value: lab?.concValue, unit: lab?.unit, at: (lab?.timeH ?? 0) * HOUR },
        randomUUID(),
      );
      if (!parsed.ok) {
        summary.labsRejected.push({ id: String(lab?.id ?? '(no id)'), reason: parsed.error });
        continue;
      }

      const incomingUpdatedAt = numericStamp(lab?.updatedAt);
      const value: LabResult = incomingUpdatedAt
        ? { ...parsed.value, updatedAt: incomingUpdatedAt }
        : parsed.value;

      const existing = await labs.get(ctx.userId, value.id, ctx.dek).catch(() => null);
      if (!existing) {
        const created = await labs.create(ctx.userId, value, ctx.dek, { resurrect });
        if (!created) {
          summary.labsSkipped++;
          continue;
        }
        summary.labsImported++;
        continue;
      }
      if (opts.updateExisting && isNewer(incomingUpdatedAt, existing.value.updatedAt)) {
        await labs.update(ctx.userId, value, existing.version, ctx.dek);
        summary.labsUpdated++;
        continue;
      }
      summary.labsSkipped++;
    }
  }

  // Weight comes out of `state` rather than being dug out of the raw payload: the
  // app's own reader already found it, including which export version it came
  // from. Weight is required for any simulation, so carrying it over is the
  // difference between an import that works and one the user has to finish by hand.
  if (typeof state.weight === 'number') {
    const parsed: Result<number> = parseBodyWeight(state.weight);
    if (parsed.ok) {
      await settings.upsert(ctx.userId, { bodyWeightKg: parsed.value, hrtMode: summary.mode });
      summary.weight = parsed.value;
    }
  }

  // App-only collections ride along verbatim; they are not clinical records and
  // nothing validates them, but losing them on a sync would be silent data loss.
  const appState = (payload as { appState?: Record<string, unknown> } | undefined)?.appState;
  if (appState && typeof appState === 'object') {
    await settings.upsert(ctx.userId, { appState });
  }

  return summary;
}

/** A finite numeric stamp, or undefined for anything else. */
function numericStamp(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** Whether an incoming record is strictly newer than what is stored. */
function isNewer(incoming: unknown, existing: unknown): boolean {
  // An unstamped record loses to a stamped one, matching the app's merge rule.
  // Both unstamped (legacy records) stays a no-op rather than a coin flip.
  if (typeof incoming !== 'number' || !Number.isFinite(incoming)) return false;
  if (typeof existing !== 'number' || !Number.isFinite(existing)) return true;
  return incoming > existing;
}

/**
 * Import an export file into an account.
 *
 * Idempotent by id: re-running it updates nothing and creates no duplicates,
 * because a user retrying an import they were not sure completed is the normal
 * case rather than the exception.
 */
export async function importExportFile(
  ctx: AuthContext,
  filePath: string,
  opts: { password?: string; mode?: Mode; updateExisting?: boolean } = {},
): Promise<ImportSummary> {
  const raw = await readFile(filePath, 'utf8');
  // A file import is an explicit user action — "here is my record" — so it is
  // allowed to revive a deleted one. `opts` can still override.
  return await importPayload(ctx, await unwrap(raw, opts.password), { resurrect: true, ...opts });
}

/**
 * Build a payload in the app's own export shape.
 *
 * Deleted records are reported as tombstones so a delete propagates instead of
 * being read as "the other side added it". `content` is the subset the app
 * should treat as authoritative — the app merges against it with the same
 * `mergeSyncStates` it already uses for cloud sync.
 */
export async function buildExportPayload(ctx: AuthContext): Promise<{
  version: number;
  weight?: number;
  modes: Record<Mode, {
    events: DoseEvent[];
    labResults: LabResult[];
    doseTemplates: unknown[];
    quickDoses: unknown[];
    deletions: { events: Record<string, number>; labResults: Record<string, number>; doseTemplates: Record<string, number> };
  }>;
  appState: Record<string, unknown> | null;
}> {
  const [eventRows, labRows, deletedEvents, deletedLabs, userSettings] = await Promise.all([
    medications.list(ctx.userId, ctx.dek, { limit: 2000 }),
    labs.list(ctx.userId, ctx.dek, { limit: 2000 }),
    medications.deleted(ctx.userId),
    labs.deleted(ctx.userId),
    settings.get(ctx.userId),
  ]);

  const modeFor = (m: Mode) => ({
    events: [] as DoseEvent[],
    labResults: [] as LabResult[],
    doseTemplates: [] as unknown[],
    quickDoses: [] as unknown[],
    deletions: {
      events: {} as Record<string, number>,
      labResults: {} as Record<string, number>,
      doseTemplates: {} as Record<string, number>,
    },
  });

  const modes: Record<Mode, ReturnType<typeof modeFor>> = {
    transfem: modeFor('transfem'),
    transmasc: modeFor('transmasc'),
  };

  // Testosterone esters and testosterone-unit labs belong to the transmasc side,
  // which is the same routing the app's own reader applies to a flat payload.
  for (const row of eventRows) {
    const target = modes[isTestosteroneEster(row.value.ester) ? 'transmasc' : 'transfem'];
    target.events.push(row.value);
  }
  for (const row of labRows) {
    const target = modes[isT_LabUnit(row.value.unit) ? 'transmasc' : 'transfem'];
    target.labResults.push(row.value);
  }
  for (const d of deletedEvents) {
    // The mode cannot be recovered from a soft-deleted row without decrypting it,
    // so the tombstone is recorded on both sides. Deleting an id that the other
    // side never had is a harmless no-op, and it is better than a delete that
    // fails to propagate to the mode it actually belonged to.
    for (const mode of MODES) modes[mode].deletions.events[d.id] = d.deletedAt;
  }
  for (const d of deletedLabs) {
    for (const mode of MODES) modes[mode].deletions.labResults[d.id] = d.deletedAt;
  }

  // Templates and quick doses are stored as one opaque blob per mode.
  const appState = (userSettings?.appState ?? null) as { modes?: Record<string, { doseTemplates?: unknown[]; quickDoses?: unknown[] }> } | null;
  if (appState?.modes) {
    for (const mode of MODES) {
      const block = appState.modes[mode];
      if (!block) continue;
      if (Array.isArray(block.doseTemplates)) modes[mode].doseTemplates = block.doseTemplates;
      if (Array.isArray(block.quickDoses)) modes[mode].quickDoses = block.quickDoses;
    }
  }

  return {
    version: 2,
    ...(userSettings?.bodyWeightKg != null ? { weight: userSettings.bodyWeightKg } : {}),
    modes,
    appState,
  };
}

/** Counts per table for an account, for verifying an import or sync landed. */
export async function accountRecordCounts(userId: string): Promise<{ doses: number; labs: number }> {
  const { rows } = await getPool().query<{ doses: string; labs: string }>(
    `SELECT
       (SELECT count(*) FROM medication_events WHERE user_id = $1 AND deleted_at IS NULL) AS doses,
       (SELECT count(*) FROM lab_results      WHERE user_id = $1 AND deleted_at IS NULL) AS labs`,
    [userId],
  );
  return { doses: Number(rows[0].doses), labs: Number(rows[0].labs) };
}
