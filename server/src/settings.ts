/**
 * Per-user simulation settings.
 *
 * These are not records: nothing clinical lives here, and every field is either a
 * number the PK model needs (weight, PK overrides) or a preference the app keeps.
 * They live in their own table rather than in the encrypted record store because
 * the server has to *read* them — a prediction needs the body weight — and a
 * setting the server cannot open is one it cannot use.
 *
 * `app_state` is the one opaque value: dose templates, quick doses and the app's own
 * preferences ride in it verbatim. Nothing here validates or interprets it, which is
 * what lets the web app evolve its own collection shapes without a server release.
 */
import { getPool } from './db.ts';
import { isPlausibleBodyWeightKG } from './engine.ts';

export interface UserSettings {
  bodyWeightKg: number | null;
  hrtMode: 'transfem' | 'transmasc';
  calibrationMethod: string;
  calibrationHistory: string;
  pkParams: Record<string, number> | null;
  timezone: string | null;
  /** App-only collections (dose templates, quick doses) carried verbatim. */
  appState: Record<string, unknown> | null;
}

export const settings = {
  async get(userId: string): Promise<UserSettings | null> {
    const { rows } = await getPool().query(
      `SELECT body_weight_kg, hrt_mode, calibration_method, calibration_history,
              pk_params, timezone, app_state
         FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      // `numeric` comes back as a string from pg to avoid float precision loss.
      bodyWeightKg: row.body_weight_kg === null ? null : Number(row.body_weight_kg),
      hrtMode: row.hrt_mode,
      calibrationMethod: row.calibration_method,
      calibrationHistory: row.calibration_history,
      pkParams: row.pk_params,
      timezone: row.timezone,
      appState: row.app_state,
    };
  },

  async upsert(userId: string, patch: Partial<UserSettings>): Promise<UserSettings> {
    const { rows } = await getPool().query(
      `INSERT INTO user_settings AS s (user_id, body_weight_kg, body_weight_updated_at,
                                       hrt_mode, calibration_method, calibration_history,
                                       pk_params, timezone, app_state, updated_at)
       VALUES ($1, $2, CASE WHEN $2::numeric IS NULL THEN NULL ELSE now() END,
               COALESCE($3,'transfem'), COALESCE($4,'mipd'), COALESCE($5,'retrospective'),
               $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET
         body_weight_kg         = COALESCE(EXCLUDED.body_weight_kg, s.body_weight_kg),
         body_weight_updated_at = CASE WHEN EXCLUDED.body_weight_kg IS NOT NULL
                                       THEN now() ELSE s.body_weight_updated_at END,
         hrt_mode               = COALESCE(EXCLUDED.hrt_mode, s.hrt_mode),
         calibration_method     = COALESCE(EXCLUDED.calibration_method, s.calibration_method),
         calibration_history    = COALESCE(EXCLUDED.calibration_history, s.calibration_history),
         pk_params              = COALESCE(EXCLUDED.pk_params, s.pk_params),
         timezone               = COALESCE(EXCLUDED.timezone, s.timezone),
         app_state              = COALESCE(EXCLUDED.app_state, s.app_state),
         updated_at             = now()
       RETURNING body_weight_kg, hrt_mode, calibration_method, calibration_history,
                 pk_params, timezone, app_state`,
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
      hrtMode: row.hrt_mode,
      calibrationMethod: row.calibration_method,
      calibrationHistory: row.calibration_history,
      pkParams: row.pk_params,
      timezone: row.timezone,
      appState: row.app_state,
    };
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
};
