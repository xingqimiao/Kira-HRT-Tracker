/**
 * Per-user simulation settings.
 *
 * These are not records: nothing clinical lives here, and every field is either a
 * number the PK model needs (weight, PK overrides) or a preference the app keeps.
 * They live in their own table rather than in the encrypted record store because
 * the server has to *read* them — a prediction needs the body weight — and a
 * setting the server cannot open is one it cannot use.
 *
 * ── One list, both directions ────────────────────────────────────────────────
 *
 * Every setting-class scalar the record path carries is named once in
 * `SETTINGS_SCALARS` below, together with how to fold it into this table when a
 * device writes it and how to put it back into the app's payload when anything
 * reads it. The record path used to name those scalars in three unrelated places
 * (`payloadToRecords`, `recordsToPayload`, `buildExportPayload`), so a field
 * could be added to the write half alone and nothing failed — which is exactly how
 * the app-only settings spent months travelling under one name and being read
 * under another. Adding a field to `UserSettings` without giving it a home in
 * that list is now a compile error.
 *
 * The model columns (`hrt_mode`, `calibration_method`, `calibration_history`,
 * `timezone`) are not scalars of their own: they are the app's own settings bag
 * seen a second way, and `APP_SETTING_BY_COLUMN` is the only place the two names
 * meet. The bag travels as `scalar:appSettings`; the columns exist so the PK model
 * can read them without opening a blob.
 *
 * `app_state` is otherwise the one opaque value: dose templates, quick doses and
 * the app's own preferences ride in it verbatim. Nothing here validates or
 * interprets it, which is what lets the web app evolve its own collection shapes
 * without a server release.
 */
import { getPool } from './db.ts';
import { RecordService } from './records.ts';
import { CALIBRATION_METHODS, isPlausibleBodyWeightKG } from './engine.ts';
import type { AuthContext } from './types.ts';

export interface UserSettings {
  bodyWeightKg: number | null;
  /** When `bodyWeightKg` was last written, by whichever side wrote it. */
  bodyWeightUpdatedAt: number | null;
  hrtMode: 'transfem' | 'transmasc';
  calibrationMethod: string;
  calibrationHistory: string;
  /** `null` = explicitly "no overrides". */
  pkParams: Record<string, number> | null;
  /** When `pkParams` was last written, by whichever side wrote it. */
  pkParamsUpdatedAt: number | null;
  timezone: string | null;
  /** App-only collections (dose templates, quick doses) carried verbatim. */
  appState: Record<string, unknown> | null;
}

/** A timestamptz column as the epoch milliseconds the app's stamps use. */
function ms(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(at) ? at : null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** One model setting: the app's key for it, and whether the model can accept it. */
interface ModelSetting {
  /** The key the app's own settings bag uses. */
  readonly appKey: string;
  /** The value as the column can hold it, or null when the bag's value is not usable. */
  readonly accept: (value: unknown) => string | null;
}

/**
 * The app's own name for each model setting it edits, and the value the column can
 * hold.
 *
 * The column and the app's key are the same preference under two names, and this is
 * the only place the pairing lives. Both directions are driven by it: `accept` turns
 * a bag synced from a device into the columns (the CHECK constraints make that
 * validation rather than a formality — a bag is opaque input from a browser), and
 * the settings route reads the same map to put its columns into the bag.
 */
export const APP_SETTING_BY_COLUMN = {
  hrtMode: {
    appKey: 'hrtMode',
    accept: (value: unknown) => (value === 'transfem' || value === 'transmasc' ? value : null),
  },
  calibrationMethod: {
    appKey: 'calMethod',
    accept: (value: unknown) => (typeof value === 'string'
      && (CALIBRATION_METHODS as readonly string[]).includes(value) ? value : null),
  },
  calibrationHistory: {
    appKey: 'calHistoryMode',
    accept: (value: unknown) => (value === 'forward' || value === 'retrospective' ? value : null),
  },
  timezone: {
    appKey: 'timezone',
    accept: (value: unknown) => (typeof value === 'string' && value.length > 0 && value.length <= 64
      ? value : null),
  },
} as const satisfies Partial<Record<keyof UserSettings, ModelSetting>>;

/**
 * The settings keys that may sit in `user_settings.app_state` in the clear.
 *
 * `app_state` is a plaintext jsonb column, and the app's settings bag used to be stored
 * in it whole — so a database dump showed the language, the theme, the re-check
 * intervals and, most of all, `hrtStartDate`, the date HRT began. That one is a health
 * fact about the person, it is readable with no key at all, and the server does not read
 * it: it arrived in the clear only because the bag was stored verbatim.
 *
 * So the bag is filtered on the way in. What stays is what a server-side reader actually
 * needs: the four `APP_SETTING_BY_COLUMN` keys, which the estimator projects out of the
 * bag, and `pkEngine`, which `hrt_get_settings` reports so an agent can explain which
 * model drew the curve.
 *
 * Nothing is lost by dropping the rest. The whole bag still travels — sealed — as the
 * `scalar:appSettings` record, and that is the copy the app reads its own preferences
 * from. This column is a server-side projection of it, not the source of truth, which is
 * what makes a whitelist safe here rather than a truncation.
 */
const PLAINTEXT_SETTING_KEYS: readonly string[] = [
  ...Object.values(APP_SETTING_BY_COLUMN).map((spec) => spec.appKey),
  'pkEngine',
];

/** The subset of a settings bag that may be stored unencrypted, or undefined when empty. */
function plaintextBag(bag: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of PLAINTEXT_SETTING_KEYS) {
    if (bag[key] !== undefined) out[key] = bag[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The model columns a settings bag states; absent for each it does not, or cannot. */
function columnsFromBag(appState: Record<string, unknown>): Partial<Record<keyof UserSettings, string>> {
  const bag = jsonObject(appState.settings) ?? {};
  const out: Partial<Record<keyof UserSettings, string>> = {};
  for (const [column, spec] of Object.entries(APP_SETTING_BY_COLUMN) as [keyof UserSettings, ModelSetting][]) {
    const value = spec.accept(bag[spec.appKey]);
    if (value !== null) out[column] = value;
  }
  return out;
}

/**
 * The settings bag as the app reads it: the stored blob, verbatim.
 *
 * The model columns are a projection *of this blob* (see `absorbAppState` and
 * `mergeAppSettings`), not a second copy to fold back in on the way out. Reading
 * them back over the blob was the obvious symmetry and the wrong one: the
 * projection deliberately drops a value the model cannot accept — an app build
 * that wrote `calMethod: 'adaptive'` leaves the column at its default — and
 * overlaying the column would then replace the value the app itself chose with a
 * default it never asked for.
 */
function appStateFor(userSettings: UserSettings | null): Record<string, unknown> | null {
  return jsonObject(userSettings?.appState);
}

export const settings = {
  async get(userId: string): Promise<UserSettings | null> {
    const { rows } = await getPool().query(
      `SELECT body_weight_kg, body_weight_updated_at, hrt_mode, calibration_method,
              calibration_history, pk_params, pk_params_updated_at, timezone, app_state
         FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      // `numeric` comes back as a string from pg to avoid float precision loss.
      bodyWeightKg: row.body_weight_kg === null ? null : Number(row.body_weight_kg),
      bodyWeightUpdatedAt: ms(row.body_weight_updated_at),
      hrtMode: row.hrt_mode,
      calibrationMethod: row.calibration_method,
      calibrationHistory: row.calibration_history,
      pkParams: row.pk_params,
      pkParamsUpdatedAt: ms(row.pk_params_updated_at),
      timezone: row.timezone,
      appState: row.app_state,
    };
  },

  async upsert(userId: string, patch: Partial<UserSettings>): Promise<UserSettings> {
    const { rows } = await getPool().query(
      `INSERT INTO user_settings AS s (user_id, body_weight_kg, body_weight_updated_at,
                                       hrt_mode, calibration_method, calibration_history,
                                       pk_params, pk_params_updated_at, timezone, app_state, updated_at)
       VALUES ($1, $2, CASE WHEN $2::numeric IS NULL THEN NULL ELSE now() END,
               COALESCE($3,'transfem'), COALESCE($4,'mipd'), COALESCE($5,'retrospective'),
               $6, CASE WHEN $6::jsonb IS NULL THEN NULL ELSE now() END, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET
         body_weight_kg         = COALESCE(EXCLUDED.body_weight_kg, s.body_weight_kg),
         body_weight_updated_at = CASE WHEN EXCLUDED.body_weight_kg IS NOT NULL
                                       THEN now() ELSE s.body_weight_updated_at END,
         hrt_mode               = COALESCE(EXCLUDED.hrt_mode, s.hrt_mode),
         calibration_method     = COALESCE(EXCLUDED.calibration_method, s.calibration_method),
         calibration_history    = COALESCE(EXCLUDED.calibration_history, s.calibration_history),
         pk_params              = COALESCE(EXCLUDED.pk_params, s.pk_params),
         pk_params_updated_at   = CASE WHEN EXCLUDED.pk_params IS NOT NULL
                                       THEN now() ELSE s.pk_params_updated_at END,
         timezone               = COALESCE(EXCLUDED.timezone, s.timezone),
         app_state              = COALESCE(EXCLUDED.app_state, s.app_state),
         updated_at             = now()
       RETURNING body_weight_kg, body_weight_updated_at, hrt_mode, calibration_method, calibration_history,
                 pk_params, pk_params_updated_at, timezone, app_state`,
      [
        userId,
        patch.bodyWeightKg ?? null,
        patch.hrtMode ?? null,
        patch.calibrationMethod ?? null,
        patch.calibrationHistory ?? null,
        patch.pkParams ? JSON.stringify(patch.pkParams) : null,
        patch.timezone ?? null,
        patch.appState ? JSON.stringify(patch.appState) : null,
      ],
    );
    const row = rows[0];
    return {
      bodyWeightKg: row.body_weight_kg === null ? null : Number(row.body_weight_kg),
      bodyWeightUpdatedAt: ms(row.body_weight_updated_at),
      hrtMode: row.hrt_mode,
      calibrationMethod: row.calibration_method,
      calibrationHistory: row.calibration_history,
      pkParams: row.pk_params,
      pkParamsUpdatedAt: ms(row.pk_params_updated_at),
      timezone: row.timezone,
      appState: row.app_state,
    };
  },

  /**
   * Fold an app-state blob synced from a device into the setting the app reads back.
   *
   * The record store carries it as `scalar:appSettings` — the counterpart of the
   * `scalar:weight` record — but `hrt_get_settings`, `hrt_sync_state` and
   * `/api/export` read `user_settings.app_state`, so the two have to meet. Nothing
   * wrote it at all after the legacy `/api/sync` import went, which is why an
   * app-only setting changed on one device never appeared in the account.
   *
   * Merged, not replaced: `upsert` assigns `app_state` whole (`COALESCE` on the
   * column, not a merge), so a blob that mentions only `settings` would drop the
   * `modes` collections it never read. `||` merges at the blob's top level, so an
   * unmentioned key — every collection except the one being written — survives. A
   * partial blob cannot erase it.
   *
   * `settings` is merged one level deeper, by the same rule and for the same
   * reason. It is the key an agent's `updateSettings` writes into, so a blob built
   * from a partial settings bag — the shape the merge produces when one side has
   * only ever seen one key — would otherwise replace the whole bag and drop the
   * theme and language it never read.
   *
   * The blob's own settings are also projected onto the model columns
   * (`APP_SETTING_BY_COLUMN`), or the PK model would keep running under the mode
   * the account was created with while the app showed another.
   */
  async absorbAppState(userId: string, appState: unknown): Promise<void> {
    const stored = jsonObject(appState);
    if (!stored) return;
    const columns = columnsFromBag(stored);
    // Filter the bag before it is written, not after: the unlisted preferences are
    // still in the sealed `scalar:appSettings` record, so this column keeps only what a
    // server-side reader needs. `modes` (templates and quick doses) is carried as it
    // arrives — those are read back by the export path.
    const bag: Record<string, unknown> = { ...stored };
    const incoming = jsonObject(stored.settings);
    if (incoming) {
      // The projection merges against what this column already holds, so a write that
      // states no whitelisted key does not erase one. It is a no-op for the filtered-out
      // keys by construction — they were never here — which is what keeps them out.
      const current = await this.get(userId);
      const here = jsonObject(jsonObject(current?.appState)?.settings);
      const kept = plaintextBag({ ...here, ...incoming });
      if (kept) bag.settings = kept;
      else delete bag.settings;
    } else {
      delete bag.settings;
    }
    await getPool().query(
      `INSERT INTO user_settings AS s (user_id, hrt_mode, calibration_method, calibration_history,
                                       timezone, app_state, updated_at)
       VALUES ($1, COALESCE($3::text,'transfem'), COALESCE($4::text,'mipd'),
               COALESCE($5::text,'retrospective'), $6::text, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE
          SET app_state = CASE
                WHEN EXCLUDED.app_state -> 'settings' IS NULL
                  THEN COALESCE(s.app_state, '{}'::jsonb) || EXCLUDED.app_state
                ELSE jsonb_set(
                       COALESCE(s.app_state, '{}'::jsonb) || EXCLUDED.app_state,
                       '{settings}',
                       COALESCE(s.app_state -> 'settings', '{}'::jsonb)
                         || (EXCLUDED.app_state -> 'settings'),
                       true)
              END,
              hrt_mode = COALESCE($3::text, s.hrt_mode),
              calibration_method = COALESCE($4::text, s.calibration_method),
              calibration_history = COALESCE($5::text, s.calibration_history),
              timezone = COALESCE($6::text, s.timezone),
              updated_at = now()`,
      [
        userId,
        JSON.stringify(bag),
        columns.hrtMode ?? null,
        columns.calibrationMethod ?? null,
        columns.calibrationHistory ?? null,
        columns.timezone ?? null,
      ],
    );
  },

  /**
   * Merge the app-facing part of a settings write into the bag the app reads.
   *
   * A settings route or an agent writes the model columns directly; without this
   * the column would be the only copy and the browser — which reads the bag —
   * would never see the change. Merged with `||`, so a write that mentions only
   * the mode cannot drop the theme and language it never read, and the bag's own
   * stamp moves so the app's whole-bag merge adopts it rather than leaving the
   * change on the server.
   */
  async mergeAppSettings(userId: string, patch: Record<string, unknown>, stampMs: number): Promise<void> {
    // Only the keys a server-side reader needs reach the plaintext column; the rest of
    // the patch is already in the sealed record. A patch that is entirely unlisted keys
    // still moves the stamp, so the app's whole-bag merge adopts the change.
    const stored = plaintextBag(patch) ?? {};
    await getPool().query(
      `INSERT INTO user_settings AS s (user_id, app_state, updated_at)
       VALUES ($1, jsonb_build_object('settings', $2::jsonb, 'settingsUpdatedAt', $3::bigint), now())
       ON CONFLICT (user_id) DO UPDATE
          SET app_state = jsonb_set(
                COALESCE(s.app_state, '{}'::jsonb) || jsonb_build_object('settingsUpdatedAt', $3::bigint),
                '{settings}',
                COALESCE(s.app_state -> 'settings', '{}'::jsonb) || $2::jsonb,
                true),
              updated_at = now()`,
      [userId, JSON.stringify(stored), stampMs],
    );
  },

  /**
   * Fold a weight synced from a device into the setting the PK model reads.
   *
   * The app keeps body weight in its own payload and travels it as the `scalar:weight`
   * record; the model reads `user_settings.body_weight_kg` instead. Before this the two
   * only met when `hrt_update_settings` was called, so a device could sync a weight
   * faithfully forever and `hrt_predict_levels` would still refuse for want of one.
   *
   * The payload's own `weightUpdatedAt` decides against `body_weight_updated_at`, not
   * arrival order: an export taken before a weight was typed into the settings screen
   * must not undo it. A missing stamp arrives as 0, which loses to any stamped setting
   * and beats none — so an unstamped device can still fill an account that has none.
   *
   * A value that is absent or implausible is ignored rather than written as null:
   * "this device has no opinion about weight" is not "clear the weight".
   */
  async absorbWeight(userId: string, weightKg: unknown, stampMs: unknown): Promise<void> {
    if (typeof weightKg !== 'number' || !isPlausibleBodyWeightKG(weightKg)) return;
    const at = typeof stampMs === 'number' && Number.isFinite(stampMs) ? stampMs : 0;
    await getPool().query(
      `INSERT INTO user_settings AS s (user_id, body_weight_kg, body_weight_updated_at, updated_at)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), now())
       ON CONFLICT (user_id) DO UPDATE
          SET body_weight_kg = EXCLUDED.body_weight_kg,
              body_weight_updated_at = EXCLUDED.body_weight_updated_at,
              updated_at = now()
        WHERE s.body_weight_updated_at IS NULL
           OR s.body_weight_updated_at < EXCLUDED.body_weight_updated_at`,
      [userId, weightKg, at],
    );
  },

  /**
   * Fold PK overrides synced from a device into the setting the model reads.
   *
   * The same contract as `absorbWeight`, and the same reason: the app travels
   * `pkParams` as a scalar with its own stamp, while `hrt_predict_levels` reads
   * `user_settings.pk_params`. Before this the two never met, so an override could
   * sync forever and the prediction would still run on the defaults.
   *
   * Unlike weight, `null` is a value rather than an absence: the app emits the
   * record only when it has an opinion, and "clear every override" is that opinion.
   * A record that says nothing at all never reaches here.
   */
  async absorbPKParams(userId: string, value: unknown, stampMs: unknown): Promise<void> {
    if (value === undefined) return;
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) return;
    const at = typeof stampMs === 'number' && Number.isFinite(stampMs) ? stampMs : 0;
    await getPool().query(
      `INSERT INTO user_settings AS s (user_id, pk_params, pk_params_updated_at, updated_at)
       VALUES ($1, $2::jsonb, to_timestamp($3 / 1000.0), now())
       ON CONFLICT (user_id) DO UPDATE
          SET pk_params = EXCLUDED.pk_params,
              pk_params_updated_at = EXCLUDED.pk_params_updated_at,
              updated_at = now()
        WHERE s.pk_params_updated_at IS NULL
           OR s.pk_params_updated_at < EXCLUDED.pk_params_updated_at`,
      [userId, value === null ? null : JSON.stringify(value), at],
    );
  },
};

/** One settings-class scalar, and both halves of the record path's treatment of it. */
export interface SettingsScalar {
  /** The `UserSettings` field this scalar is. */
  readonly key: keyof UserSettings;
  /** The record id the app travels it as. */
  readonly recordId: string;
  /** Other `UserSettings` fields this scalar carries (its stamp, or its bag keys). */
  readonly carries: readonly (keyof UserSettings)[];
  /** Fold one record body into the settings row. */
  readonly absorb: (userId: string, value: unknown, stamp: number) => Promise<void>;
  /** Put the stored value into the app payload's scalar fields. */
  readonly emit: (settings: UserSettings, out: Record<string, unknown>) => void;
}

/**
 * Every setting-class scalar the record path carries, in one list.
 *
 * `absorb` is the write half (record → settings row); `emit` is the read half
 * (settings row → the app's payload). Both halves iterate this list, so a scalar
 * cannot be added to one and forgotten in the other. The compile-time assertion
 * below closes the remaining hole: a new field on `UserSettings` either appears
 * here or in `APP_SETTING_BY_COLUMN`, or the build fails.
 */
export const SETTINGS_SCALARS = [
  {
    key: 'bodyWeightKg',
    recordId: 'scalar:weight',
    carries: ['bodyWeightUpdatedAt'],
    absorb: (userId: string, value: unknown, stamp: number) => settings.absorbWeight(userId, value, stamp),
    emit: (s: UserSettings, out: Record<string, unknown>) => {
      if (s.bodyWeightKg == null) return;
      out.weight = s.bodyWeightKg;
      out.weightUpdatedAt = s.bodyWeightUpdatedAt ?? 0;
    },
  },
  {
    key: 'pkParams',
    recordId: 'scalar:pkParams',
    carries: ['pkParamsUpdatedAt'],
    absorb: (userId: string, value: unknown, stamp: number) => settings.absorbPKParams(userId, value, stamp),
    emit: (s: UserSettings, out: Record<string, unknown>) => {
      // A stamp with no value is an explicit "no overrides" rather than
      // "unstated" — that difference is the whole reason the stamp exists.
      if (s.pkParamsUpdatedAt == null && s.pkParams == null) return;
      out.pkParams = s.pkParams ?? null;
      out.pkParamsUpdatedAt = s.pkParamsUpdatedAt ?? 0;
    },
  },
  {
    key: 'appState',
    recordId: 'scalar:appSettings',
    carries: [],
    absorb: (userId: string, value: unknown) => settings.absorbAppState(userId, value),
    // No `emit`: the bag the app reads is the sealed `scalar:appSettings` record, and
    // reaching it means a record read, which this table cannot do synchronously. The
    // entry stays so the write half and the compile-time coverage assertion below still
    // see the field; `appStateForRead` is the read half.
    emit: () => {},
  },
] as const satisfies readonly SettingsScalar[];

/** The scalar a record id names, or undefined when the record is not one. */
export function settingsScalarFor(recordId: string): SettingsScalar | undefined {
  return SETTINGS_SCALARS.find((scalar) => scalar.recordId === recordId);
}

/**
 * The settings-class scalars in the app payload's own shape.
 *
 * A field is present only when the settings row holds it, so merging the result
 * cannot clear a value the row never had. Shared by `buildExportPayload` and the
 * records read, which is what makes the browser's read carry what an agent wrote.
 */
export function settingsScalars(userSettings: UserSettings | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!userSettings) return out;
  for (const scalar of SETTINGS_SCALARS) scalar.emit(userSettings, out);
  return out;
}

/**
 * The app's settings bag as the app should receive it, or null when the account has none.
 *
 * This is the whole bag — it is the sealed `scalar:appSettings` record, the one copy the
 * app writes and reads its own preferences from. It is deliberately *not*
 * `UserSettings.appState`, which is only a plaintext projection of the bag onto the keys a
 * server-side reader needs: the write half filters `hrtStartDate` and the other
 * preferences out of that column, so emitting the column would drop them from the payload.
 *
 * That drop is not self-limiting. The client resolves the bag as a *whole* on its stamp
 * (`resolveScalar` in `syncMerge.ts`), so an understated bag does not merely arrive
 * incomplete — it wins the stamp comparison and overwrites the other device's complete
 * copy, deleting settings a second device was holding correctly.
 *
 * `fallback` is the settings row's own `app_state`, used only for an account that has
 * never written the record (a pre-`scalar:appSettings` row still holds the unfiltered bag).
 */
export async function appStateForRead(
  ctx: AuthContext,
  fallback: UserSettings | null,
): Promise<Record<string, unknown> | null> {
  const sealed = await RecordService.get(ctx, 'scalar:appSettings').catch(() => null);
  const value = (sealed?.data as { value?: unknown } | null)?.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return appStateFor(fallback);
}

// A settings field with no home above would travel one way only — the bug this
// table exists to make impossible. The type only resolves when the union is empty.
type CarriedSetting =
  | (typeof SETTINGS_SCALARS)[number]['key']
  | (typeof SETTINGS_SCALARS)[number]['carries'][number]
  | keyof typeof APP_SETTING_BY_COLUMN;
type UncarriedSetting = Exclude<keyof UserSettings, CarriedSetting>;
const _everySettingTravels: [UncarriedSetting] extends [never]
  ? true
  : ['settings field is not carried by the record path', UncarriedSetting] = true;
void _everySettingTravels;
