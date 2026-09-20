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
import {
  buildServer,
  makeBearerResolver,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from './mcp.ts';
import { AccountService } from './accounts.ts';
import { isGoogleConfigured } from './oauth.ts';
import { RecordService, buildExportPayload, publicStats } from './records.ts';
import { getPool } from './db.ts';
import { ShareService } from './shares.ts';
import type { AuthContext } from './types.ts';
import {
  lookupSession,
  closeSession,
  openSession,
  touchSession,
  listUserSessions,
  revokeSessions,
  revokeOtherSessions,
} from './session.ts';
import { verifyTurnstile } from './turnstile.ts';

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

/** The device a request came from, as the session list describes it. */
function requestDevice(req: IncomingMessage): { userAgent: string | null; ip: string | null } {
  const ua = req.headers['user-agent'];
  return {
    // Truncated, because this text is attacker-controlled and ends up rendered in a
    // settings list: there is no reason to keep more than enough to name a browser.
    userAgent: typeof ua === 'string' ? ua.slice(0, 200) : null,
    ip: clientIp(req),
  };
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  return undefined;
}

async function contextFor(req: IncomingMessage): Promise<AuthContext | null> {
  const token = bearer(req);
  if (!token) return null;
  // One resolver for the HTTP and MCP paths, so "what can this credential reach" is
  // written once and cannot be enforced on one route while being forgotten on
  // another.
  //
  // A denial is flattened to null here: every REST route treats "no usable key" the
  // same way (401), while `mcp.ts` turns it into the instruction the user actually
  // needs. `http.ts`'s MCP mount passes the resolver straight through, not through
  // this helper.
  const ctx = await AccountService.resolveApiContext(token);
  if (!ctx || 'denied' in ctx) return null;
  // Where a live unlock is last seen. The session store cannot see requests, and this is
  // the single point every authenticated REST call passes through; a durable `hrt_` agent
  // token is not a session, and `touchSession` ignores it for exactly that reason.
  if (token.startsWith('ks_')) await touchSession(token, requestDevice(req));
  return ctx;
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

/**
 * Whether Google sign-in is configured, for the `/health` flag the app reads.
 *
 * Separate from `AccountService.xLoginAvailable` because the answer comes from config
 * rather than from a service method, and the health payload is where the app learns
 * whether to render a provider's button at all.
 */
function googleLoginAvailable(): boolean {
  return isGoogleConfigured(getConfig().google);
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
          google_login: googleLoginAvailable(),
        });
        return;
      }

      // --- MCP readiness ---------------------------------------------------
      //
      // A status page has to answer "is the MCP endpoint up?" without holding an
      // agent token, and `/mcp` itself cannot answer it: it resolves a bearer
      // first, so an unauthenticated probe gets 401 and a probe with a token
      // would be reporting the *credential's* state rather than the service's.
      // This is the tokenless half — the adapter is mounted, and which protocol
      // version it speaks. It says nothing about any account.
      if (path === '/mcp/health') {
        if (req.method !== 'GET') {
          send(res, 405, { error: 'method not allowed; GET on the MCP health route' });
          return;
        }
        send(res, 200, {
          ok: true,
          service: 'hrt-mcp',
          mount: `${getConfig().basePath || ''}/mcp`,
          server: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
          protocol: MCP_PROTOCOL_VERSION,
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

      // --- Auth: registration -----------------------------------------------
      if (path === '/auth/register' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`register:${clientIp(req)}`, limits.register, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const body = (await readBody(req)) as
          | { username?: unknown; password?: unknown; turnstile_token?: unknown; persistent?: unknown }
          | undefined;
        // Human verification first: it is the cheapest rejection and it must gate
        // account creation, not sit after it.
        const human = await verifyTurnstile(body?.turnstile_token, 'register', clientIp(req));
        if (!human.ok) return send(res, 403, { error: human.error });
        const result = await AccountService.register(body?.username, body?.password, {
          persistent: body?.persistent === true,
        });
        if (!result.ok) return send(res, 400, { error: result.error });
        await AccountService.recordAuthEvent(result.value.userId, 'register', clientIp(req));
        // A session straight away, because there is nothing left to confirm: the
        // caller has just chosen the password, and the DEK was minted with it.
        return send(res, 201, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
        });
      }

      // --- Auth: sign-in ---------------------------------------------------
      if (path === '/auth/login' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`login:${clientIp(req)}`, limits.login, limits.windowMs)) {
          return send(res, 429, { error: 'too many attempts; try again shortly' });
        }
        const body = (await readBody(req)) as
          | { username?: unknown; password?: unknown; persistent?: unknown }
          | undefined;
        const result = await AccountService.unlock(body?.username, body?.password, {
          persistent: body?.persistent === true,
        });
        if (!result.ok) {
          return send(res, 401, { error: result.error });
        }
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
        });
      }

      if (path === '/auth/logout' && req.method === 'POST') {
        const token = bearer(req);
        if (token) await AccountService.lock(token);
        return send(res, 200, { ok: true });
      }

      // --- Auth: password ---------------------------------------------------
      if (path === '/auth/password' && req.method === 'POST') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const body = (await readBody(req)) as { current_password?: unknown; new_password?: unknown } | undefined;
        const result = await AccountService.changePassword(ctx, body?.current_password, body?.new_password);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, { ok: true });
      }

      // --- Auth: Google OAuth ----------------------------------------------
      //
      // Same shape as X's pair, and deliberately so: the app decides how to present the
      // URL, and the callback hands back a one-time code rather than a session, so a
      // URL that leaks from a browser history is not a credential.
      if (path === '/auth/google/start' && req.method === 'GET') {
        const wantsLink = url.searchParams.get('purpose') === 'link';
        let userId: string | undefined;
        if (wantsLink) {
          const ctx = await contextFor(req);
          if (!ctx) return send(res, 401, { error: 'authentication required to link an account' });
          userId = ctx.userId;
        } else if (url.searchParams.get('intent') === 'register') {
          // Human verification, asked for only when the caller says it is signing up.
          //
          // Not on every login start, deliberately: a provider sign-in is the *only*
          // way into an account created through a provider, and those accounts have
          // no password. Gating that would mean a blocked or adblocked Turnstile
          // locks the account's owner out of their own records. So the challenge is
          // tied to the path that creates an account, where bulk abuse actually is —
          // and `intent` is a claim the client makes, so a script that omits it skips
          // this check. That is the honest bound of this gate: it stops form-driven
          // abuse and scripted signup from the app, not a determined client.
          const human = await verifyTurnstile(
            url.searchParams.get('turnstile_token'),
            ['oauth', 'register'],
            clientIp(req),
          );
          if (!human.ok) return send(res, 403, { error: human.error });
        }
        const result = await AccountService.startGoogleAuthorization({
          purpose: wantsLink ? 'link' : 'login',
          userId,
        });
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, { authorize_url: result.value.authorizeUrl });
      }

      if (path === '/auth/google/callback' && req.method === 'GET') {
        const result = await AccountService.completeGoogleCallback({
          code: url.searchParams.get('code') ?? undefined,
          state: url.searchParams.get('state') ?? undefined,
          error: url.searchParams.get('error') ?? undefined,
        });
        if (!result.ok) {
          return redirect(res, appUrl('/auth/google/callback', { error: result.error }));
        }
        if (result.value.outcome === 'link') {
          return redirect(res, appUrl('/auth/google/callback', { linked: '1' }));
        }
        // No setup leg, unlike X: a Google account is usable immediately. The anti-ban
        // prompt is driven by `/auth/login-methods` reporting `recovery_risk`.
        return redirect(res, appUrl('/auth/google/callback', { code: result.value.oneTimeCode ?? '' }));
      }

      if (path === '/auth/google/exchange' && req.method === 'POST') {
        const body = (await readBody(req)) as { code?: unknown } | undefined;
        const result = await AccountService.completeProviderSignIn('google', body?.code, {
          persistent: (body as { persistent?: unknown } | undefined)?.persistent === true,
        });
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
        });
      }

      // --- Auth: X OAuth ---------------------------------------------------
      if (path === '/auth/x/start' && req.method === 'GET') {
        const wantsLink = url.searchParams.get('purpose') === 'link';
        let userId: string | undefined;
        if (wantsLink) {
          const ctx = await contextFor(req);
          if (!ctx) return send(res, 401, { error: 'authentication required to link an account' });
          userId = ctx.userId;
        } else if (url.searchParams.get('intent') === 'register') {
          // See the Google route above: same gate, same reason, and the same
          // deliberate exemption for a plain sign-in.
          const human = await verifyTurnstile(
            url.searchParams.get('turnstile_token'),
            ['oauth', 'register'],
            clientIp(req),
          );
          if (!human.ok) return send(res, 403, { error: human.error });
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
        if (outcome.outcome === 'link') {
          return redirect(res, appUrl('/auth/x/callback', { linked: '1', handle: outcome.handle ?? '' }));
        }
        // An X account is usable the moment it exists; the prompt to bind a fallback
        // gates records, not the account.
        return redirect(res, appUrl('/auth/x/callback', { code: outcome.oneTimeCode }));
      }

      if (path === '/auth/x/exchange' && req.method === 'POST') {
        const body = (await readBody(req)) as { code?: unknown } | undefined;
        const result = await AccountService.completeProviderSignIn('x', body?.code, {
          persistent: (body as { persistent?: unknown } | undefined)?.persistent === true,
        });
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
        });
      }

      // --- Auth: live sessions ----------------------------------------------
      //
      // Listing and revocation, both scoped to the caller by `contextFor`. Nothing here
      // returns a token or a key: the list names devices so a person can *end* access,
      // not so anyone can resume it.
      if (path === '/auth/sessions' && req.method === 'GET') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        return send(res, 200, { sessions: await listUserSessions(ctx.userId, bearer(req) ?? null) });
      }

      if (path === '/auth/sessions/revoke' && req.method === 'POST') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const token = bearer(req) ?? null;
        const body = (await readBody(req)) as { ids?: unknown; all_others?: unknown } | undefined;

        if (body?.all_others === true) {
          return send(res, 200, { revoked: await revokeOtherSessions(ctx.userId, token) });
        }

        // A row in the UI stands for a device, which can hold more than one unlock, so
        // the request carries every id behind that row.
        const ids = Array.isArray(body?.ids)
          ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : [];
        if (ids.length === 0) return send(res, 400, { error: 'ids: required' });
        // Revoking the caller's own session is allowed rather than refused: a client that
        // asked for it is a client that is about to drop its token anyway.
        return send(res, 200, { revoked: await revokeSessions(ctx.userId, ids) });
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
          | { password?: unknown; reason?: unknown }
          | undefined;
        const result = await AccountService.deleteAccount(ctx, body?.password, {
          reason: body?.reason,
        });
        if (!result.ok) {
          return send(res, 400, { error: result.error });
        }
        return send(res, 200, { deleted: true });
      }

      if (path === '/auth/account' && req.method === 'GET') {
        // What the account currently holds, so a client can show it before deleting
        // and so a user can reconcile counts against their own export. Deliberately
        // counts rather than contents: the contents are already available through the
        // export and record endpoints, and this endpoint's job is to answer "is this
        // the account I think it is".
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const counts = await RecordService.countByCategory(ctx);
        const { rows } = await getPool().query<{
          x_links: string; created_at: Date; x_avatar_url: string | null;
        }>(
          `SELECT
             (SELECT count(*) FROM oauth_accounts       WHERE user_id = $1)                      AS x_links,
             (SELECT created_at FROM users WHERE id = $1)                                     AS created_at,
             -- The linked X avatar, for the account header. It is already stored; the
             -- summary simply never surfaced it, so the page had nothing but a generic
             -- glyph to draw. Null when no X account is linked.
             (SELECT avatar_url FROM oauth_accounts
               WHERE user_id = $1 AND provider = 'x' AND avatar_url IS NOT NULL
               ORDER BY linked_at ASC LIMIT 1)                                                 AS x_avatar_url`,
          [ctx.userId],
        );
        const row = rows[0];
        return send(res, 200, {
          created_at: row?.created_at?.toISOString() ?? null,
          dose_count: counts.dose ?? 0,
          lab_count: counts.lab ?? 0,
          x_links: Number(row?.x_links ?? 0),
          x_login_available: AccountService.xLoginAvailable(),
          x_avatar_url: row?.x_avatar_url ?? null,
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
        const result = await AccountService.unlinkX(ctx);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, { ok: true });
      }

      // --- Auth: fallback credentials (the anti-ban path) -------------------
      //
      // Signing up through X or Google leaves an account whose only way in is that
      // provider, so a ban or a revoked API credential makes the account — and the
      // records in it — unreachable. These two routes are how a user avoids that:
      // bind an account name and password while the social login still works, and
      // unlink later without ever being stranded.

      if (path === '/auth/credentials/bind' && req.method === 'POST') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const body = (await readBody(req)) as { username?: unknown; password?: unknown } | undefined;
        const result = await AccountService.bindCredentials(ctx, body?.username, body?.password);
        if (!result.ok) {
          // A name another account holds is a conflict, not a bad request; the form
          // renders the two differently.
          const status = result.error === 'username_taken' ? 409 : 400;
          return send(res, status, { error: result.error });
        }
        return send(res, 200, { ok: true, username: result.value.username });
      }

      if (path === '/auth/login-methods' && req.method === 'GET') {
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const overview = await AccountService.loginOverview(ctx.userId);
        return send(res, 200, {
          username: overview.username,
          has_password: overview.hasPassword,
          providers: overview.providers,
          // True when losing the linked provider would lose the account.
          recovery_risk: overview.recoveryRisk,
          accounts: await AccountService.listOAuthLinks(ctx.userId),
        });
      }

      if (path.startsWith('/auth/oauth/') && path.endsWith('/unlink') && req.method === 'POST') {
        const provider = path.slice('/auth/oauth/'.length, -'/unlink'.length);
        const ctx = await contextFor(req);
        if (!ctx) return send(res, 401, { error: 'authentication required' });
        const result = await AccountService.unlinkProvider(ctx, provider);
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

      /**
       * Resolve the caller, and require that they have bound a fallback credential.
       *
       * Answering **403 with a machine-readable code** rather than 401 is deliberate: the
       * session is perfectly valid, so signing the user out would be wrong and would lose
       * the very session they need in order to bind. The app reads `account_incomplete`
       * and routes to the binding screen instead of to sign-in.
       */
      const requireBoundCtx = async (): Promise<AuthContext | null> => {
        const resolved = await requireCtx();
        if (!resolved) return null;
        if (!(await AccountService.hasBoundCredentials(resolved.userId))) {
          send(res, 403, {
            error: 'account_incomplete',
            detail: 'bind an account name and password before using records',
          });
          return null;
        }
        return resolved;
      };

      // --- Records (encrypted payloads) ------------------------------------
      //
      // The client sends and receives plaintext JSON; sealing and opening happen here.
      // `user_id` and `taken_at` are the only things the database can read.

      if (path === '/api/records' && req.method === 'GET') {
        const ctx = await requireBoundCtx();
        if (!ctx) return;
        const beforeRaw = url.searchParams.get('before');
        const before = beforeRaw ? Number(beforeRaw) : undefined;
        const { records, unreadable } = await RecordService.list(ctx, {
          limit: Number(url.searchParams.get('limit') ?? 200),
          category: url.searchParams.get('category') ?? undefined,
          before: Number.isFinite(before) ? before : undefined,
        });
        return send(res, 200, {
          records: records.map((r) => ({
            id: r.id,
            taken_at: new Date(r.takenAt).toISOString(),
            category: r.category,
            data: r.data,
            updated_at: new Date(r.updatedAt).toISOString(),
          })),
          // Surfaced rather than swallowed: a client that ignores this is at least not
          // being told its history is complete when it is not.
          unreadable,
        });
      }

      if (path === '/api/records' && req.method === 'POST') {
        const ctx = await requireBoundCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as Record<string, unknown> | undefined;
        const result = await RecordService.put(ctx, body ?? {});
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 201, { id: result.id });
      }

      const recordMatch = path.match(/^\/api\/records\/([^/]+)$/);
      if (recordMatch) {
        const ctx = await requireBoundCtx();
        if (!ctx) return;
        const id = decodeURIComponent(recordMatch[1]);
        if (req.method === 'DELETE') {
          const removed = await RecordService.remove(ctx, id);
          return send(res, removed ? 200 : 404, { removed });
        }
      }

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

      // --- Export ----------------------------------------------------------
      //
      // The account's records in the app's own payload shape. One route, because the
      // app already knows how to merge that shape and a second reader of records would
      // be a second implementation of the same rules.
      if (path === '/api/export' && req.method === 'GET') {
        const ctx = await requireBoundCtx();
        if (!ctx) return;
        return send(res, 200, await buildExportPayload(ctx));
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
