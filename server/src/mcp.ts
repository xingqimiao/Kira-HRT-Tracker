/**
 * MCP adapter — the Agent interface.
 *
 * This file is a shell. It resolves a credential into an `AuthContext` and calls
 * the same Application Core the web API calls. If a tool here ever needs to know
 * how a dose is validated, or how a curve is computed, that logic belongs in
 * `core.ts` and both interfaces should share it — a second implementation of a
 * booking rule is exactly the duplication this architecture exists to prevent.
 *
 * Two things this layer does owe the caller, which are adapter concerns rather
 * than business rules:
 *
 *   - **Tool descriptions carry the safety framing.** An LLM reaches these
 *     functions without a UI around them, so the "this is an estimate, not a
 *     measurement, and not dosing advice" caveat has to live where the model will
 *     actually read it.
 *   - **Errors are returned as tool results, not thrown.** A thrown error becomes
 *     a protocol failure the model cannot act on; a validation message it can
 *     read is one it can correct.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  AccountService,
  MedicationService,
  LabService,
  TimelineService,
  PKSimulationService,
} from './core.ts';
import type { AuthContext } from './types.ts';

import { buildExportPayload } from './import.ts';
import { ShareService } from './shares.ts';
import { SL_TIER_ORDER, GEL_SITE_ORDER, PK_PARAM_RANGES } from './engine.ts';

/** How an adapter obtains the caller's identity and key. */
export type ContextResolver = () => Promise<AuthContext | null>;

const NOT_UNLOCKED =
  'This account is locked. Ask the user to unlock it at the web UI (they enter their ' +
  'password there); the server holds no key at rest, so no agent can open it for them.';

/** Wrap a tool body so failures arrive as readable results instead of protocol errors. */
function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const SAFETY_NOTE =
  'This is a pharmacokinetic estimate from a population model, not a laboratory measurement. ' +
  'It is informational only and must not be used to decide a dose. Report it as an estimate, ' +
  'and direct any dosing question to the user\'s prescriber.';

export function buildServer(resolveContext: ContextResolver): McpServer {
  const server = new McpServer(
    { name: 'hrt-tracker', version: '0.1.0' },
    {
      instructions:
        'Tools for a personal HRT record: logged doses, lab results, and modelled hormone levels. ' +
        `${SAFETY_NOTE} ` +
        'Accounts are end-to-end keyed; if a tool reports the account is locked, the user must unlock ' +
        'it in the web UI before record tools will work.',
    },
  );

  // Every record tool starts by resolving the key. Centralised so no tool can
  // forget and silently act on a locked account.
  async function withContext<T>(
    fn: (ctx: AuthContext) => Promise<T>,
  ): Promise<{ value: T } | { error: string }> {
    const ctx = await resolveContext();
    if (!ctx) return { error: NOT_UNLOCKED };
    return { value: await fn(ctx) };
  }

  // --- Reads ---------------------------------------------------------------

  server.registerTool(
    'hrt_get_timeline',
    {
      title: 'Get HRT timeline',
      description:
        'Recent activity newest-first: logged doses and lab results merged into one stream. ' +
        'Start here to see what a user has been taking.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Maximum entries (default 100)'),
      },
    },
    async ({ limit }) => {
      const r = await withContext((ctx) => TimelineService.get(ctx, { limit }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.map((e) =>
          e.kind === 'dose'
            ? { kind: 'dose', at: e.at, route: e.event.route, ester: e.event.ester, dose_mg: e.event.doseMG, id: e.id }
            : { kind: 'lab', at: e.at, value: e.lab.concValue, unit: e.lab.unit, id: e.id },
        ),
      );
    },
  );

  server.registerTool(
    'hrt_list_medications',
    {
      title: 'List logged doses',
      description: 'Doses the user has logged, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(2000).optional() },
    },
    async ({ limit }) => {
      const r = await withContext((ctx) => MedicationService.list(ctx, { limit }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.map((rec) => ({
          id: rec.value.id,
          at: new Date(rec.value.timeH * 3_600_000).toISOString(),
          route: rec.value.route,
          ester: rec.value.ester,
          dose_mg: rec.value.doseMG,
          extras: rec.value.extras,
          version: rec.version,
        })),
      );
    },
  );

  server.registerTool(
    'hrt_list_labs',
    {
      title: 'List lab results',
      description: 'Blood test results the user has recorded, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(2000).optional() },
    },
    async ({ limit }) => {
      const r = await withContext((ctx) => LabService.list(ctx, { limit }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.map((rec) => ({
          id: rec.value.id,
          at: new Date(rec.value.timeH * 3_600_000).toISOString(),
          value: rec.value.concValue,
          unit: rec.value.unit,
          version: rec.version,
        })),
      );
    },
  );

  server.registerTool(
    'hrt_predict_levels',
    {
      title: 'Predict hormone levels',
      description:
        'Model the user\'s hormone levels from their logged doses, optionally calibrated against ' +
        'their own lab results. Returns a downsampled curve plus peak/trough/current values. ' +
        SAFETY_NOTE,
      inputSchema: {
        analyte: z.enum(['e2', 't']).optional().describe('Estradiol (default) or testosterone'),
        from_days: z.number().int().min(1).max(3650).optional().describe('How far back to show (default 90)'),
        to_days: z.number().int().min(0).max(365).optional().describe('How far ahead to show (default 14)'),
        points: z.number().int().min(10).max(1000).optional().describe('Max curve points (default 200)'),
        with_calibration: z.boolean().optional().describe('Use lab results to personalise the curve (default true)'),
      },
    },
    async ({ analyte, from_days, to_days, points, with_calibration }) => {
      const r = await withContext((ctx) =>
        PKSimulationService.predict(ctx, {
          analyte,
          fromDays: from_days,
          toDays: to_days,
          points,
          withCalibration: with_calibration,
        }),
      );
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      return toolResult(r.value.value);
    },
  );

  server.registerTool(
    'hrt_check_advisories',
    {
      title: 'Check dose and level advisories',
      description:
        'Flags logged doses that run above usual ranges, and lab combinations worth a second look. ' +
        'Rule-based, non-diagnostic heads-up — not medical advice.',
      inputSchema: {},
    },
    async () => {
      const r = await withContext((ctx) => PKSimulationService.advisories(ctx));
      if ('error' in r) return toolError(r.error);
      return toolResult(r.value);
    },
  );

  server.registerTool(
    'hrt_get_settings',
    {
      title: 'Get simulation settings',
      description: 'Body weight, HRT mode, and the PK/calibration settings the model runs under.',
      inputSchema: {},
    },
    async () => {
      const r = await withContext((ctx) => AccountService.getSettings(ctx));
      if ('error' in r) return toolError(r.error);
      return toolResult(r.value);
    },
  );

  // --- Writes --------------------------------------------------------------

  server.registerTool(
    'hrt_add_medication',
    {
      title: 'Log a dose',
      description:
        'Record a dose the user has taken. Use the same ester and route names as hrt_list_medications. ' +
        'For a patch removal, use route "patchRemove" and omit dose_mg. ' +
        'Only call this when the user has actually told you they took the dose — never infer it.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_.:-]+$/)
          .optional()
          .describe('Opaque record id. Omit to have one generated; only set it to replay a known id.'),
        route: z.enum(['injection', 'oral', 'sublingual', 'gel', 'patchApply', 'patchRemove']),
        ester: z
          .enum(['E2', 'EB', 'EV', 'EC', 'EN', 'EU', 'CPA', 'T', 'TC', 'TE', 'TU'])
          .describe('Estradiol esters: EB/EV/EC/EN/EU; E2 = unesterified; CPA = cyproterone; T esters: TC/TE/TU'),
        dose_mg: z.number().positive().max(10000).optional().describe('Dose in mg; omit only for patchRemove'),
        at: z.string().describe('When it was taken, ISO 8601 (e.g. 2026-09-16T08:00:00Z)'),
        extras: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            `Route-specific numbers. sublingualTier: 0–${SL_TIER_ORDER.length - 1} (${SL_TIER_ORDER.join('/')}); ` +
              `gelSite: 0–${GEL_SITE_ORDER.length - 1} (${GEL_SITE_ORDER.join('/')}); ` +
              'concentrationMGmL and areaCM2 for gel; releaseRateUGPerDay for patches; patchWearH for planned wear hours',
          ),
      },
    },
    async (input) => {
      const r = await withContext((ctx) => MedicationService.add(ctx, input));
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      const rec = r.value.value;
      return toolResult({
        id: rec.value.id,
        at: new Date(rec.value.timeH * 3_600_000).toISOString(),
        route: rec.value.route,
        ester: rec.value.ester,
        dose_mg: rec.value.doseMG,
        version: rec.version,
      });
    },
  );

  server.registerTool(
    'hrt_add_lab_result',
    {
      title: 'Record a lab result',
      description:
        'Save a blood test result. Units: pg/ml or pmol/l for estradiol, ng/dl or nmol/l for ' +
        'testosterone. Only record values the user gives you; never invent or convert a result.',
      inputSchema: {
        id: z.string().min(1).max(200).optional().describe('Opaque record id; omit to have one generated'),
        value: z.number().positive().max(20000),
        unit: z.enum(['pg/ml', 'pmol/l', 'ng/dl', 'nmol/l']),
        at: z.string().describe('When the sample was drawn, ISO 8601'),
      },
    },
    async (input) => {
      const r = await withContext((ctx) => LabService.add(ctx, input));
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      const rec = r.value.value;
      return toolResult({
        id: rec.value.id,
        at: new Date(rec.value.timeH * 3_600_000).toISOString(),
        value: rec.value.concValue,
        unit: rec.value.unit,
        version: rec.version,
      });
    },
  );

  server.registerTool(
    'hrt_update_settings',
    {
      title: 'Update simulation settings',
      description:
        'Change body weight, HRT mode, or calibration method. PK parameter overrides are advanced — ' +
        'only set them if the user explicitly asks, and never guess a value.',
      inputSchema: {
        body_weight_kg: z.number().min(20).max(400).optional(),
        hrt_mode: z.enum(['transfem', 'transmasc']).optional(),
        calibration_method: z.enum(['off', 'ekf', 'ou_kalman', 'mipd']).optional(),
        calibration_history: z.enum(['forward', 'retrospective']).optional(),
        timezone: z.string().max(64).optional(),
        pk_params: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            'Advanced overrides. Rejected (not clamped) if out of range. Valid keys: ' +
              Object.keys(PK_PARAM_RANGES).join(', '),
          ),
      },
    },
    async (patch) => {
      const r = await withContext((ctx) => AccountService.updateSettings(ctx, patch));
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      return toolResult(r.value.value);
    },
  );

  server.registerTool(
    'hrt_delete_record',
    {
      title: 'Delete a record',
      description:
        'Remove a dose or lab result the user asks you to delete. Confirm with the user first — ' +
        'this is not reversible from the agent interface.',
      inputSchema: {
        kind: z.enum(['dose', 'lab']),
        id: z.string().describe('Record id from a list tool'),
      },
    },
    async ({ kind, id }) => {
      const r = await withContext((ctx) =>
        kind === 'dose' ? MedicationService.remove(ctx, id) : LabService.remove(ctx, id),
      );
      if ('error' in r) return toolError(r.error);
      return toolResult({ deleted: r.value, kind, id });
    },
  );

  server.registerTool(
    'hrt_sync_state',
    {
      title: 'Read full record state',
      description:
        "The account's complete records in the web app's own export shape, including " +
        'deletions. Use this when you need everything at once rather than one collection.',
      inputSchema: {},
    },
    async () => {
      const r = await withContext((ctx) => buildExportPayload(ctx));
      if ('error' in r) return toolError(r.error);
      return toolResult(r.value);
    },
  );

  // --- Reference -----------------------------------------------------------

  server.registerTool(
    'hrt_reference',
    {
      title: 'HRT model reference',
      description:
        'Static reference: available esters, routes, sublingual tiers, gel sites, and the PK ' +
        'parameter ranges. Use this instead of guessing valid values.',
      inputSchema: {},
    },
    async () =>
      toolResult({
        routes: ['injection', 'oral', 'sublingual', 'gel', 'patchApply', 'patchRemove'],
        esters: {
          estradiol: { E2: 'unesterified', EB: 'benzoate', EV: 'valerate', EC: 'cypionate', EN: 'enanthate', EU: 'undecylate' },
          antiandrogen: { CPA: 'cyproterone acetate' },
          testosterone: { T: 'unesterified', TC: 'cypionate', TE: 'enanthate', TU: 'undecanoate' },
        },
        sublingual_tiers: SL_TIER_ORDER,
        gel_sites: GEL_SITE_ORDER,
        pk_param_ranges: PK_PARAM_RANGES,
        analyte_units: { e2: ['pg/ml', 'pmol/l'], t: ['ng/dl', 'nmol/l'] },
        safety: SAFETY_NOTE,
      }),
  );

  // --- Shares --------------------------------------------------------------
  //
  // The one pair of tools that publishes data outside the account. `hrt_create_share`
  // is the only call in this server whose effect is visible to someone who is not the
  // user, which is why its description leads with that rather than with the arguments.

  server.registerTool(
    'hrt_create_share',
    {
      title: 'Create a share link',
      description:
        'Publish a read-only link to the user\'s dose history and modelled curve. Anyone with '
        + 'the URL can read it until it expires, so confirm with the user before calling this. '
        + 'Lab results, body weight and profile details are never included — the server refuses '
        + 'a payload carrying them. The URL is returned once and cannot be retrieved again.',
      inputSchema: {
        password: z.string().min(8).optional()
          .describe('Require this password to open the link. Omit for a link anyone can read.'),
        expires_in_hours: z.number().positive().max(2160).optional()
          .describe('How long the link lives, in hours (default 24, maximum 2160 = 90 days)'),
        live: z.boolean().optional()
          .describe('Keep the snapshot current as records change. Default false: a frozen link.'),
        limit: z.number().int().min(1).max(500).optional()
          .describe('How many recent doses to include (default 100)'),
      },
    },
    async ({ password, expires_in_hours, live, limit }) => {
      const r = await withContext(async (ctx) => {
        const events = await TimelineService.get(ctx, { limit: limit ?? 100 });
        // Only doses. A share is a dosage record by design; the exclusion list on the
        // server is the real guarantee, and this avoids constructing what it would refuse.
        const doses = events
          .filter((e) => e.kind === 'dose')
          .map((e) => ({
            id: e.id,
            ester: (e as { event: { ester: unknown } }).event.ester,
            route: (e as { event: { route: unknown } }).event.route,
            doseMG: (e as { event: { doseMG: unknown } }).event.doseMG,
            at: e.at,
          }));

        return await ShareService.create(ctx.userId, {
          snapshot: {
            version: 1,
            mode: (ctx as { mode?: unknown }).mode ?? 'transfem',
            timezone: 'UTC',
            createdAt: Date.now(),
            events: doses,
            simulation: null,
          },
          password,
          expiresAt: Date.now() + (expires_in_hours ?? 24) * 3_600_000,
          live: live ?? false,
        });
      });
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      return toolResult({
        url: r.value.value.url,
        expires_at: new Date(r.value.value.expiresAt).toISOString(),
        password_required: r.value.value.passwordRequired,
        live: r.value.value.live,
        included: 'dose history and the modelled curve',
        not_included: 'lab results, body weight, account details',
        note: 'The URL is shown once. It cannot be retrieved again — only revoked.',
      });
    },
  );

  server.registerTool(
    'hrt_list_shares',
    {
      title: 'List active share links',
      description:
        'What the user currently has published, including whether each link has expired. '
        + 'Check this before creating another, and to get the id for hrt_revoke_share.',
      inputSchema: {},
    },
    async () => {
      const r = await withContext((ctx) => ShareService.list(ctx.userId));
      if ('error' in r) return toolError(r.error);
      return toolResult(r.value.map((share) => ({
        id: share.id,
        created_at: new Date(share.createdAt).toISOString(),
        expires_at: new Date(share.expiresAt).toISOString(),
        expired: share.expired,
        password_required: share.passwordRequired,
        live: share.live,
      })));
    },
  );

  server.registerTool(
    'hrt_revoke_share',
    {
      title: 'Revoke a share link',
      description:
        'Delete a share so its URL stops working immediately. Takes the id from '
        + 'hrt_list_shares — the token itself is never stored and cannot be passed here.',
      inputSchema: {
        id: z.string().uuid().describe('The share id, from hrt_list_shares'),
      },
    },
    async ({ id }) => {
      const r = await withContext((ctx) => ShareService.revoke(ctx.userId, id));
      if ('error' in r) return toolError(r.error);
      if (!r.value) return toolError('no share with that id on this account');
      return toolResult({ revoked: true, id });
    },
  );

  return server;
}

/**
 * Resolve a bearer credential into an `AuthContext`.
 *
 * Two credential shapes, deliberately distinct:
 *   - `hrt_…` — a durable token minted for an agent. Proves identity; how it reaches
 *     the key depends on the account's privacy mode (standard: the server key is
 *     enough; advanced: a live unlock is still required, because no server key exists).
 *   - `ks_…`  — a live unlock token from the web UI. Carries the key directly.
 *
 * Both are delegated to `AccountService.resolveApiContext`, which is the same
 * resolver the HTTP layer uses. Enforcing the mode rule in the service rather than
 * here is what keeps an MCP tool and its REST twin from diverging on it.
 *
 * A durable token that resolves to null makes the tool say "unlock first" rather
 * than reporting a confusing authentication error.
 */
export function makeBearerResolver(getToken: () => string | undefined): ContextResolver {
  return async () => {
    const token = getToken();
    if (!token) return null;
    return await AccountService.resolveApiContext(token);
  };
}
