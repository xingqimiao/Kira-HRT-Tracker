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
      `INSERT INTO user_settings AS s (user_id, body_weight_kg, hrt_mode, calibration_method,
                                       calibration_history, pk_params, timezone, app_state, updated_at)
       VALUES ($1, $2, COALESCE($3,'transfem'), COALESCE($4,'mipd'), COALESCE($5,'retrospective'),
               $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET
         body_weight_kg      = COALESCE(EXCLUDED.body_weight_kg, s.body_weight_kg),
         hrt_mode            = COALESCE(EXCLUDED.hrt_mode, s.hrt_mode),
         calibration_method  = COALESCE(EXCLUDED.calibration_method, s.calibration_method),
         calibration_history = COALESCE(EXCLUDED.calibration_history, s.calibration_history),
         pk_params           = COALESCE(EXCLUDED.pk_params, s.pk_params),
         timezone            = COALESCE(EXCLUDED.timezone, s.timezone),
         app_state           = COALESCE(EXCLUDED.app_state, s.app_state),
         updated_at          = now()
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
};
