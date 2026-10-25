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
  MedPlanService,
} from './core.ts';
import type { AuthContext, ContextDenial } from './types.ts';

/**
 * How much raw dose history MCP exposes.
 *
 * A durable token can read records without a browser present, so the default
 * surface is deliberately bounded: recent activity is enough for an assistant to
 * help, while the full historical log stays in the web app. Derived reads
 * (hrt_predict_levels, advisories) still use the complete history internally.
 */
const MCP_RECENT_DAYS = 7;

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
  // The same limits the validators enforce, imported rather than retyped: a schema that
  // says 10000 while the validator says 20000 refuses the agent with zod's wording, and
  // the two would drift the first time either changed.
  DOSE_MG_MAX,
  BODY_WEIGHT_KG_MIN,
  BODY_WEIGHT_KG_MAX,
  Ester,
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
 * MCP failures are prose, deliberately, and do not carry the REST `code`.
 *
 * A tool result is read by a model, which benefits from the sentence and would
 * have to be told what each code means; and the text is already the interface
 * those clients are built against. The REST contract (`{ code, message }`, see
 * `types.ts`'s `API_CODES`) stops at the HTTP boundary. If codes are ever wanted
 * here, add them as a *second* field and leave the text alone — changing the text
 * changes what every agent prints to its user.
 */

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
  beforeId: string | undefined,
): { ok: true; value: number | undefined; id: string | undefined } | { ok: false; error: string } {
  // An id with no timestamp cannot be a cursor: the store pages by the pair, and
  // `before_id` alone would be silently ignored. Rejected rather than dropped.
  if (before === undefined) {
    if (beforeId !== undefined) {
      return { ok: false, error: 'before_id: requires `before` (the pair is the cursor)' };
    }
    return { ok: true, value: undefined, id: undefined };
  }
  const ms = Date.parse(before);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `before: not a valid ISO 8601 timestamp (got ${JSON.stringify(before)})` };
  }
  return { ok: true, value: ms, id: beforeId };
}

/**
 * The dose vocabulary, in one place because three tools now accept it.
 *
 * `hrt_add_medication` and `hrt_add_dose_template` take the same route and ester,
 * and `hrt_list_dose_templates` returns them; a second copy of either list is a
 * second thing to forget when an ester is added upstream.
 */
const ROUTE_VALUES = ['injection', 'oral', 'sublingual', 'gel', 'patchApply', 'patchRemove'] as const;
// Derived from the engine's own enum rather than retyped. The hand-written list
// was the second thing to forget when the app added P4/MPA/NET/RALOX/FIN/DUT/GNRH.
const ESTER_VALUES = Object.values(Ester) as [string, ...string[]];

const ESTER_DESCRIPTION =
  'Estradiol esters: EB/EV/EC/EN/EU; E2 = unesterified; anti-androgens: CPA = cyproterone ' +
  'acetate, SPIRO = spironolactone, BICAL = bicalutamide; T esters: TC/TE/TU; recorded-only ' +
  'compounds: P4 = progesterone, MPA = medroxyprogesterone acetate, NET = norethisterone, ' +
  'RALOX = raloxifene, FIN = finasteride, DUT = dutasteride, GNRH = GnRH analogue. ' +
  'The recorded-only compounds are stored but not simulated.';

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
  `injection: vehicle 0 = oil, 1 = aqueous (EC only). ` +
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
        'Recent activity newest-first, limited to the last 7 days: logged doses and lab ' +
        'results merged into one stream. Older history is not exposed over MCP; use the web ' +
        'app to review it.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Maximum entries (default 100)'),
        before: z
          .string()
          .optional()
          .describe('ISO 8601 instant. Only entries older than it, for paging back through history.'),
        before_id: z
          .string()
          .optional()
          .describe(
            'Tiebreaker for `before`: the `id` of the last entry on the previous page. ' +
            'Pass it together with `before` when several records share one instant, or ' +
            'the ones at that instant after the page boundary are skipped.',
          ),
      },
    },
    async ({ limit, before, before_id }) => {
      const cursor = pagingCursor(before, before_id);
      if (!cursor.ok) return toolError(cursor.error);
      const cutoffH = Date.now() / 3_600_000 - MCP_RECENT_DAYS * 24;
      if (cursor.value !== undefined && cursor.value < cutoffH) return toolResult([]);
      const r = await withContext((ctx) => TimelineService.get(ctx, { limit, before: cursor.value, beforeId: cursor.id }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value
          .filter((e) => Date.parse(e.at) / 3_600_000 >= cutoffH)
          .map((e) =>
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
        'Doses the user has logged in the last 7 days, newest first. Older doses are not ' +
        'exposed over MCP; use the web app to review them.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Records per page (default 100, maximum 1000)'),
        before: z
          .string()
          .optional()
          .describe('ISO 8601 instant. Only doses logged before it — pass the oldest `at` from the previous page.'),
        before_id: z
          .string()
          .optional()
          .describe(
            'Tiebreaker for `before`: the `id` of the last entry on the previous page. ' +
            'Pass it together with `before` when several records share one instant, or ' +
            'the ones at that instant after the page boundary are skipped.',
          ),
      },
    },
    async ({ limit, before, before_id }) => {
      const cursor = pagingCursor(before, before_id);
      if (!cursor.ok) return toolError(cursor.error);
      const cutoffH = Date.now() / 3_600_000 - MCP_RECENT_DAYS * 24;
      if (cursor.value !== undefined && cursor.value < cutoffH) return toolResult([]);
      const r = await withContext((ctx) => MedicationService.list(ctx, { limit, before: cursor.value, beforeId: cursor.id }));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.records
          .filter((rec) => rec.data.timeH >= cutoffH)
          .map((rec) => ({
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
        before_id: z
          .string()
          .optional()
          .describe(
            'Tiebreaker for `before`: the `id` of the last entry on the previous page. ' +
            'Pass it together with `before` when several records share one instant, or ' +
            'the ones at that instant after the page boundary are skipped.',
          ),
      },
    },
    async ({ limit, before, before_id }) => {
      const cursor = pagingCursor(before, before_id);
      if (!cursor.ok) return toolError(cursor.error);
      const r = await withContext((ctx) => LabService.list(ctx, { limit, before: cursor.value, beforeId: cursor.id }));
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
        before_id: z
          .string()
          .optional()
          .describe(
            'Tiebreaker for `before`: the `id` of the last entry on the previous page. ' +
            'Pass it together with `before` when several records share one instant, or ' +
            'the ones at that instant after the page boundary are skipped.',
          ),
      },
    },
    async ({ limit, before, before_id }) => {
      const cursor = pagingCursor(before, before_id);
      if (!cursor.ok) return toolError(cursor.error);
      const r = await withContext((ctx) => JournalService.list(ctx, { limit, before: cursor.value, beforeId: cursor.id }));
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
        before_id: z
          .string()
          .optional()
          .describe(
            'Tiebreaker for `before`: the `id` of the last entry on the previous page. ' +
            'Pass it together with `before` when several records share one instant, or ' +
            'the ones at that instant after the page boundary are skipped.',
          ),
      },
    },
    async ({ limit, before, before_id }) => {
      const cursor = pagingCursor(before, before_id);
      if (!cursor.ok) return toolError(cursor.error);
      const r = await withContext((ctx) => TemplateService.list(ctx, { limit, before: cursor.value, beforeId: cursor.id }));
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
        'The `engine` field names the pharmacokinetic model that actually computed the curve — ' +
        'it is the account\'s choice where that engine can serve, and the built-in model where ' +
        'it cannot (a transmasc account, a testosterone curve). Report which one was used.\n' +
        '\n' +
        '`window` reports the span actually covered, which is **not always** the span asked ' +
        'for: the simulation grid ends at `max(lastDose + 14d, now + 24h)` and begins at the ' +
        'first logged dose. So `to_days: 14` returns a full 14 days on an account dosing this ' +
        'week, but only about a day on one whose last dose was a month ago — the same ' +
        'arguments, a different horizon. **Check `window.endTruncated` before comparing the ' +
        'far end of two calls**, and read `window.endDaysFromNow` for the real horizon. ' +
        '`startTruncated` just means the history does not go back that far. ' +
        '`calibration` reports the post-dose points used for the fit (`labs`), the pre-dose ' +
        'draws used only for the additive background (`nBaseline`), labs whose hormone type is ' +
        'unconfirmed and therefore excluded (`nUnknown`), and the estimated background E2 ' +
        '(`baselinePGmL`). ' +
        SAFETY_NOTE,
      inputSchema: {
        analyte: z.enum(['e2', 't']).optional().describe('"e2" = estradiol (default), "t" = testosterone. These exact strings; no other value is accepted.'),
        from_days: z.number().int().min(1).max(3650).optional().describe('How far back to show (default 90)'),
        to_days: z.number().int().min(0).max(365).optional().describe('How far ahead to show (default 14)'),
        points: z.number().int().min(10).max(1000).optional().describe('Max curve points (default 200). The final sample is always appended, so a page may carry one more than this.'),
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
    'hrt_med_plan_status',
    {
      title: 'Medication plan status',
      description:
        'The user\'s own medication schedule (用药方案) and whether today\'s doses have kept ' +
        'up with it: each plan with its due times that have passed with no matching dose ' +
        'logged, and an `overdue` flag. Use this to answer "did I miss a dose today". ' +
        'A plan matches a dose by compound and (when the plan names one) route — the alias ' +
        'is display-only. The plan is the user\'s own schedule, not medical advice; report ' +
        'what it says and direct any dosing question to the user\'s prescriber.',
      inputSchema: {},
    },
    async () => {
      const r = await withContext((ctx) => MedPlanService.status(ctx, Date.now()));
      if ('error' in r) return toolError(r.error);
      return toolResult(
        r.value.map((s) => ({
          esters: {
            ester: s.plan.ester,
            route: s.plan.route ?? null,
            alias: s.plan.alias ?? null,
          },
          dose: s.plan.dose,
          schedule: {
            mode: s.plan.mode,
            // For 'times', the day's doses are the first time plus each extra one.
            first_time: `${String(s.plan.firstHour).padStart(2, '0')}:${String(s.plan.firstMinute).padStart(2, '0')}`,
            dose_times: (s.plan.doseTimes ?? []).map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`),
            interval_hours: s.plan.intervalHours ?? null,
            every_days: s.plan.everyDays ?? null,
          },
          overdue: s.overdue,
          missed_times: s.missed,
        })),
      );
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
        '`appState.settings.pkEngine` is which pharmacokinetic model the account has chosen: ' +
        `'${PK_ENGINES[0]}' (the original, and the default) or '${PK_ENGINES[1]}'. ` +
        'hrt_predict_levels runs that engine and reports which one it used in its `engine` ' +
        'field — read that field, not the setting, when explaining a curve, because the choice ' +
        'is overruled where the chosen engine cannot serve: a transmasc account or a ' +
        'testosterone curve stays on the built-in engine. Read the setting when a question ' +
        'turns on what the user picked, or to explain the difference between the two models. ' +
        'It is **read-only over MCP**: switching models re-computes every past estimate, so the ' +
        'choice is the account owner\'s to make in the app, not a side effect of a request. An ' +
        `absent or unrecognised value means '${DEFAULT_PK_ENGINE}', which is also the default.\n` +
        '\n' +
        '`appState.settings.gelProducts` is the account\'s own gel catalogue: ids ≥ 1000, ' +
        'each with a name, concentration, application area and its own absorption rate ' +
        'constants. A gel dose\'s `gelProductId` resolves against this list when the ' +
        'Transmtf engine draws the curve, so read it when a user asks why two of their ' +
        'own products curve differently — or why a product they expected is not there. ' +
        'A `gelProductId` with no matching entry falls back to the first preset ' +
        '(Oestrogel) rather than failing, which is a deliberate, silent behaviour.\n' +
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
        dose_mg: z.number().positive().max(DOSE_MG_MAX).optional().describe('Dose in mg; omit only for patchRemove'),
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
        analyte: z.enum(['E2', 'T', 'unknown']).optional().describe(
          'Which hormone the value measures. Omit it and the record is stored as unknown; ' +
          'unknown records are kept but excluded from every calibration fit until confirmed. ' +
          'Send E2 or T whenever the caller knows it.'
        ),
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
        analyte: rec.data.analyte ?? 'unknown',
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
        dose_mg: z.number().min(0).max(DOSE_MG_MAX).describe('Dose in mg. 0 is valid when the dose is in extras.'),
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
        '`pk_params` applies to the **built-in** engine only. When `hrt_predict_levels` reports ' +
        `engine: '${PK_ENGINES[1]}' the overrides are stored but not used, because that engine's ` +
        'coefficients are internal model constants rather than the quantities this setting ' +
        'edits. To have them take effect, the account must be on the built-in engine — say so ' +
        'rather than reporting that the change took effect.\n' +
        '\n' +
        'The pharmacokinetic model itself (`appState.settings.pkEngine`, reported by ' +
        'hrt_get_settings) is **not** writable here. Switching it re-computes every past ' +
        'estimate from the same records, so it is a decision the user makes in the app while ' +
        'looking at the curve; ask them to change it rather than looking for a parameter for it. ' +
        'This does not reach the app\'s own display preferences either (language, theme, HRT ' +
        'start date, re-check reminders); those are not agent-writable.',
      inputSchema: {
        body_weight_kg: z.number().min(BODY_WEIGHT_KG_MIN).max(BODY_WEIGHT_KG_MAX).optional(),
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
          progestin: {
            P4: 'micronised progesterone (recorded, not modelled)',
            MPA: 'medroxyprogesterone acetate (recorded, not modelled)',
            NET: 'norethisterone (recorded, not modelled)',
          },
          serm_and_hair: {
            RALOX: 'raloxifene (recorded, not modelled)',
            FIN: 'finasteride (recorded, not modelled)',
            DUT: 'dutasteride (recorded, not modelled)',
          },
          gnrh: { GNRH: 'GnRH analogue (recorded, not modelled)' },
        },
        sublingual_tiers: SL_TIER_ORDER,
        gel_sites: GEL_SITE_ORDER,
        pk_param_ranges: PK_PARAM_RANGES,
        analyte_units: { e2: ['pg/ml', 'pmol/l'], t: ['ng/dl', 'nmol/l'] },
        lab_analytes: ['E2', 'T', 'unknown'],
        calibration_fields: ['labs', 'nBaseline', 'nUnknown', 'baselinePGmL', 'scale', 'fitErrorPct'],
        // The full export is deliberately not an MCP tool: a durable token must
        // not be able to pull a user's entire history in one call. The paginated
        // reads above are bounded to recent activity; full export stays in the
        // signed-in web app.
        large_reads:
          'MCP does not expose the full export. Use the paginated recent reads: ' +
          'hrt_get_timeline, hrt_list_medications, hrt_list_labs, hrt_list_journal, ' +
          'hrt_list_dose_templates or hrt_get_settings.',
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
            'hrt_med_plan_status',
            'hrt_get_settings',
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
        'Publish a read-only link to the user\'s dose history. Anyone with the URL can read it '
        + 'until it expires, so confirm with the user before calling this. Lab results, body '
        + 'weight and profile details are never included — the server refuses a payload carrying '
        + 'them. The URL is returned once and cannot be retrieved again. The snapshot has no '
        + 'modelled curve: the model runs in the app, and a live link is refreshed from it '
        + 'while the app is open.',
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

        // The account's own mode, not a field on the context — AuthContext has no
        // `mode`, so this used to be transfem for everyone, and a transmasc account's
        // *live* link then never matched the app's refresh filter
        // (`useLiveShareSync` compares it against the local mode).
        const { hrtMode } = await AccountService.getSettings(ctx);
        return await ShareService.create(ctx.userId, {
          snapshot: {
            version: 1,
            mode: hrtMode === 'transmasc' ? 'transmasc' : 'transfem',
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
        included: 'dose history',
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
      // A miss is reported as data, not as a tool error — the same shape
      // `hrt_delete_record` returns, so a caller does not have to handle "it returned
      // false" and "it threw" as two different kinds of failure for two sibling verbs.
      if (!r.value) return toolResult({ revoked: false, id });
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