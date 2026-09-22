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
  JournalService,
  TemplateService,
  TimelineService,
  PKSimulationService,
} from './core.ts';
import type { AuthContext, ContextDenial } from './types.ts';

import { buildExportPayload } from './records.ts';
import { ShareService } from './shares.ts';
import {
  SL_TIER_ORDER,
  GEL_SITE_ORDER,
  GEL_PRODUCT_OPTIONS,
  GEL_COVERAGE_OPTIONS,
  GEL_COAPPLICATION_OPTIONS,
  PK_ENGINES,
  DEFAULT_PK_ENGINE,
  PK_PARAM_RANGES,
} from './engine.ts';

/** How an adapter obtains the caller's identity and key. */
export type ContextResolver = () => Promise<AuthContext | ContextDenial | null>;

/**
 * Two different failures, told apart because the fix differs.
 *
 * A request with no credential, or one that no longer resolves to an account, is a
 * client problem: the token has to arrive as `Authorization: Bearer hrt_...`, and
 * telling that caller to sign in at the web UI sends them somewhere that cannot help.
 * `locked` is the other case -- the credential is good and names the account, but the
 * deployment cannot reach that account's key, a state only a password sign-in clears.
 * Reporting both as locked taught clients to retry the wrong thing, which is how it
 * read on a probe that carried no token at all.
 */
const NO_CREDENTIAL =
  'No usable credential. This request carried no hrt_ token, or one that no longer ' +
  'resolves to an account. Send one as `Authorization: Bearer hrt_...`; signing in at ' +
  'the web UI will not fix a missing or revoked token.';

const NOT_UNLOCKED =
  'This account is locked. The credential is valid and identifies the account, but the ' +
  'deployment cannot reach that account\'s key -- SERVER_DEK_KEY is unset, or the ' +
  'account predates the server-side wrapper. Ask the user to sign in once at the web UI ' +
  'with their password, which adds the wrapper.';

/** Wrap a tool body so failures arrive as readable results instead of protocol errors. */
function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/**
 * A paging cursor, converted to the epoch milliseconds the store pages by.
 *
 * `before` is documented as the oldest instant from the page just read, which is what
 * an agent actually holds. The conversion is explicit rather than passed through: the
 * store compares a timestamp, and a string that reached it unparsed would compare as
 * a date in 1970 — the largest page the account has, again and again.
 */
function pagingCursor(
  before: string | undefined,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (before === undefined) return { ok: true, value: undefined };
  const ms = Date.parse(before);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `before: not a valid ISO 8601 timestamp (got ${JSON.stringify(before)})` };
  }
  return { ok: true, value: ms };
}

/**
 * The dose vocabulary, in one place because three tools now accept it.
 *
 * `hrt_add_medication` and `hrt_add_dose_template` take the same route and ester,
 * and `hrt_list_dose_templates` returns them; a second copy of either list is a
 * second thing to forget when an ester is added upstream.
 */
const ROUTE_VALUES = ['injection', 'oral', 'sublingual', 'gel', 'patchApply', 'patchRemove'] as const;
const ESTER_VALUES = [
  'E2', 'EB', 'EV', 'EC', 'EN', 'EU', 'CPA', 'SPIRO', 'BICAL', 'T', 'TC', 'TE', 'TU',
] as const;

const ESTER_DESCRIPTION =
  'Estradiol esters: EB/EV/EC/EN/EU; E2 = unesterified; anti-androgens: CPA = cyproterone ' +
  'acetate, SPIRO = spironolactone, BICAL = bicalutamide; T esters: TC/TE/TU';

/**
 * Route-specific numbers both a dose and a template accept.
 *
 * Described once so the two tools describe them identically; the ranges come from the
 * engine's own lookup tables rather than being restated.
 */
const EXTRAS_DESCRIPTION =
  `Route-specific numbers, by route. ` +
  `sublingual: sublingualTier 0–${SL_TIER_ORDER.length - 1} (${SL_TIER_ORDER.join('/')}), ` +
  `or sublingualTheta directly (0–1, the absorbed fraction; overrides the tier). ` +
  `gel: gelSite 0–${GEL_SITE_ORDER.length - 1} (${GEL_SITE_ORDER.join('/')}), ` +
  `gelProductId from ${GEL_PRODUCT_OPTIONS.map(p => p.id).join('/')} ` +
  `(${GEL_PRODUCT_OPTIONS.map(p => `${p.id} = ${p.nameKey.replace('gel.product.', '')}`).join(', ')}; ` +
  `ids ≥ 1000 are the account's own products), ` +
  `gelCoverage 0–${GEL_COVERAGE_OPTIONS.length - 1} (${GEL_COVERAGE_OPTIONS.join('/')}), ` +
  `gelCoApplied 0–${GEL_COAPPLICATION_OPTIONS.length - 1} (${GEL_COAPPLICATION_OPTIONS.join('/')}), ` +
  `gelWashAfterH for wash-off, plus concentrationMGmL and areaCM2 as direct values. ` +
  `patch: releaseRateUGPerDay, and patchWearH for planned wear hours. ` +
  `The gel detail beyond gelSite is read only by the Transmtf model — see the pkEngine ` +
  `field in hrt_get_settings — and is stored either way, so it survives a model switch.`;

const SAFETY_NOTE =
  'This is a pharmacokinetic estimate from a population model, not a laboratory measurement. ' +
  'It is informational only and must not be used to decide a dose. Report it as an estimate, ' +
  'and direct any dosing question to the user\'s prescriber.';

/**
 * What `GET /mcp/health` reports, and what the server calls itself.
 *
 * Exported because the health route has to answer the same question the adapter
 * does, and a second copy of either string would be a second thing to forget to
 * bump. The SDK negotiates a protocol version per session; this is the one the
 * deployment is built against, which is what a monitoring probe can act on.
 */
export const MCP_SERVER_NAME = 'hrt-tracker';
export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export function buildServer(resolveContext: ContextResolver): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        'Tools for a personal HRT record: logged doses, lab results, and modelled hormone levels. ' +
        `${SAFETY_NOTE} ` +
        'Identity is proven before any of these tools run; the record key is opened from the ' +
        'deployment\'s own copy of it. If a tool reports the account is locked, the user must ' +
        'sign in at the web UI before record tools will work.',
    },
  );

  // Every record tool starts by resolving the key. Centralised so no tool can
  // forget and silently act on a locked account.
  async function withContext<T>(
    fn: (ctx: AuthContext) => Promise<T>,
  ): Promise<{ value: T } | { error: string }> {
    const ctx = await resolveContext();
    if (!ctx) return { error: NO_CREDENTIAL };
    if ('denied' in ctx) return { error: NOT_UNLOCKED };
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
        before: z
          .string()
          .optional()
          .describe('ISO 8601 instant. Only entries older than it, for paging back through history.'),
      },
    },
    async ({ limit, before }) => {
      const cursor = pagingCursor(before);
      if (!cursor.ok) return toolError(cursor.error);
      const r = await withContext((ctx) => TimelineService.get(ctx, { limit, before: cursor.value }));
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
      description:
        'Doses the user has logged, newest first. Page back through a long history with ' +
        '`before` rather than raising `limit`.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Records per page (default 100, maximum 1000)'),
        before: z
          .string()
          .optional()
          .describe('ISO 8601 instant. Only doses logged before it — pass the oldest `at` from the previous page.'),
      },
    },
    async ({ limit, before }) => {
      const cursor = pagingCursor(before);
      if (!cursor.ok) return toolError(cursor.error);
      const r = await withContext((ctx) => MedicationService.list(ctx, { limit, before: cursor.value }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.records.map((rec) => ({
          // The id the app minted, and the address the store filed it under. Both are
          // reported because a caller replaying a write needs the first and the delete
          // tool needs the second, and neither is derivable from the other alone.
          id: rec.data.id,
          record_id: rec.id,
          mode: rec.mode,
          at: new Date(rec.data.timeH * 3_600_000).toISOString(),
          route: rec.data.route,
          ester: rec.data.ester,
          dose_mg: rec.data.doseMG,
          extras: rec.data.extras,
          version: rec.updatedAt,
        })),
      );
    },
  );

  server.registerTool(
    'hrt_list_labs',
    {
      title: 'List lab results',
      description:
        'Blood test results the user has recorded, newest first. Page back through a long ' +
        'history with `before` rather than raising `limit`.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Records per page (default 100, maximum 1000)'),
        before: z
          .string()
          .optional()
          .describe('ISO 8601 instant. Only labs drawn before it — pass the oldest `at` from the previous page.'),
      },
    },
    async ({ limit, before }) => {
      const cursor = pagingCursor(before);
      if (!cursor.ok) return toolError(cursor.error);
      const r = await withContext((ctx) => LabService.list(ctx, { limit, before: cursor.value }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.records.map((rec) => ({
          id: rec.data.id,
          record_id: rec.id,
          mode: rec.mode,
          at: new Date(rec.data.timeH * 3_600_000).toISOString(),
          value: rec.data.concValue,
          unit: rec.data.unit,
          version: rec.updatedAt,
        })),
      );
    },
  );

  server.registerTool(
    'hrt_list_journal',
    {
      title: 'List journal entries',
      description:
        'The user\'s private journal: one piece of free text per entry, with when it was ' +
        'written. Newest first. These are the user\'s own words, not clinical data — quote ' +
        'them back rather than interpreting them. Page with `before`.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Entries per page (default 100, maximum 1000)'),
        before: z
          .string()
          .optional()
          .describe('ISO 8601 instant. Only entries written before it — pass the oldest `at` from the previous page.'),
      },
    },
    async ({ limit, before }) => {
      const cursor = pagingCursor(before);
      if (!cursor.ok) return toolError(cursor.error);
      const r = await withContext((ctx) => JournalService.list(ctx, { limit, before: cursor.value }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.records.map((rec) => ({
          id: rec.data.id,
          record_id: rec.id,
          mode: rec.mode,
          at: new Date(rec.data.timeH * 3_600_000).toISOString(),
          note: rec.data.note,
          version: rec.updatedAt,
        })),
      );
    },
  );

  server.registerTool(
    'hrt_list_dose_templates',
    {
      title: 'List saved dose templates',
      description:
        'Dose templates the user has saved — a route, ester, dose and extras with no time, ' +
        'which the app offers as one-tap buttons. Read these before logging a dose the user ' +
        'says they \"take their usual\": the template is what \"usual\" means. Most recently ' +
        'edited first. These are the app\'s own records (the same `tpl:` rows it syncs), not a ' +
        'read of the settings blob.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Templates per page (default 100, maximum 1000)'),
        before: z
          .string()
          .optional()
          .describe('ISO 8601 instant. Only templates last edited before it — pass the oldest `updated_at` from the previous page.'),
      },
    },
    async ({ limit, before }) => {
      const cursor = pagingCursor(before);
      if (!cursor.ok) return toolError(cursor.error);
      const r = await withContext((ctx) => TemplateService.list(ctx, { limit, before: cursor.value }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.records.map((rec) => ({
          id: rec.data.id,
          record_id: rec.id,
          mode: rec.mode,
          name: rec.data.name,
          route: rec.data.route,
          ester: rec.data.ester,
          dose_mg: rec.data.doseMG,
          extras: rec.data.extras,
          created_at: new Date(rec.data.createdAt).toISOString(),
          updated_at: rec.data.updatedAt ? new Date(rec.data.updatedAt).toISOString() : null,
          version: rec.updatedAt,
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
      description:
        'Body weight, HRT mode, calibration method and history window, timezone, PK parameter ' +
        'overrides, and `appState` — the web app\'s own settings bag.\n' +
        '\n' +
        '`appState.settings.pkEngine` is which pharmacokinetic model computes the curve: ' +
        `'${PK_ENGINES[0]}' (the original, and the default) or '${PK_ENGINES[1]}'. ` +
        'Read it when a question turns on why a curve looks the way it does, or to explain the ' +
        'difference to the user — the two models draw different curves from the same records. ' +
        'It is **read-only over MCP**: switching models re-computes every past estimate, so the ' +
        'choice is the account owner\'s to make in the app, not a side effect of a request. An ' +
        `absent or unrecognised value means '${DEFAULT_PK_ENGINE}', which is also the default.\n` +
        '\n' +
        'Other read-only fields in appState (language, theme, HRT start date, re-check reminders) ' +
        'cannot be written through MCP either; use hrt_update_settings for the rest.',
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
        route: z.enum(ROUTE_VALUES),
        ester: z.enum(ESTER_VALUES).describe(ESTER_DESCRIPTION),
        dose_mg: z.number().positive().max(10000).optional().describe('Dose in mg; omit only for patchRemove'),
        at: z.string().describe('When it was taken, ISO 8601 (e.g. 2026-09-16T08:00:00Z)'),
        extras: z.record(z.string(), z.number()).optional().describe(EXTRAS_DESCRIPTION),
      },
    },
    async (input) => {
      const r = await withContext((ctx) => MedicationService.add(ctx, input));
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      const rec = r.value.value;
      return toolResult({
        id: rec.data.id,
        record_id: rec.id,
        at: new Date(rec.data.timeH * 3_600_000).toISOString(),
        route: rec.data.route,
        ester: rec.data.ester,
        dose_mg: rec.data.doseMG,
        version: rec.updatedAt,
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
        id: rec.data.id,
        record_id: rec.id,
        at: new Date(rec.data.timeH * 3_600_000).toISOString(),
        value: rec.data.concValue,
        unit: rec.data.unit,
        version: rec.updatedAt,
      });
    },
  );

  server.registerTool(
    'hrt_add_journal_entry',
    {
      title: 'Add a journal entry',
      description:
        'Write one entry to the user\'s private journal. Only call this with words the user ' +
        'actually wrote or dictated — never compose an entry for them, and never infer how ' +
        'they felt. An entry is free text with a time; to edit an existing one, pass its id ' +
        '(the store replaces the entry under that id).',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_.:-]+$/)
          .optional()
          .describe('Opaque record id. Omit to have one generated; pass an existing entry\'s id to replace it.'),
        note: z.string().describe('The entry text, up to 2000 characters. Empty or whitespace-only is refused.'),
        at: z.string().describe('When it was written, ISO 8601 (e.g. 2026-09-16T08:00:00Z)'),
      },
    },
    async (input) => {
      const r = await withContext((ctx) => JournalService.add(ctx, input));
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      const rec = r.value.value;
      return toolResult({
        id: rec.data.id,
        record_id: rec.id,
        mode: rec.mode,
        at: new Date(rec.data.timeH * 3_600_000).toISOString(),
        note: rec.data.note,
        version: rec.updatedAt,
      });
    },
  );

  server.registerTool(
    'hrt_add_dose_template',
    {
      title: 'Save a dose template',
      description:
        'Save a reusable dose the app offers as a one-tap button. This does NOT log a dose — ' +
        'it saves the shape of one, so use it when the user asks to save a routine, and use ' +
        '`hrt_add_medication` when they say they took something. The route, ester, dose and extras ' +
        'must be ones `hrt_reference` lists, because a template that cannot be applied is a ' +
        'button that fails. To change a template, pass its existing id; the store replaces it.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_.:-]+$/)
          .optional()
          .describe('Opaque record id. Omit to have one generated; pass an existing template\'s id to replace it.'),
        name: z.string().describe('A short label the user would recognise, e.g. a Monday injection.'),
        route: z.enum(ROUTE_VALUES),
        ester: z.enum(ESTER_VALUES).describe(ESTER_DESCRIPTION),
        dose_mg: z.number().min(0).max(10000).describe('Dose in mg. 0 is valid when the dose is in extras.'),
        extras: z.record(z.string(), z.number()).optional().describe(EXTRAS_DESCRIPTION),
      },
    },
    async (input) => {
      const r = await withContext((ctx) => TemplateService.add(ctx, input));
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      const rec = r.value.value;
      return toolResult({
        id: rec.data.id,
        record_id: rec.id,
        mode: rec.mode,
        name: rec.data.name,
        route: rec.data.route,
        ester: rec.data.ester,
        dose_mg: rec.data.doseMG,
        extras: rec.data.extras,
        created_at: new Date(rec.data.createdAt).toISOString(),
        version: rec.updatedAt,
      });
    },
  );

  server.registerTool(
    'hrt_update_settings',
    {
      title: 'Update simulation settings',
      description:
        'Change the settings a simulation runs under: body weight, HRT mode, calibration ' +
        'method and history window, timezone, and PK parameter overrides. Omitted fields are ' +
        'left alone; pass an empty object to `pk_params` to clear every override. PK ' +
        'overrides are advanced — only set them if the user explicitly asks, and never guess a ' +
        'value.\n' +
        '\n' +
        'The pharmacokinetic model itself (`appState.settings.pkEngine`, reported by ' +
        'hrt_get_settings) is **not** writable here. Switching it re-computes every past ' +
        'estimate from the same records, so it is a decision the user makes in the app while ' +
        'looking at the curve; ask them to change it rather than looking for a parameter for it. ' +
        'This does not reach the app\'s own display preferences either (language, theme, HRT ' +
        'start date, re-check reminders); those are not agent-writable.',
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
        'Remove one record the user asks you to delete: a dose, a lab result, a journal entry, ' +
        'or a saved dose template. Confirm with the user first — this is not reversible from the ' +
        'agent interface. Deleting a template does not delete any dose logged from it.',
      inputSchema: {
        kind: z
          .enum(['dose', 'lab', 'journal', 'template'])
          .describe('Which collection the id belongs to — the list tool that produced it says which'),
        id: z.string().describe('The `record_id` from a list tool, or the record id itself'),
      },
    },
    async ({ kind, id }) => {
      const r = await withContext((ctx) =>
        kind === 'dose' ? MedicationService.remove(ctx, id)
          : kind === 'lab' ? LabService.remove(ctx, id)
          : kind === 'journal' ? JournalService.remove(ctx, id)
          : TemplateService.remove(ctx, id),
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
        'deletions. This is the whole export: it can run to tens of kilobytes and be ' +
        'truncated by the result budget, so read history through the paginated tools ' +
        '(hrt_get_timeline, hrt_list_medications, hrt_list_labs, hrt_list_journal, ' +
        'hrt_list_dose_templates) and call this only when you need everything at once.',
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
          antiandrogen: {
            CPA: 'cyproterone acetate',
            SPIRO: 'spironolactone',
            BICAL: 'bicalutamide',
          },
          testosterone: { T: 'unesterified', TC: 'cypionate', TE: 'enanthate', TU: 'undecanoate' },
        },
        sublingual_tiers: SL_TIER_ORDER,
        gel_sites: GEL_SITE_ORDER,
        pk_param_ranges: PK_PARAM_RANGES,
        analyte_units: { e2: ['pg/ml', 'pmol/l'], t: ['ng/dl', 'nmol/l'] },
        // A known-bad default, stated where an agent will read it: the one tool that
        // returns everything is also the one the result budget truncates.
        large_reads:
          'hrt_sync_state returns the whole export and can be truncated by the result budget. ' +
          'Read history with the paginated tools instead: hrt_get_timeline, ' +
          'hrt_list_medications, hrt_list_labs, hrt_list_journal, hrt_list_dose_templates or ' +
          'hrt_get_settings.',
        // The whole tool surface. Present so an agent that reads only this tool still
        // learns what exists, and grouped because the grouping is the safety-relevant
        // part: the writes change the record, and the shares leave the account.
        //
        // `server/test/mcp.protocol.test.ts` flattens this and asserts it equals what
        // the client's own `tools/list` returns, so it cannot drift from the real
        // surface the way a prose list can.
        tools: {
          note:
            'Every tool listed here is reachable by any holder of the hrt_ token, including the ' +
            'writes; there is no per-tool scope. Identity operations — changing the password, ' +
            'listing or revoking sessions, binding or unlinking a sign-in provider, deleting the ' +
            'account, and minting or revoking agent tokens — are deliberately NOT exposed over ' +
            'MCP. They are web-only; see server/MCP.md.',
          read: [
            'hrt_get_timeline',
            'hrt_list_medications',
            'hrt_list_labs',
            'hrt_list_journal',
            'hrt_list_dose_templates',
            'hrt_predict_levels',
            'hrt_check_advisories',
            'hrt_get_settings',
            'hrt_sync_state',
            'hrt_reference',
          ],
          write: [
            'hrt_add_medication',
            'hrt_add_lab_result',
            'hrt_add_journal_entry',
            'hrt_add_dose_template',
            'hrt_update_settings',
            'hrt_delete_record',
          ],
          shares: ['hrt_create_share', 'hrt_list_shares', 'hrt_revoke_share'],
        },
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
 *   - `hrt_…` — a durable token minted for an agent. Proves identity; the key comes
 *     from the deployment's own copy of it.
 *   - `ks_…`  — a live unlock token from the web UI. Carries the key directly.
 *
 * Both are delegated to `AccountService.resolveApiContext`, which is the same
 * resolver the HTTP layer uses. Enforcing the rule in the service rather than here
 * is what keeps an MCP tool and its REST twin from diverging on it.
 *
 * A durable token that resolves to null makes the tool say "sign in first" rather
 * than reporting a confusing authentication error.
 */
export function makeBearerResolver(getToken: () => string | undefined): ContextResolver {
  return async () => {
    const token = getToken();
    if (!token) return null;
    return await AccountService.resolveApiContext(token);
  };
}