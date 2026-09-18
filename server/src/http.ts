/**
 * HTTP surface: the web API, the MCP endpoint, and the browser auth flow.
 *
 * Both the REST routes and the MCP tools mount onto the same Application Core, so
 * there is no "agent path" and "user path" through the business logic — that split
 * is where duplicated rules and divergent behaviour come from.
 *
 * Transport decisions worth stating:
 *
 *   - **Streamable HTTP for MCP, stateless per request.** Auth is a bearer token, so
 *     there is no per-connection state to keep and any instance can serve a request.
 *   - **CORS is an exact-match allowlist**, not a reflected origin. The site and the
 *     API are on different hosts, so the API must name the one origin allowed to
 *     call it with credentials; reflecting whatever `Origin` arrives would let any
 *     site make authenticated requests as a signed-in user.
 *   - **The OAuth callback never returns a token.** It redirects to the web app with
 *     a single-use code, because a token in a URL lands in browser history, in
 *     `Referer` headers, and in the logs of every hop.
 */
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { getConfig } from './config.ts';
import { buildServer, makeBearerResolver } from './mcp.ts';
import { MedicationService, LabService, TimelineService, PKSimulationService } from './core.ts';
import { AccountService } from './accounts.ts';
import { ShareService } from './shares.ts';
import type { AuthContext } from './types.ts';
import { findUserSession, lookupSession, closeSession, openSession } from './session.ts';
import { verifyTurnstile } from './turnstile.ts';
import { importPayload, buildExportPayload, publicStats } from './import.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// CORS and security headers
// ---------------------------------------------------------------------------

/**
 * The one origin allowed to call this API with credentials.
 *
 * Exact string equality, because the alternative — echoing back the request's
 * `Origin` while also allowing credentials — lets any website issue authenticated
 * requests as the user. That is why the spec forbids `Allow-Origin: *` together with
 * `Allow-Credentials: true`, and why this cannot be a convenience.
 */
function corsHeaders(requestOrigin: string | undefined): Record<string, string> | null {
  const { publicOrigin } = getConfig();
  // No Origin at all: a same-origin fetch, curl, or an MCP client. No CORS headers
  // are needed and none are added.
  if (!requestOrigin || requestOrigin !== publicOrigin) return null;
  return {
    'Access-Control-Allow-Origin': publicOrigin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

/**
 * Baseline response headers for every response.
 *
 * `nosniff` stops a JSON body being reinterpreted as HTML. The CSP matters because
 * this origin is the API: `frame-ancestors 'none'` blocks clickjacking of an unlock
 * form, and `default-src 'none'` keeps an injected response from loading anything.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cache-Control': 'no-store',
};

function applyCommonHeaders(req: IncomingMessage, res: ServerResponse): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  const cors = corsHeaders(req.headers.origin);
  if (cors) for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Per-IP fixed window, alongside the per-account lockout in `accounts.ts`.
 *
 * Both are needed because they cover different attacks: per-IP stops one host
 * spraying many accounts, while the per-account lockout stops a botnet focusing on
 * one. Neither alone is sufficient.
 *
 * `ponytail:` in-memory, per-process. Adequate for one instance; it does not
 * coordinate across instances. Move to Redis when more than one instance fronts the
 * same database.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (attempts.size > 10_000) {
    for (const [k, entry] of attempts) if (entry.resetAt <= now) attempts.delete(k);
  }
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

function clientIp(req: IncomingMessage): string {
  // Behind the reverse proxy the socket address is the proxy, so the forwarded
  // header is the only usable value. It is spoofable if the app is reachable
  // directly, which is why the deployment binds it to loopback.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Body and response helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Cap before buffering: an unbounded JSON body is a trivial memory exhaustion
      // vector on a public endpoint.
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  return undefined;
}

async function contextFor(req: IncomingMessage): Promise<AuthContext | null> {
  const token = bearer(req);
  if (!token) return null;
  // One resolver for the HTTP and MCP paths, so the privacy-mode rule ("a `hrt_`
  // token alone is enough in standard mode, never in advanced") is written once and
  // cannot be enforced on one route while being forgotten on another.
  return await AccountService.resolveApiContext(token);
}

/**
 * Strip the configured mount prefix from a request path.
 *
 * Returns the remaining absolute path, or null when the request is not under the
 * mount at all. Null is a real answer here, not an error: the host is shared with
 * another service, so "not mine" has to be distinguishable from "mine and unknown".
 *
 * `/hrt` and `/hrt/` both resolve to `/` — a bare prefix is a valid request for the
 * mount root, and treating it as a mismatch would make the prefix awkward to probe.
 */
function stripBasePath(pathname: string): string | null {
  const { basePath } = getConfig();
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}

/** A URL on the web app, for bouncing the browser back after a browser-side step. */
function appUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, getConfig().publicOrigin);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function enrollmentPayload(userId: string, username: string, enrollmentToken: string, totp: { secret: string; otpauthUri: string; backupCodes: string[] }) {
  return {
    user_id: userId,
    username,
    enrollment_token: enrollmentToken,
    totp: { secret: totp.secret, otpauth_uri: totp.otpauthUri, backup_codes: totp.backupCodes },
  };
}

export function createRequestHandler() {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Route matching happens on the path *inside* the mount, so every comparison
    // below stays a plain absolute path and no route has to know it is mounted.
    const path = stripBasePath(url.pathname);

    try {
      applyCommonHeaders(req, res);

      // A request outside the mount is not ours. Answering 404 rather than falling
      // through matters when a sibling service shares the host: serving `/health`
      // from this process would shadow the comment API's own health endpoint.
      if (path === null) {
        send(res, 404, { error: 'not found' });
        return;
      }

      // --- CORS preflight --------------------------------------------------
      if (req.method === 'OPTIONS') {
        const cors = corsHeaders(req.headers.origin);
        if (!cors) {
          // An origin that is not allowed gets a refusal without a hint of what is.
          res.writeHead(403).end();
          return;
        }
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      // --- MCP (Streamable HTTP) -------------------------------------------
      if (path === '/mcp') {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'method not allowed; POST only on a stateless MCP endpoint' });
          return;
        }
        const token = bearer(req);
        const server = buildServer(makeBearerResolver(() => token));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      // --- Health ----------------------------------------------------------
      if (path === '/health') {
        send(res, 200, {
          ok: true,
          service: 'hrt',
          mount: getConfig().basePath || '/',
          x_login: AccountService.xLoginAvailable(),
        });
        return;
      }

      // --- Public aggregate -------------------------------------------------
      if (path === '/stats' && req.method === 'GET') {
        // Public and unauthenticated, so it needs its own ceiling: it costs a
        // handful of sequential scans, and an unthrottled endpoint that counts
        // every row in the table is a cheap way to load the database. Generous
        // enough that the status page's polling is nowhere near it.
        if (rateLimited(`stats:${clientIp(req)}`, 60, 60_000)) {
          return send(res, 429, { error: 'too many requests; try again shortly' });
        }
        // No identifiers leave this route — see `publicStats` for what is and is
        // not in the body. The short cache is what keeps a status page's polling
        // from turning into a scan each time.
        res.setHeader('Cache-Control', 'public, max-age=60');
        return send(res, 200, await publicStats());
      }

      // --- Auth: registration and enrolment --------------------------------
      if (path === '/auth/register' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`register:${clientIp(req)}`, limits.register, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const body = (await readBody(req)) as
          | { username?: unknown; password?: unknown; privacy_mode?: unknown; turnstile_token?: unknown }
          | undefined;
        // Human verification first: it is the cheapest rejection and it must gate
        // account creation, not sit after it.
        const human = await verifyTurnstile(body?.turnstile_token, 'register', clientIp(req));
        if (!human.ok) return send(res, 403, { error: human.error });
        const result = await AccountService.register(body?.username, body?.password, {
          privacyMode: body?.privacy_mode,
        });
        if (!result.ok) return send(res, 400, { error: result.error });
        await AccountService.recordAuthEvent(result.value.userId, 'register', clientIp(req));
        // No session token: TOTP is mandatory, so the account stays unusable until
        // the code below is confirmed.
        return send(res, 201, enrollmentPayload(result.value.userId, result.value.username, result.value.enrollmentToken, result.value.totp));
      }

      if (path === '/auth/totp/confirm' && req.method === 'POST') {
        const body = (await readBody(req)) as { enrollment_token?: unknown; code?: unknown } | undefined;
        const result = await AccountService.confirmEnrollment(String(body?.enrollment_token ?? ''), body?.code);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, { user_id: result.value.userId, username: result.value.username, token: result.value.token });
      }

      if (path === '/auth/totp/resume' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`resume:${clientIp(req)}`, limits.resume, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const body = (await readBody(req)) as { username?: unknown; password?: unknown } | undefined;
        const result = await AccountService.resumeEnrollment(body?.username, body?.password);
        if (!result.ok) return send(res, 401, { error: result.error });
        return send(res, 200, enrollmentPayload(result.value.userId, result.value.username, result.value.enrollmentToken, result.value.totp));
      }

      // --- Auth: sign-in ---------------------------------------------------
      if (path === '/auth/login' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`login:${clientIp(req)}`, limits.login, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const body = (await readBody(req)) as
          | { username?: unknown; password?: unknown; code?: unknown; backup_code?: unknown }
          | undefined;
        const result = await AccountService.unlock(body?.username, body?.password, {
          code: body?.code,
          backupCode: body?.backup_code,
        });
        if (!result.ok) {
          // `two_factor_required` is reported distinctly on purpose: the password is
          // already proven at that point, so telling the client to prompt for a code
          // reveals nothing a wrong-password attempt could exploit.
          return send(res, 401, { error: result.error });
        }
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
          ...(result.value.recoveryCodesRemaining !== undefined
            ? { recovery_codes_remaining: result.value.recoveryCodesRemaining }
            : {}),
        });
      }

      if (path === '/auth/logout' && req.method === 'POST') {
        const token = bearer(req);
        if (token) await AccountService.lock(token);
        return send(res, 200, { ok: true });
      }

      // --- Auth: password and recovery codes -------------------------------
      if (path === '/auth/password' && req.method === 'POST') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const body = (await readBody(req)) as { current_password?: unknown; new_password?: unknown } | undefined;
        const result = await AccountService.changePassword(ctx, body?.current_password, body?.new_password);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, {
          ok: true,
          // Present only when setting a FIRST password, where the existing recovery
          // codes cannot have been seen.
          ...(result.value.recoveryCodes ? { recovery_codes: result.value.recoveryCodes } : {}),
        });
      }

      if (path === '/auth/recovery-codes/regenerate' && req.method === 'POST') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const body = (await readBody(req)) as { code?: unknown } | undefined;
        const result = await AccountService.regenerateRecoveryCodes(ctx, body?.code);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, { recovery_codes: result.value });
      }

      // --- Auth: X OAuth ---------------------------------------------------
      if (path === '/auth/x/start' && req.method === 'GET') {
        const wantsLink = url.searchParams.get('purpose') === 'link';
        let userId: string | undefined;
        if (wantsLink) {
          const ctx = await contextFor(req);
          if (!ctx) return send(res, 401, { error: 'authentication required to link an account' });
          userId = ctx.userId;
        }
        const result = await AccountService.startXAuthorization({
          purpose: wantsLink ? 'link' : 'login',
          userId,
        });
        if (!result.ok) return send(res, 400, { error: result.error });
        // JSON rather than a 302: the app decides how to present it, and a redirect
        // from an API host is awkward to recover from.
        return send(res, 200, { authorize_url: result.value.authorizeUrl });
      }

      if (path === '/auth/x/callback' && req.method === 'GET') {
        const result = await AccountService.completeXCallback({
          code: url.searchParams.get('code') ?? undefined,
          state: url.searchParams.get('state') ?? undefined,
          error: url.searchParams.get('error') ?? undefined,
        });
        if (!result.ok) {
          return redirect(res, appUrl('/auth/x/callback', { error: result.error }));
        }
        const outcome = result.value;
        if (outcome.outcome === 'login') {
          return redirect(res, appUrl('/auth/x/callback', { code: outcome.oneTimeCode }));
        }
        if (outcome.outcome === 'link') {
          return redirect(res, appUrl('/auth/x/callback', { linked: '1', handle: outcome.handle ?? '' }));
        }
        // An account with no password yet: hand the app the setup material so it can
        // walk the user through a password and TOTP enrolment. This is the ONLY way
        // an X-created account becomes usable, and it is why losing X costs a login
        // button rather than the record.
        return redirect(
          res,
          appUrl('/auth/x/setup', {
            setup_token: outcome.setupToken,
            username: outcome.username,
            secret: outcome.totp.secret,
          }),
        );
      }

      if (path === '/auth/x/exchange' && req.method === 'POST') {
        const body = (await readBody(req)) as { code?: unknown } | undefined;
        const result = await AccountService.completeXSignIn(body?.code);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          // null means X verified the identity but no key was handed over. In
          // advanced mode a `locked_token` comes with it, which the client passes to
          // `/auth/unlock` with a password or recovery key.
          token: result.value.token,
          ...(result.value.lockedToken ? { locked_token: result.value.lockedToken } : {}),
        });
      }

      // --- Auth: data unlock (advanced mode) -------------------------------
      //
      // Distinct from `/auth/login`: that proves identity with password + TOTP, this
      // proves the *data* credential for a session whose identity X already proved.
      if (path === '/auth/unlock' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`unlock:${clientIp(req)}`, limits.login, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const body = (await readBody(req)) as
          | { locked_token?: unknown; factor?: unknown; password?: unknown; recovery_key?: unknown }
          | undefined;
        const secret = body?.factor === 'recovery' ? body?.recovery_key : body?.password;
        const result = await AccountService.unlockData(body?.locked_token, body?.factor ?? 'password', secret);
        if (!result.ok) return send(res, 401, { error: result.error });
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
        });
      }

      if (path === '/auth/privacy-mode' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`privacy:${clientIp(req)}`, limits.login, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const body = (await readBody(req)) as
          | { privacy_mode?: unknown; current_password?: unknown }
          | undefined;
        const result = await AccountService.switchPrivacyMode(ctx, body?.privacy_mode, body?.current_password);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, { privacy_mode: result.value.privacyMode });
      }

      if (path === '/auth/recovery-key' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`recovery:${clientIp(req)}`, limits.login, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const body = (await readBody(req)) as { current_password?: unknown } | undefined;
        const result = await AccountService.createRecoveryKey(ctx, body?.current_password);
        if (!result.ok) return send(res, 400, { error: result.error });
        // Returned exactly once. It is never readable again, by design.
        return send(res, 200, { recovery_key: result.value.recoveryKey });
      }

      if (path === '/auth/x/setup' && req.method === 'POST') {
        const body = (await readBody(req)) as
          | { setup_token?: unknown; password?: unknown; code?: unknown; privacy_mode?: unknown; turnstile_token?: unknown }
          | undefined;
        // The X-setup step is the other place an account is born, so it carries the
        // same human check as `/auth/register`.
        const human = await verifyTurnstile(body?.turnstile_token, 'x_setup', clientIp(req));
        if (!human.ok) return send(res, 403, { error: human.error });
        const result = await AccountService.completeSetup(
          String(body?.setup_token ?? ''),
          body?.password,
          body?.code,
          { privacyMode: body?.privacy_mode },
        );
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
        });
      }

      if (path === '/auth/account/delete' && req.method === 'POST') {
        // Rate limited like sign-in: guessing a password here is the same attack, and
        // the per-account lockout in `deleteAccount` is the other half of the pair.
        if (rateLimited(`delete:${clientIp(req)}`, getConfig().rateLimits.login, getConfig().rateLimits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const body = (await readBody(req)) as
          | { password?: unknown; code?: unknown; backup_code?: unknown; reason?: unknown }
          | undefined;
        const result = await AccountService.deleteAccount(ctx, body?.password, {
          code: body?.code,
          backupCode: body?.backup_code,
          reason: body?.reason,
        });
        if (!result.ok) {
          // `two_factor_required` stays distinguishable for the same reason as at
          // sign-in: the password is already proven at that point.
          return send(res, 400, { error: result.error });
        }
        return send(res, 200, { deleted: true });
      }

      if (path === '/auth/account' && req.method === 'GET') {
        // What the account currently holds, so a client can show it before deleting
        // and so a user can reconcile counts against their own export. Deliberately
        // counts rather than contents: the contents are already available through the
        // export and sync endpoints, and this endpoint's job is to answer "is this
        // the account I think it is".
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const { getPool } = await import('./db.ts');
        const { rows } = await getPool().query<{
          doses: string; labs: string; backups: string; x_links: string; created_at: Date;
          privacy_mode: string; encryption_metadata: unknown;
        }>(
          `SELECT
             (SELECT count(*) FROM medication_events WHERE user_id = $1 AND deleted_at IS NULL) AS doses,
             (SELECT count(*) FROM lab_results      WHERE user_id = $1 AND deleted_at IS NULL) AS labs,
             (SELECT count(*) FROM totp_backup_codes WHERE user_id = $1 AND used_at IS NULL)  AS backups,
             (SELECT count(*) FROM oauth_links       WHERE user_id = $1)                      AS x_links,
             (SELECT created_at FROM users WHERE id = $1)                                     AS created_at,
             (SELECT privacy_mode FROM users WHERE id = $1)                                   AS privacy_mode,
             (SELECT encryption_metadata FROM users WHERE id = $1)                            AS encryption_metadata`,
          [ctx.userId],
        );
        const row = rows[0];
        // `has_recovery_key` is a boolean about a *wrapper*, not the key itself: the
        // key is never stored, so this only says whether one has been created.
        const wrappers = (row?.encryption_metadata as { wrappers?: Record<string, unknown> } | null)?.wrappers;
        return send(res, 200, {
          created_at: row?.created_at?.toISOString() ?? null,
          dose_count: Number(row?.doses ?? 0),
          lab_count: Number(row?.labs ?? 0),
          recovery_codes_remaining: Number(row?.backups ?? 0),
          x_links: Number(row?.x_links ?? 0),
          x_login_available: AccountService.xLoginAvailable(),
          privacy_mode: row?.privacy_mode ?? 'standard',
          has_recovery_key: Boolean(wrappers?.recovery),
          // Standard mode depends on a server key existing at all; surface it so the
          // settings screen can say honestly whether Standard is even offered here.
          server_recovery_available: Boolean(getConfig().serverDekKey),
        });
      }

      if (path === '/auth/x/links' && req.method === 'GET') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        return send(res, 200, { links: await AccountService.listXLinks(ctx.userId) });
      }

      if (path === '/auth/x/unlink' && req.method === 'POST') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const body = (await readBody(req)) as { code?: unknown } | undefined;
        const result = await AccountService.unlinkX(ctx, body?.code);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, { ok: true });
      }

      // ---------------------------------------------------------------------
      // Authenticated routes
      //
      // Each route asks for a credential itself rather than relying on a
      // "everything below this line" gate. The gate read fine but answered 401 for
      // paths that do not exist — so a mistyped route, or a probe of the mount
      // prefix, reported "you need to log in" instead of "there is nothing here",
      // which is precisely the wrong signal when someone is debugging a deployment.
      // With per-route checks, an unknown path falls through to the 404 below.
      // ---------------------------------------------------------------------

      /** Resolve the caller, or answer 401 and return null. */
      const requireCtx = async (): Promise<AuthContext | null> => {
        const resolved = await contextFor(req);
        if (!resolved) {
          send(res, 401, { error: 'missing or invalid credentials, or the account is locked' });
          return null;
        }
        return resolved;
      };

      // --- Settings --------------------------------------------------------
      if (path === '/api/settings' && req.method === 'GET') {
        const ctx = await requireCtx();
        if (!ctx) return;
        return send(res, 200, await AccountService.getSettings(ctx));
      }
      if (path === '/api/settings' && req.method === 'PATCH') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as Record<string, unknown> | undefined;
        const result = await AccountService.updateSettings(ctx, body ?? {});
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, { ok: true });
      }

      // --- Sync ------------------------------------------------------------
      if (path === '/api/sync' && req.method === 'POST') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req, 8_000_000)) as
          | { payload?: unknown; push?: boolean; updateExisting?: boolean }
          | undefined;
        if (body?.push !== false) {
          const summary = await importPayload(ctx, body?.payload, {
            updateExisting: body?.updateExisting ?? true,
            // A sync never revives a deleted record: the app's merge treats a
            // tombstone as authoritative, so resurrecting would undo every deletion.
            resurrect: false,
          });
          if (summary.eventsRejected.length || summary.labsRejected.length) {
            // Report rejections alongside the state rather than failing: the valid
            // records did land, and the app should show what was skipped.
            const state = await buildExportPayload(ctx);
            return send(res, 200, { state, summary });
          }
        }
        return send(res, 200, { state: await buildExportPayload(ctx) });
      }

      // --- Medications -----------------------------------------------------
      if (path === '/api/medications' && req.method === 'GET') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const records = await MedicationService.list(ctx, { limit });
        return send(
          res,
          200,
          records.map((r) => ({
            id: r.value.id,
            at: new Date(r.value.timeH * 3_600_000).toISOString(),
            route: r.value.route,
            ester: r.value.ester,
            dose_mg: r.value.doseMG,
            extras: r.value.extras,
            version: r.version,
          })),
        );
      }
      if (path === '/api/medications' && req.method === 'POST') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const result = await MedicationService.add(ctx, await readBody(req));
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 201, { id: result.value.value.id, version: result.value.version });
      }
      const medMatch = path.match(/^\/api\/medications\/([^/]+)$/);
      if (medMatch) {
        const ctx = await requireCtx();
        if (!ctx) return;
        const id = decodeURIComponent(medMatch[1]);
        if (req.method === 'DELETE') {
          const version = url.searchParams.get('version');
          const removed = await MedicationService.remove(ctx, id, version ? Number(version) : undefined);
          return send(res, removed ? 200 : 404, { removed });
        }
        if (req.method === 'GET') {
          const record = await MedicationService.get(ctx, id);
          if (!record) return send(res, 404, { error: 'not found' });
          return send(res, 200, { ...record.value, version: record.version });
        }
      }

      // --- Labs ------------------------------------------------------------
      if (path === '/api/labs' && req.method === 'GET') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const records = await LabService.list(ctx, { limit });
        return send(res, 200, records.map((r) => ({ ...r.value, version: r.version })));
      }
      if (path === '/api/labs' && req.method === 'POST') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const result = await LabService.add(ctx, await readBody(req));
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 201, { id: result.value.value.id, version: result.value.version });
      }

      // --- Timeline --------------------------------------------------------
      if (path === '/api/timeline' && req.method === 'GET') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const limit = Number(url.searchParams.get('limit') ?? 100);
        return send(res, 200, await TimelineService.get(ctx, { limit }));
      }

      // --- Prediction ------------------------------------------------------
      if (path === '/api/predict' && req.method === 'POST') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as Record<string, unknown> | undefined;
        const result = await PKSimulationService.predict(ctx, {
          analyte: body?.analyte as 'e2' | 't' | undefined,
          fromDays: body?.from_days as number | undefined,
          toDays: body?.to_days as number | undefined,
          points: body?.points as number | undefined,
          withCalibration: body?.with_calibration as boolean | undefined,
        });
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, result.value);
      }

      // --- Agent tokens ----------------------------------------------------
      //
      // Tokens are permanent by default; the user manages the set rather than
      // waiting for an expiry. See `mintApiToken` for why an expiry is the wrong
      // default for a credential pasted into an agent's config.
      if (path === '/api/tokens' && req.method === 'GET') {
        const ctx = await requireCtx();
        if (!ctx) return;
        return send(res, 200, { tokens: await AccountService.listApiTokens(ctx.userId) });
      }
      if (path === '/api/tokens' && req.method === 'POST') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as { name?: unknown } | undefined;
        const name = typeof body?.name === 'string' && body.name.trim() !== '' && body.name.length <= 64
          ? body.name.trim()
          : 'agent';
        const token = await AccountService.mintApiToken(ctx.userId, name);
        // The plaintext is returned exactly once, here. Nothing can read it back
        // afterwards — only its hash is stored.
        return send(res, 201, { token, name });
      }
      const tokenRevoke = path.match(/^\/api\/tokens\/([0-9a-f-]{36})$/);
      if (tokenRevoke && req.method === 'DELETE') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const removed = await AccountService.revokeApiToken(ctx.userId, tokenRevoke[1]);
        if (!removed) return send(res, 404, { error: 'no such token' });
        return send(res, 200, { ok: true });
      }

      // --- Shares ----------------------------------------------------------
      //
      // `/api/shares/access` is the one route here that answers without a session: a
      // share link exists precisely so someone without an account can read it. Its
      // authorization is the token in the body, and the response is `publicView` — no
      // id, no owner, no hash.
      //
      // It is rate-limited by IP like the other unauthenticated POST routes, because a
      // token endpoint with no ceiling is an invitation to guess in bulk.
      if (path === '/api/shares/access' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`share:${clientIp(req)}`, limits.login, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const body = (await readBody(req)) as { token?: unknown; password?: unknown } | undefined;
        const result = await ShareService.access(body?.token, body?.password);
        if (!result.ok) {
          // The code, not the status, is what the client switches on — it already has
          // copy for each of these. `SHARE_NOT_FOUND` covers both a token that never
          // existed and one that has expired, which is the pair a prober could otherwise
          // use to discover which links are real.
          const codes: Record<string, [number, string]> = {
            password_required: [401, 'PASSWORD_REQUIRED'],
            invalid_password: [401, 'INVALID_PASSWORD'],
            expired: [410, 'SHARE_EXPIRED'],
            'not found': [404, 'SHARE_NOT_FOUND'],
          };
          const [status, code] = codes[result.error] ?? [404, 'SHARE_NOT_FOUND'];
          return send(res, status, {
            code,
            ...(code === 'PASSWORD_REQUIRED' ? { passwordRequired: true } : {}),
            message: result.error,
          });
        }
        return send(res, 200, result.value);
      }

      if (path === '/api/shares' && req.method === 'GET') {
        const ctx = await requireCtx();
        if (!ctx) return;
        return send(res, 200, { shares: await ShareService.list(ctx.userId) });
      }

      if (path === '/api/shares' && req.method === 'POST') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as
          | { snapshot?: unknown; password?: unknown; expiresAt?: unknown; live?: unknown }
          | undefined;
        const result = await ShareService.create(ctx.userId, {
          snapshot: body?.snapshot,
          password: body?.password,
          expiresAt: body?.expiresAt,
          live: body?.live,
        });
        if (!result.ok) return send(res, 400, { code: 'SHARE_REJECTED', message: result.error });
        return send(res, 201, result.value);
      }

      if (path === '/api/shares/live' && req.method === 'PUT') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as { snapshot?: unknown } | undefined;
        const result = await ShareService.syncLive(ctx.userId, body?.snapshot);
        if (!result.ok) return send(res, 400, { code: 'SHARE_REJECTED', message: result.error });
        return send(res, 200, result.value);
      }

      const shareRevoke = path.match(/^\/api\/shares\/([0-9a-f-]{36})$/);
      if (shareRevoke && req.method === 'DELETE') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const removed = await ShareService.revoke(ctx.userId, shareRevoke[1]);
        if (!removed) return send(res, 404, { error: 'no such share' });
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal error';
      if (!res.headersSent) send(res, 500, { error: message });
    }
  };
}

export function startServer(port = getConfig().port): ReturnType<typeof createHttpServer> {
  const server = createHttpServer((req, res) => {
    void createRequestHandler()(req, res);
  });
  // Bind to loopback by default: the reverse proxy is the only ingress, so the
  // service is never directly reachable and `X-Forwarded-For` cannot be spoofed.
  const host = process.env.BIND_HOST ?? '127.0.0.1';
  server.listen(port, host, () => {
    process.stdout.write(`hrt-server listening on ${host}:${port}\n`);
  });
  return server;
}

/**
 * Clear the per-IP counters.
 *
 * Used by tests to keep one test's attempts from consuming another's budget, and
 * available operationally to clear a burst after a false positive — the alternative
 * is an operator restarting the process to unblock a user.
 */
export function resetRateLimits(): void {
  attempts.clear();
}

export { closeSession, openSession };
