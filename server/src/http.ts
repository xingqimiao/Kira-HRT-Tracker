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
import { avatarEtag, avatarForUser } from './avatars.ts';
import { isGoogleConfigured } from './oauth.ts';
import { RecordService, buildExportPayload, buildSettingsScalars, currentSyncVersion, publicStats } from './records.ts';
import { getPool } from './db.ts';
import { ShareService } from './shares.ts';
import {
  acceptAfdianOrder,
  acceptBmcDonation,
  acceptBmcSubscription,
  adminTokenMatches,
  afdianSignatureMatches,
  apply as applySupporter,
  approve as approveSupporter,
  bmcSignatureMatches,
  cleanBmcName,
  listApproved,
  listPending,
  removeBmcRecord,
  remove as removeSupporter,
  rename as renameSupporter,
  resolveAfdianSponsorName,
} from './supporters.ts';
import { PushStore, startPushScanner } from './push.ts';
import type { ApiCode, AuthContext } from './types.ts';
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
  // Tauri v2 serves the bundled Android frontend from its reserved local origin.
  // It is not the public website origin, but it is the trusted app that needs to
  // call the same API. Keep this an exact allowlist; never reflect arbitrary origins.
  const allowedOrigins = new Set([publicOrigin]);
  // The packaged app is a production surface, not a dev one: Tauri v2 serves the
  // bundled frontend from its reserved local origin, so every API call from the APK
  // is cross-origin and needs exactly these two entries. They are not "localhost" in
  // the sense that matters — the scheme+host is reserved to the app itself — so they
  // stay in the list in every environment. (Gating them on NODE_ENV once shipped a
  // production API that answered 403 to the whole native app.)
  allowedOrigins.add('http://tauri.localhost');
  allowedOrigins.add('https://tauri.localhost');
  // The dev server origins *are* dev-only. They stayed in the allowlist long
  // enough to be copied into a deployment, which is why this is gated on NODE_ENV
  // rather than left as a comment. Note that a deployment which forgets NODE_ENV
  // gets them back — and also skips every other production check in config.ts, so
  // DEPLOY.md makes the variable mandatory.
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
  }
  // In development, also allow LAN IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x) on dev ports
  const isDevLan = process.env.NODE_ENV !== 'production'
    && requestOrigin
    && /^http:\/\/(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::(?:3000|5173|5175))?$/.test(requestOrigin);
  if (!requestOrigin || (!allowedOrigins.has(requestOrigin) && !isDevLan)) return null;
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function oauthReturnUri(raw: string | null): string | undefined {
  return raw === 'kira-hrt://oauth/callback' ? raw : undefined;
}

async function oauthReturnUriForState(state: string | null): Promise<string | undefined> {
  if (!state) return undefined;
  const { rows } = await getPool().query<{ return_uri: string | null }>(
    'SELECT return_uri FROM oauth_states WHERE state = $1 AND expires_at > now()',
    [state],
  );
  return oauthReturnUri(rows[0]?.return_uri ?? null);
}

function oauthAppRedirect(provider: 'x' | 'google', returnUri: string | undefined, params: Record<string, string>): string {
  if (!returnUri) return appUrl(`/auth/${provider}/callback`, params);
  const target = new URL(returnUri);
  target.searchParams.set('provider', provider);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
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
  // This origin is only loaded as a page by the share viewer, and nothing embeds it,
  // so it has no reason to share a browsing context with any opener.
  'Cross-Origin-Opener-Policy': 'same-origin',
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

/**
 * The caller's address, as far as the rate limiter can trust it.
 *
 * It used to take the **leftmost** X-Forwarded-For entry, which is the one the
 * caller wrote: every per-IP bucket (login, register, account deletion, share
 * unlock) could be bypassed by prefixing a fresh value, leaving only the
 * per-account lockout standing.
 *
 * The trustworthy values are, in order:
 *
 *   1. `CF-Connecting-IP`, which Cloudflare sets on every proxied request and
 *      overwrites if the client sent one. The site is behind Cloudflare, so this
 *      is the real client address.
 *   2. The **last** X-Forwarded-For entry — the hop appended by the reverse proxy
 *      that actually connects to us. Caddy appends rather than replaces, so the
 *      leftmost entries are still caller-controlled.
 *   3. The socket address, for a direct call.
 *
 * All three are only as good as the ingress: if the origin is reachable directly,
 * any of them can be forged. `server/DEPLOY.md` therefore requires the service to
 * stay bound to loopback and the origin to accept only Cloudflare's ranges.
 * The result is length-capped because it becomes a Map key.
 */
function clientIp(req: IncomingMessage): string {
  const clamp = (value: string): string => value.trim().slice(0, 64);

  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return clamp(cf);

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const hops = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    if (hops.length > 0) return clamp(hops[hops.length - 1]);
  }
  return clamp(req.socket.remoteAddress ?? 'unknown');
}

// ---------------------------------------------------------------------------
// Body and response helpers
// ---------------------------------------------------------------------------

/**
 * Buffer a request body without parsing it.
 *
 * The webhook signature is an HMAC over the *raw* bytes. Re-serialising the parsed
 * JSON would produce a different string for any client that formatted it
 * differently, and the comparison would fail for a genuine delivery.
 */
function readRawBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const raw = await readRawBody(req, limitBytes);
  if (!raw.length) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Service-layer message → API code, in one table at the HTTP boundary.
 *
 * The services return prose because their messages are also what a user reads, and
 * pushing codes down into every `Result` would duplicate the same sentence in two
 * shapes for 89 call sites. The mapping belongs here, where a response is actually
 * built, and it is deliberately exhaustive over the strings the services can emit
 * today — a miss falls back to a status-derived code rather than to nothing, so a
 * new message can never produce a response without a code.
 *
 * When you add a message to a service, add it here too if it needs a code other
 * than the one its status implies.
 */
const CODE_BY_MESSAGE: Record<string, ApiCode> = {
  // --- Credentials and sessions --------------------------------------------
  'invalid credentials': 'INVALID_CREDENTIALS',
  'current password is incorrect': 'INVALID_CREDENTIALS',
  'password is incorrect': 'INVALID_CREDENTIALS',
  'the password does not open this account’s key': 'INVALID_CREDENTIALS',
  'the password does not open this account’s current key': 'INVALID_CREDENTIALS',
  'current password does not open the account key': 'INVALID_CREDENTIALS',
  'too many failed attempts; try again later': 'LOCKED',
  'too many attempts; try again shortly': 'RATE_LIMITED',
  'too many attempts, try again later': 'RATE_LIMITED',
  'too many requests; try again shortly': 'RATE_LIMITED',
  'too many applications; try again later': 'RATE_LIMITED',
  username_taken: 'USERNAME_TAKEN',
  'username is already taken': 'USERNAME_TAKEN',
  'authentication required': 'AUTH_REQUIRED',
  'authentication required to link an account': 'AUTH_REQUIRED',
  'missing or invalid credentials, or the account is locked': 'AUTH_REQUIRED',
  unauthorized: 'AUTH_REQUIRED',
  'linking requires a signed-in account': 'AUTH_REQUIRED',
  account_incomplete: 'ACCOUNT_INCOMPLETE',
  'X login is not configured on this instance': 'NOT_CONFIGURED',
  'Google login is not configured on this instance': 'NOT_CONFIGURED',
  'webhook not configured': 'NOT_CONFIGURED',
  'key rotation requires the KMS master key': 'NOT_CONFIGURED',

  // --- The account key itself ----------------------------------------------
  'account key material is unreadable': 'KEY_UNREADABLE',
  'account key material is unreadable; set a new password to re-key it': 'KEY_UNREADABLE',
  'the key’s HSM half could not be opened': 'KEY_UNREADABLE',

  // --- Request shape -------------------------------------------------------
  'body is not JSON': 'INVALID_REQUEST',
  'ids: required': 'INVALID_REQUEST',
  'code: required': 'INVALID_REQUEST',
  'data: required': 'INVALID_REQUEST',
  'data: too large': 'PAYLOAD_TOO_LARGE',
  'takenAt: must be a date or epoch milliseconds': 'INVALID_REQUEST',
  'at: cannot be more than a day in the future': 'INVALID_REQUEST',
  'records: must be an array': 'INVALID_REQUEST',
  'before_id: requires `before` (the pair is the cursor)': 'INVALID_REQUEST',
  'nothing to update': 'INVALID_REQUEST',
  'unsupported provider': 'INVALID_REQUEST',
  'a device token is required': 'INVALID_REQUEST',
  'a name between 1 and 64 characters is required': 'INVALID_REQUEST',
  'id: must be a string': 'INVALID_REQUEST',
  'username: 3–30 characters, letters/digits/underscore/hyphen only': 'INVALID_REQUEST',
  'password: must be 8–128 characters': 'INVALID_REQUEST',
  'bind a password to this account before rotating its key': 'INVALID_REQUEST',
  'hrt_mode: must be transfem or transmasc': 'INVALID_REQUEST',
  'calibration_history: must be forward or retrospective': 'INVALID_REQUEST',
  'timezone: must be a string of at most 64 characters': 'INVALID_REQUEST',
  'body_weight_kg is not set for this account; a simulation needs it (20–400 kg)': 'INVALID_REQUEST',

  // --- OAuth ---------------------------------------------------------------
  'Google callback had no code': 'INVALID_REQUEST',
  'Google callback had no state': 'INVALID_REQUEST',
  'callback is missing code or state': 'INVALID_REQUEST',
  'that sign-in link expired; try again': 'INVALID_REQUEST',
  'this sign-in link expired or was already used': 'INVALID_REQUEST',
  'this authorization has expired or was already used; start again': 'INVALID_REQUEST',
  'that sign-in link was started for a different provider': 'INVALID_REQUEST',
  'link authorization had no account': 'INVALID_REQUEST',
  'linked account no longer exists': 'NOT_FOUND',
  'that X account is already linked to a different account': 'CONFLICT',
  'that Google account is already linked to a different account': 'CONFLICT',
  'this is the only way into the account — set an account name and password first': 'CONFLICT',
  'could not allocate a username; try signing in with a password instead': 'CONFLICT',

  // --- Shares --------------------------------------------------------------
  'a share password must be at least 8 characters': 'INVALID_REQUEST',
  'a share password must be at most 128 characters': 'INVALID_REQUEST',
  'sealed: must be a v1 AES-256-GCM envelope (iv, ct)': 'INVALID_REQUEST',
  'expiresAt is required': 'INVALID_REQUEST',
  'expiresAt must be in the future': 'INVALID_REQUEST',
  'shareId is required for a sealed update': 'INVALID_REQUEST',
  'missing token': 'INVALID_REQUEST',

  // --- Human verification --------------------------------------------------
  'human verification failed': 'TURNSTILE',
  'human verification is required': 'TURNSTILE',

  // --- Supporters ----------------------------------------------------------
  invalid_name: 'INVALID_NAME',
  invalid_tx_hash: 'INVALID_TX_HASH',
  'that transaction hash was already submitted': 'DUPLICATE_TX',

  // --- Transport -----------------------------------------------------------
  'not found': 'NOT_FOUND',
  not_found: 'NOT_FOUND',
  'no avatar': 'NOT_FOUND',
  'no such token': 'NOT_FOUND',
  'no such share': 'NOT_FOUND',
  'no such record': 'NOT_FOUND',
  'no such supporter': 'NOT_FOUND',
  'no such pending supporter': 'NOT_FOUND',
  'method not allowed; POST only on a stateless MCP endpoint': 'METHOD_NOT_ALLOWED',
  'method not allowed; GET on the MCP health route': 'METHOD_NOT_ALLOWED',
  'method not allowed; webhooks are POST only': 'METHOD_NOT_ALLOWED',
  'invalid signature': 'FORBIDDEN',
  'internal error': 'INTERNAL',
  'could not store the record': 'INTERNAL',
};

/**
 * The code a bare status implies.
 *
 * Only reached for a message this table does not know — a dynamic one such as
 * `X authorization was declined (…)`, or a new one nobody mapped. The status is
 * always the coarser statement, so it is the safe answer.
 */
const CODE_BY_STATUS: Record<number, ApiCode> = {
  400: 'INVALID_REQUEST',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'INVALID_REQUEST',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
};

/** The code for a service message. Exported for the vocabulary tests. */
export function apiCodeFor(message: string, status: number): ApiCode {
  // `Object.hasOwn` rather than a bare index: a caller-influenced message could be
  // `toString`, and an inherited member is not a code.
  const mapped = Object.hasOwn(CODE_BY_MESSAGE, message) ? CODE_BY_MESSAGE[message] : undefined;
  return mapped ?? CODE_BY_STATUS[status] ?? 'INTERNAL';
}

/**
 * Supporters already name their failures with a token rather than a sentence
 * (`ApplyError` in supporters.ts, `RenameResult`'s error), so these pass straight
 * through instead of being matched as prose. Mapped explicitly rather than with
 * `toUpperCase()` so a new member of that union cannot silently become a code the
 * vocabulary does not contain.
 */
const SUPPORTER_CODES: Record<string, ApiCode> = {
  duplicate_tx: 'DUPLICATE_TX',
  invalid_name: 'INVALID_NAME',
  invalid_tx_hash: 'INVALID_TX_HASH',
  not_found: 'NOT_FOUND',
  unconfirmed: 'UNCONFIRMED',
  not_received: 'NOT_RECEIVED',
  verify_unavailable: 'VERIFY_UNAVAILABLE',
};

/**
 * Answer a failure: `{ code, message, error: message, ...extra }`.
 *
 * `error` is not dead weight. An installed Android build reads it and nothing
 * else, and it cannot be upgraded in step with the server, so the alias outlives
 * this refactor. `message` and `error` are always the same string, which is what
 * keeps the two from disagreeing.
 *
 * `extra.code` overrides the table for the handful of routes that already own a
 * code (shares, supporters); any other key is merged into the body as before.
 */
function fail(
  res: ServerResponse,
  status: number,
  message: string,
  extra: { code?: ApiCode } & Record<string, unknown> = {},
): void {
  const { code: explicit, ...rest } = extra;
  send(res, status, {
    code: explicit ?? apiCodeFor(message, status),
    message,
    error: message,
    ...rest,
  });
}

/**
 * Headers for the status page's probe, and the nonce it must echo.
 *
 * The probe reaches us through Cloudflare and has to prove it heard from the origin
 * rather than from something holding a copy. Two headers do that: this response may not
 * be stored, and the nonce the caller minted for this one request comes back. A cached
 * copy cannot contain a value it never saw, which is why the echo is worth more than the
 * directive: a directive asks for cooperation, the echo is evidence.
 *
 * Only the health routes call this. They are tokenless and say nothing about any account.
 */
function probeHeaders(req: IncomingMessage, res: ServerResponse): void {
  const nonce = new URL(req.url || '/', 'http://localhost').searchParams.get('nonce');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (nonce) res.setHeader('X-Probe-Nonce', nonce);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** The device a request came from, as the session list describes it. */
function requestDevice(req: IncomingMessage): { userAgent: string | null; ip: string | null } {
  // The app identifies itself with `X-Kira-Client` (e.g. `KiraHRT/1.0.2`) because
  // its raw UA is a webview's and cannot be told from a Chrome browser — it used to
  // be recorded as "Android · Chrome" in the user's own device list. Only our app
  // sends the header, so it is used verbatim as the stored device string; inferring
  // from the UA is unsound (WeChat and other webviews share the `wv` token).
  const client = req.headers['x-kira-client'];
  const ua = Array.isArray(client) ? client[0] : client;
  if (typeof ua === 'string' && ua.trim()) {
    return { userAgent: ua.trim().slice(0, 200), ip: clientIp(req) };
  }
  const raw = req.headers['user-agent'];
  return {
    // Truncated, because this text is attacker-controlled and ends up rendered in a
    // settings list: there is no reason to keep more than enough to name a browser.
    userAgent: typeof raw === 'string' ? raw.slice(0, 200) : null,
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
 * Where an account's stored avatar is served from — an absolute URL on the web app's
 * own origin, because that is the origin the browser's CSP permits for the image.
 *
 * Absolute rather than relative on purpose: a path like `/auth/avatar/<id>` would
 * resolve against the *web app's* host, which is not a host this service is mounted on.
 * A relative URL only works when the API is same-origin with the app, and these two are
 * deliberately on different hosts.
 *
 * The shape of the URL is what keeps the picture from becoming a beacon: it carries no
 * session and no query the browser has to invent, and the response is revalidated with an
 * ETag, so a browser that already holds the bytes asks for a 304 instead of the image.
 */
function avatarPath(userId: string, provider?: string): string {
  const base = `${getConfig().apiBaseUrl}/auth/avatar/${encodeURIComponent(userId)}`;
  // One picture per account by default — that is what the header shows. The
  // settings list asks per provider, because the same person looks different on
  // X and on Google and each row is its own account.
  return provider ? `${base}?p=${encodeURIComponent(provider)}` : base;
}

/**
 * Add the URL each row's own picture is served from, beside the provider's URL.
 *
 * `avatarUrl` on these rows is the provider's own CDN address — kept as the
 * record of where the copy came from, and deliberately not renderable (`avatars.ts`
 * says why). What the app can draw is our copy, and each row has to get *its own*:
 * a person's X picture and Google picture are not the same image, so the account-wide
 * avatar would show one face on two rows.
 */
function withProviderAvatarPaths<T extends { provider: string; hasAvatar: boolean }>(
  userId: string,
  links: T[],
): (T & { proxiedAvatarUrl: string | null })[] {
  return links.map((link) => ({
    ...link,
    proxiedAvatarUrl: link.hasAvatar ? avatarPath(userId, link.provider) : null,
  }));
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
    // Live-web-session credential gate (hoisted): identity and destructive operations
    // are documented web-only (server/MCP.md) — a durable agent token must not reach
    // them, or it could mint successors, replace the password, or lock its owner out.
    async function requireSessionCtx(): Promise<AuthContext | null> {
      const token = bearer(req);
      if (!token || !token.startsWith('ks_')) {
        fail(res, 403, 'this operation requires signing in through the web app');
        return null;
      }
      const resolved = await contextFor(req);
      if (!resolved) {
        fail(res, 401, 'missing or invalid credentials, or the account is locked');
        return null;
      }
      return resolved;
    }

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
        fail(res, 404, 'not found');
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
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Kira-Client',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      // --- MCP (Streamable HTTP) -------------------------------------------
      if (path === '/mcp') {
        if (req.method !== 'POST') {
          fail(res, 405, 'method not allowed; POST only on a stateless MCP endpoint');
          return;
        }
        const token = bearer(req);
        const server = buildServer(makeBearerResolver(() => token));
        // Answer with a single JSON response rather than opening an SSE stream.
        //
        // Every tool here is one request, one answer -- initialize, tools/list,
        // tools/call -- so a stream buys the client nothing and costs compatibility
        // twice over. The spec lets a client send only `Accept: application/json`,
        // and this endpoint answered 406 for that; and between the client and here
        // sit proxies that treat `text/event-stream` as something to buffer, which
        // turns a 1.7 s reply into a timeout. A plain JSON body has neither problem,
        // and it is the shape every other call this server answers already has.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        // Accept either Accept header, then answer JSON either way.
        //
        // The SDK validates the header before the response mode is chosen, so a
        // client that sends only `application/json` -- which the spec permits -- was
        // still refused with 406 even though nothing about this server needs a
        // stream. Widening it here rather than upstream keeps the refusal for a
        // header that accepts neither, and changes nothing for a client that already
        // sends both.
        const accept = String(req.headers.accept || '');
        const namesJson = accept.includes('application/json');
        const namesSse = accept.includes('text/event-stream');
        if (namesJson !== namesSse) {
          req.headers.accept = 'application/json, text/event-stream';
        }
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
        probeHeaders(req, res);
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
          fail(res, 405, 'method not allowed; GET on the MCP health route');
          return;
        }
        probeHeaders(req, res);
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
          return fail(res, 429, 'too many requests; try again shortly');
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
          return fail(res, 429, 'too many attempts; try again shortly');
        }
        const body = (await readBody(req)) as
          | { username?: unknown; password?: unknown; turnstile_token?: unknown; persistent?: unknown }
          | undefined;
        // Human verification first: it is the cheapest rejection and it must gate
        // account creation, not sit after it.
        const human = await verifyTurnstile(body?.turnstile_token, 'register', clientIp(req));
        if (!human.ok) return fail(res, 403, human.error);
        const result = await AccountService.register(body?.username, body?.password, {
          persistent: body?.persistent === true,
        });
        if (!result.ok) return fail(res, 400, result.error);
        await AccountService.recordAuthEvent(result.value.userId, 'register', clientIp(req));
        // A session straight away, because there is nothing left to confirm: the
        // caller has just chosen the password, and the DEK was minted with it.
        return send(res, 201, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
          device_pass: result.value.devicePass,
        });
      }

      // --- Auth: sign-in ---------------------------------------------------
      if (path === '/auth/login' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`login:${clientIp(req)}`, limits.login, limits.windowMs)) {
          return fail(res, 429, 'too many attempts; try again shortly');
        }
        const body = (await readBody(req)) as
          | { username?: unknown; password?: unknown; persistent?: unknown; device_pass?: unknown }
          | undefined;
        const result = await AccountService.unlock(body?.username, body?.password, {
          persistent: body?.persistent === true,
          devicePass: body?.device_pass,
        });
        if (!result.ok) {
          return fail(res, 401, result.error);
        }
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
          device_pass: result.value.devicePass,
        });
      }

      if (path === '/auth/logout' && req.method === 'POST') {
        const token = bearer(req);
        if (token) await AccountService.lock(token);
        return send(res, 200, { ok: true });
      }

      // --- Auth: password ---------------------------------------------------
      if (path === '/auth/password' && req.method === 'POST') {
        const ctx = await requireSessionCtx();
        if (!ctx) return fail(res, 401, 'authentication required');
        // A session is not a licence to guess the password. This route bcrypt-checks
        // `current_password`, so without a bucket a stolen token is a password oracle at
        // whatever rate the socket allows. Keyed by account rather than address: the
        // attacker can change address, and everyone behind one carrier NAT would share
        // the address's budget.
        if (rateLimited(`password:${ctx.userId}`, 10, 60_000)) {
          return fail(res, 429, 'too many attempts, try again later');
        }
        const body = (await readBody(req)) as { current_password?: unknown; new_password?: unknown } | undefined;
        const result = await AccountService.changePassword(ctx, body?.current_password, body?.new_password);
        if (!result.ok) return fail(res, 400, result.error);
        return send(res, 200, { ok: true });
      }

      // --- Auth: data-key rotation -------------------------------------------
      //
      // Re-encrypts the account's records under a fresh DEK, invalidating any copy of
      // the old key that a compromised server might have leaked from memory. It
      // verifies a password, which puts it on the credential-guessing surface — so it
      // rides the login rate bucket, not an unbounded one.
      if (path === '/auth/keys/rotate' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`rotate:${bearer(req) ?? clientIp(req)}`, limits.login, limits.windowMs)) {
          return fail(res, 429, 'too many attempts, try again later');
        }
        const ctx = await contextFor(req);
        if (!ctx) return fail(res, 401, 'authentication required');
        const body = (await readBody(req)) as { password?: unknown } | undefined;
        const result = await AccountService.rotateKeys(ctx, body?.password);
        if (!result.ok) return fail(res, 400, result.error);
        return send(res, 200, { ok: true, records: result.value.records, unreadable: result.value.unreadable });
      }

      // --- Auth: Google OAuth ----------------------------------------------
      //
      // Same shape as X's pair, and deliberately so: the app decides how to present the
      // URL, and the callback hands back a one-time code rather than a session, so a
      // URL that leaks from a browser history is not a credential.
      if (path === '/auth/google/start' && req.method === 'GET') {
        // Unauthenticated and it writes a row per call, so it takes the register
        // bucket rather than none at all.
        const startLimits = getConfig().rateLimits;
        if (rateLimited(`oauth-start:${clientIp(req)}`, startLimits.register, startLimits.windowMs)) {
          return fail(res, 429, 'too many attempts; try again shortly');
        }
        const wantsLink = url.searchParams.get('purpose') === 'link';
        let userId: string | undefined;
        if (wantsLink) {
          const ctx = await contextFor(req);
          if (!ctx) return fail(res, 401, 'authentication required to link an account');
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
          if (!human.ok) return fail(res, 403, human.error);
        }
        const result = await AccountService.startGoogleAuthorization({
          purpose: wantsLink ? 'link' : 'login',
          userId,
          returnUri: oauthReturnUri(url.searchParams.get('return_uri')),
        });
        if (!result.ok) return fail(res, 400, result.error);
        return send(res, 200, { authorize_url: result.value.authorizeUrl });
      }

      if (path === '/auth/google/callback' && req.method === 'GET') {
        const returnUri = await oauthReturnUriForState(url.searchParams.get('state'));
        const result = await AccountService.completeGoogleCallback({
          code: url.searchParams.get('code') ?? undefined,
          state: url.searchParams.get('state') ?? undefined,
          error: url.searchParams.get('error') ?? undefined,
        });
        if (!result.ok) {
          return redirect(res, oauthAppRedirect('google', returnUri, { error: result.error }));
        }
        if (result.value.outcome === 'link') {
          return redirect(res, oauthAppRedirect('google', returnUri, { linked: '1' }));
        }
        // No setup leg, unlike X: a Google account is usable immediately. The anti-ban
        // prompt is driven by `/auth/login-methods` reporting `recovery_risk`.
        return redirect(res, oauthAppRedirect('google', returnUri, { code: result.value.oneTimeCode ?? '' }));
      }

      if (path === '/auth/google/exchange' && req.method === 'POST') {
        const body = (await readBody(req)) as { code?: unknown } | undefined;
        const result = await AccountService.completeProviderSignIn('google', body?.code, {
          persistent: (body as { persistent?: unknown } | undefined)?.persistent === true,
        });
        if (!result.ok) return fail(res, 400, result.error);
        return send(res, 200, {
          user_id: result.value.userId,
          username: result.value.username,
          token: result.value.token,
        });
      }

      // --- Auth: X OAuth ---------------------------------------------------
      if (path === '/auth/x/start' && req.method === 'GET') {
        // Same reasoning as the Google route above: unauthenticated and it writes a
        // row, so it rides the register bucket.
        const xStartLimits = getConfig().rateLimits;
        if (rateLimited(`oauth-start:${clientIp(req)}`, xStartLimits.register, xStartLimits.windowMs)) {
          return fail(res, 429, 'too many attempts; try again shortly');
        }
        const wantsLink = url.searchParams.get('purpose') === 'link';
        let userId: string | undefined;
        if (wantsLink) {
          const ctx = await contextFor(req);
          if (!ctx) return fail(res, 401, 'authentication required to link an account');
          userId = ctx.userId;
        } else if (url.searchParams.get('intent') === 'register') {
          // See the Google route above: same gate, same reason, and the same
          // deliberate exemption for a plain sign-in.
          const human = await verifyTurnstile(
            url.searchParams.get('turnstile_token'),
            ['oauth', 'register'],
            clientIp(req),
          );
          if (!human.ok) return fail(res, 403, human.error);
        }
        const result = await AccountService.startXAuthorization({
          purpose: wantsLink ? 'link' : 'login',
          userId,
          returnUri: oauthReturnUri(url.searchParams.get('return_uri')),
        });
        if (!result.ok) return fail(res, 400, result.error);
        // JSON rather than a 302: the app decides how to present it, and a redirect
        // from an API host is awkward to recover from.
        return send(res, 200, { authorize_url: result.value.authorizeUrl });
      }

      if (path === '/auth/x/callback' && req.method === 'GET') {
        const returnUri = await oauthReturnUriForState(url.searchParams.get('state'));
        const result = await AccountService.completeXCallback({
          code: url.searchParams.get('code') ?? undefined,
          state: url.searchParams.get('state') ?? undefined,
          error: url.searchParams.get('error') ?? undefined,
        });
        if (!result.ok) {
          return redirect(res, oauthAppRedirect('x', returnUri, { error: result.error }));
        }
        const outcome = result.value;
        if (outcome.outcome === 'link') {
          return redirect(res, oauthAppRedirect('x', returnUri, { linked: '1', handle: outcome.handle ?? '' }));
        }
        // An X account is usable the moment it exists; the prompt to bind a fallback
        // gates records, not the account.
        return redirect(res, oauthAppRedirect('x', returnUri, { code: outcome.oneTimeCode }));
      }

      if (path === '/auth/x/exchange' && req.method === 'POST') {
        const body = (await readBody(req)) as { code?: unknown } | undefined;
        const result = await AccountService.completeProviderSignIn('x', body?.code, {
          persistent: (body as { persistent?: unknown } | undefined)?.persistent === true,
        });
        if (!result.ok) return fail(res, 400, result.error);
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
        const ctx = await requireSessionCtx();
        if (!ctx) return fail(res, 401, 'authentication required');
        return send(res, 200, { sessions: await listUserSessions(ctx.userId, bearer(req) ?? null) });
      }

      if (path === '/auth/sessions/revoke' && req.method === 'POST') {
        const ctx = await requireSessionCtx();
        if (!ctx) return fail(res, 401, 'authentication required');
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
        if (ids.length === 0) return fail(res, 400, 'ids: required');
        // Revoking the caller's own session is allowed rather than refused: a client that
        // asked for it is a client that is about to drop its token anyway.
        return send(res, 200, { revoked: await revokeSessions(ctx.userId, ids) });
      }

      if (path === '/auth/account/delete' && req.method === 'POST') {
        // Rate limited like sign-in: guessing a password here is the same attack, and
        // the per-account lockout in `deleteAccount` is the other half of the pair.
        if (rateLimited(`delete:${clientIp(req)}`, getConfig().rateLimits.login, getConfig().rateLimits.windowMs)) {
          return fail(res, 429, 'too many attempts; try again shortly');
        }
        const ctx = await requireSessionCtx();
        if (!ctx) return fail(res, 401, 'authentication required');
        const body = (await readBody(req)) as
          | { password?: unknown; reason?: unknown }
          | undefined;
        const result = await AccountService.deleteAccount(ctx, body?.password, {
          reason: body?.reason,
        });
        if (!result.ok) {
          return fail(res, 400, result.error);
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
        if (!ctx) return fail(res, 401, 'authentication required');
        const counts = await RecordService.countByCategory(ctx);
        // The row type is an alias rather than an inline `query<{ ... }>` literal, which
        // Node's type-stripper mis-reads across lines as a TSX element and then fails on
        // at the first semicolon. The bundle build would not catch it; `npm test` does.
        type Counts = { x_links: string; created_at: Date; has_avatar: boolean };
        const { rows } = await getPool().query<Counts>(`
          SELECT
             (SELECT count(*) FROM oauth_accounts       WHERE user_id = $1)                      AS x_links,
             (SELECT created_at FROM users WHERE id = $1)                                     AS created_at,
             -- Whether *any* provider left a picture for the header — not X's only.
             -- The avatar_url column is the provider's own URL, which the browser is not
             -- allowed to load (see avatars.ts), so what is reported here is the image.
             (SELECT count(*) FROM oauth_accounts
               WHERE user_id = $1 AND avatar_image IS NOT NULL) > 0                          AS has_avatar`,
          [ctx.userId],
        );
        const row = rows[0];
        return send(res, 200, {
          created_at: row?.created_at?.toISOString() ?? null,
          dose_count: counts.dose ?? 0,
          lab_count: counts.lab ?? 0,
          x_links: Number(row?.x_links ?? 0),
          x_login_available: AccountService.xLoginAvailable(),
          // A path on our own origin, never the provider's URL: `img-src 'self'` is
          // what the web app is served with, so an external avatar URL would be blocked
          // by the browser even though it was stored correctly.
          //
          // This field used to be `x_avatar_url`, and it was X's URL. The name changed
          // because the value did: anyone reading it has to be able to see that it is a
          // per-account URL rather than a constant, or they will cache it and serve one
          // person's picture to another.
          avatar_url: row?.has_avatar ? avatarPath(ctx.userId) : null,
        });
      }

      // --- Auth: stored avatar ---------------------------------------------
      //
      // The image is served from the **web app's** origin rather than this one. That is
      // not a preference: the app is served with `img-src 'self' data: blob:`, so a URL
      // on the API host would be blocked by the browser, and the account header would
      // show a placeholder exactly as it does today. The bytes live in this database
      // (`avatars.ts` says why they are not on disk in the web root), so this route has
      // to exist somewhere and this is the only service that holds them. The Caddy block
      // that puts it on `PUBLIC_ORIGIN` is in DEPLOY.md §3.
      //
      // Deliberately unauthenticated, and deliberately a plain URL: an `<img src>` cannot
      // send an Authorization header. What makes that safe is that the id is an opaque
      // uuid — the picture is public in the same weak sense an avatar always is, and
      // nothing about the account is readable from it. The trade is stated in DEPLOY.md
      // because it is a real one: anyone who learns a user's id can fetch that user's
      // picture. Adding a signed per-image token would close it, at the cost of a URL
      // that changes on a schedule and therefore of a request per expiry.
      const avatarMatch = path.match(/^\/auth\/avatar\/([0-9a-f-]{36})$/);
      if (avatarMatch && req.method === 'GET') {
        // Unauthenticated by design (see above), which means it is the one account-data
        // route with no natural brake: a caller can mint ids as fast as it likes. 300
        // per minute is far more than a page of avatars costs — a browser revalidates
        // one per image and the 304 is the common case — while still bounding a host
        // that is walking the space or using us as a bandwidth amplifier.
        if (rateLimited(`avatar:${clientIp(req)}`, 300, 60_000)) {
          res.setHeader('Retry-After', '60');
          return fail(res, 429, 'too many requests; try again shortly');
        }
        // `?p=` picks one provider's picture. An unknown value is a 404 rather
        // than a silent fall back to the account's newest image, which would
        // answer a question nobody asked.
        const requested = url.searchParams.get('p');
        if (requested !== null && requested !== 'x' && requested !== 'google') {
          return fail(res, 404, 'no avatar');
        }
        const avatar = await avatarForUser(avatarMatch[1], requested ?? undefined);
        if (!avatar) return fail(res, 404, 'no avatar');

        // The id is the image's identity, so the URL can be cached; the revalidation is
        // what keeps a new picture from being shadowed by an old one, and a 304 is the
        // whole point of the scheme — it is the request that never happens. `private`
        // because this is one account's picture, and `nosniff` is already applied to
        // every response by `applyCommonHeaders`.
        const etag = avatarEtag(avatar);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304).end();
          return;
        }

        // The content type is one of png/jpeg/webp by construction — `fetchAvatarImage`
        // refuses anything else — so nothing here can be served as HTML or SVG.
        res.writeHead(200, { 'Content-Type': avatar.contentType });
        res.end(avatar.bytes);
        return;
      }

      if (path === '/auth/x/links' && req.method === 'GET') {
        const ctx = await contextFor(req);
        if (!ctx) return fail(res, 401, 'authentication required');
        const links = await AccountService.listXLinks(ctx.userId);
        return send(res, 200, { links: withProviderAvatarPaths(ctx.userId, links) });
      }

      if (path === '/auth/x/unlink' && req.method === 'POST') {
        const ctx = await requireSessionCtx();
        if (!ctx) return fail(res, 401, 'authentication required');
        const result = await AccountService.unlinkX(ctx);
        if (!result.ok) return fail(res, 400, result.error);
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
        const ctx = await requireSessionCtx();
        if (!ctx) return fail(res, 401, 'authentication required');
        const body = (await readBody(req)) as { username?: unknown; password?: unknown } | undefined;
        const result = await AccountService.bindCredentials(ctx, body?.username, body?.password, body?.current_password);
        if (!result.ok) {
          // A name another account holds is a conflict, not a bad request; the form
          // renders the two differently.
          const status = result.error === 'username_taken' ? 409 : 400;
          return fail(res, status, result.error);
        }
        return send(res, 200, { ok: true, username: result.value.username });
      }

      if (path === '/auth/login-methods' && req.method === 'GET') {
        const ctx = await contextFor(req);
        if (!ctx) return fail(res, 401, 'authentication required');
        const overview = await AccountService.loginOverview(ctx.userId);
        return send(res, 200, {
          username: overview.username,
          has_password: overview.hasPassword,
          providers: overview.providers,
          // True when losing the linked provider would lose the account.
          recovery_risk: overview.recoveryRisk,
          accounts: withProviderAvatarPaths(ctx.userId, await AccountService.listOAuthLinks(ctx.userId)),
        });
      }

      if (path.startsWith('/auth/oauth/') && path.endsWith('/unlink') && req.method === 'POST') {
        const provider = path.slice('/auth/oauth/'.length, -'/unlink'.length);
        const ctx = await contextFor(req);
        if (!ctx) return fail(res, 401, 'authentication required');
        const result = await AccountService.unlinkProvider(ctx, provider);
        if (!result.ok) return fail(res, 400, result.error);
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
          fail(res, 401, 'missing or invalid credentials, or the account is locked');
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
          // The message stays the machine token it has always been, because the
          // installed client compares `error` to it. New clients read the code.
          fail(res, 403, 'account_incomplete', {
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
        // `before` arrives either as epoch milliseconds or as an ISO instant — the app
        // pages with the `taken_at` **string** this route itself returns, while a
        // hand-written client tends to send a number. `Number('2026-09-27T…')` is NaN,
        // which used to make the cursor silently vanish (an unparsed `before` left the
        // page unfiltered, so paging returned the same first page forever). Parse as a
        // date when it is not numeric, and drop it only when it is neither.
        const before = beforeRaw === null ? undefined
          : (Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : Date.parse(beforeRaw));

        // The change cursor: `since` is the watermark the client last acknowledged,
        // `after_version`/`after_id` resume a delta that took more than one page.
        // Capture the version *before* reading — see `currentSyncVersion` — so the
        // watermark this response hands back cannot outrun the rows it contains.
        const sinceRaw = url.searchParams.get('since');
        const since = sinceRaw !== null && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : undefined;
        const afterRaw = url.searchParams.get('after_version');
        const afterVersion = afterRaw !== null && Number.isFinite(Number(afterRaw)) ? Number(afterRaw) : undefined;
        const afterId = url.searchParams.get('after_id') || undefined;
        const syncVersion = await currentSyncVersion(ctx);

        if (since !== undefined) {
          const { records, unreadable } = await RecordService.list(ctx, {
            limit: Number(url.searchParams.get('limit') ?? 1000),
            byVersion: true,
            sinceVersion: since,
            upToVersion: syncVersion,
            afterVersion,
            afterId,
          });
          // Settings ride with the first delta page of each sync, for the same reason
          // they ride with the first page of a full read: a settings route or an agent
          // writes the settings table, which is not a record and so has no change row.
          const settings = afterVersion === undefined ? await buildSettingsScalars(ctx) : undefined;
          return send(res, 200, {
            records: records.map((r) => ({
              id: r.id,
              taken_at: new Date(r.takenAt).toISOString(),
              category: r.category,
              data: r.data,
              updated_at: new Date(r.updatedAt).toISOString(),
              // The page cursor for a delta longer than one response.
              sync_version: r.syncVersion,
            })),
            unreadable,
            syncVersion,
            ...(settings ? { settings } : {}),
          });
        }

        const { records, unreadable } = await RecordService.list(ctx, {
          limit: Number(url.searchParams.get('limit') ?? 200),
          category: url.searchParams.get('category') ?? undefined,
          before: Number.isFinite(before as number) ? (before as number) : undefined,
          // The tiebreaker, so the app's own paging resumes inside a group of records
          // that share one instant instead of skipping past them — see `ListOptions`.
          beforeId: url.searchParams.get('before_id') || undefined,
        });
        // The settings row is where a settings route or an agent writes, and it is
        // not a record — so it rides with the read the app already makes rather
        // than needing a second one. Only on the first page: the reader pages
        // through records, and repeating a scalar on every page would be the only
        // thing that grows with the history.
        const settings = before === undefined ? await buildSettingsScalars(ctx) : undefined;
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
          syncVersion,
          ...(settings ? { settings } : {}),
        });
      }

      if (path === '/api/records' && req.method === 'POST') {
        const ctx = await requireBoundCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as Record<string, unknown> | undefined;
        const result = await RecordService.put(ctx, body ?? {});
        if (!result.ok) return fail(res, 400, result.error);
        return send(res, 201, { id: result.id });
      }

      // The batch form of the same write. It exists so a sync costs one round trip
      // rather than one per record. The body is a whole history, so the route's own
      // cap is well above the default; the per-record size check still applies inside
      // `putMany`. By default the account's state comes back with the result, so a
      // caller does not have to fetch what it just stored — unless it says
      // `echoState: false`, which the incremental sync does because it merged against
      // its own read and reassembly decrypts every row the account owns.
      if (path === '/api/records/batch' && req.method === 'POST') {
        const ctx = await requireBoundCtx();
        if (!ctx) return;
        const body = (await readBody(req, 8_000_000)) as
          { records?: unknown; echoState?: unknown } | undefined;
        const result = await RecordService.putMany(ctx, body?.records);
        if (!result.ok) return fail(res, 400, result.error);
        if (body?.echoState === false) {
          return send(res, 200, { written: result.written, rejected: result.rejected });
        }
        // Reassembly reads every row again; if it throws after a write that already
        // committed, the write result is still true, so the state is omitted rather
        // than turning a successful write into a failure.
        let state: unknown = null;
        try {
          state = await buildExportPayload(ctx);
        } catch {
          state = null;
        }
        return send(res, 200, { written: result.written, rejected: result.rejected, state });
      }

      const recordMatch = path.match(/^\/api\/records\/([^/]+)$/);
      if (recordMatch) {
        const ctx = await requireBoundCtx();
        if (!ctx) return;
        const id = decodeURIComponent(recordMatch[1]);
        if (req.method === 'DELETE') {
          const removed = await RecordService.remove(ctx, id);
          // `removed` stays in the body on both answers: it is the route's own
          // statement about what happened, not part of the error envelope.
          return removed
            ? send(res, 200, { removed })
            : fail(res, 404, 'no such record', { removed });
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
        if (!result.ok) return fail(res, 400, result.error);
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
        const ctx = await requireSessionCtx();
        if (!ctx) return;
        return send(res, 200, { tokens: await AccountService.listApiTokens(ctx.userId) });
      }
      if (path === '/api/tokens' && req.method === 'POST') {
        const ctx = await requireSessionCtx();
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
        const ctx = await requireSessionCtx();
        if (!ctx) return;
        const removed = await AccountService.revokeApiToken(ctx.userId, tokenRevoke[1]);
        if (!removed) return fail(res, 404, 'no such token');
        return send(res, 200, { ok: true });
      }
      // Rename a token. The name is a label with no security meaning, so it is the
      // one thing about an issued credential the user can still change after the
      // plaintext is gone.
      if (tokenRevoke && req.method === 'PATCH') {
        const ctx = await requireSessionCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as { name?: unknown } | undefined;
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (name === '' || name.length > 64) return fail(res, 400, 'a name between 1 and 64 characters is required');
        const renamed = await AccountService.renameApiToken(ctx.userId, tokenRevoke[1], name);
        if (!renamed) return fail(res, 404, 'no such token');
        return send(res, 200, { ok: true, name });
      }

      // --- Push (FCM supplementary) ----------------------------------------
      //
      // A device binds its FCM token here after the user enables notifications; the
      // server then has somewhere to send a catch-up nudge. The token is the address
      // FCM delivers to, so it is scoped to the account and removed on sign-out (or
      // when FCM reports it dead during a scan). `requireCtx` — not `requireBoundCtx`
      // — because a device that can sign in should be able to register for push even
      // before it has bound fallback credentials.
      if (path === '/api/push/register' && req.method === 'POST') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as { token?: unknown; platform?: unknown } | undefined;
        const token = typeof body?.token === 'string' ? body.token.trim() : '';
        if (token === '' || token.length > 4096) return fail(res, 400, 'a device token is required');
        const platform = typeof body?.platform === 'string' && body.platform.trim() !== ''
          ? body.platform.trim().slice(0, 32)
          : 'android';
        await PushStore.register(ctx.userId, token, platform);
        return send(res, 200, { ok: true });
      }
      if (path === '/api/push/unregister' && req.method === 'POST') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as { token?: unknown } | undefined;
        const token = typeof body?.token === 'string' ? body.token.trim() : '';
        if (token === '') return fail(res, 400, 'a device token is required');
        await PushStore.unregister(ctx.userId, token);
        return send(res, 200, { ok: true });
      }

      // --- Shares ----------------------------------------------------------
      //
      // `/api/shares/access` is the one route here that answers without a session: a
      // share link exists precisely so someone without an account can read it. Its
      // authorization is the token in the body, and the response is `publicView` — no
      // id, no owner, no hash.
      //
      // It is rate-limited by IP with headroom for live-polling (60/min), while brute-force
      // password guessing is prevented by link-scoped exponential lockout on the share row.
      if (path === '/api/shares/access' && req.method === 'POST') {
        const limits = getConfig().rateLimits;
        if (rateLimited(`share:${clientIp(req)}`, limits.login, limits.windowMs)) {
          return fail(res, 429, 'too many attempts; try again shortly');
        }
        const body = (await readBody(req, 16_384)) as
          | { token?: unknown; password?: unknown; viewerPass?: unknown }
          | undefined;
        const result = await ShareService.access(body?.token, body?.password, body?.viewerPass);
        if (!result.ok) {
          if (result.error === 'locked') {
            const retryAfter = (result as { retryAfterSeconds?: number }).retryAfterSeconds ?? 900;
            res.setHeader('Retry-After', String(retryAfter));
            return fail(res, 429, 'too many wrong passwords; share is temporarily locked', {
              code: 'SHARE_LOCKED',
              retryAfterSeconds: retryAfter,
            });
          }
          // The code, not the status, is what the client switches on — it already has
          // copy for each of these. `SHARE_NOT_FOUND` covers both a token that never
          // existed and one that has expired, which is the pair a prober could otherwise
          // use to discover which links are real.
          const codes: Record<string, [number, ApiCode]> = {
            password_required: [401, 'PASSWORD_REQUIRED'],
            invalid_password: [401, 'INVALID_PASSWORD'],
            expired: [410, 'SHARE_EXPIRED'],
            'not found': [404, 'SHARE_NOT_FOUND'],
          };
          const [status, code] = codes[result.error] ?? [404, 'SHARE_NOT_FOUND'];
          return fail(res, status, result.error, {
            code,
            ...(code === 'PASSWORD_REQUIRED' ? { passwordRequired: true } : {}),
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
          | { snapshot?: unknown; sealed?: unknown; mode?: unknown; password?: unknown; expiresAt?: unknown; live?: unknown }
          | undefined;
        const result = await ShareService.create(ctx.userId, {
          snapshot: body?.snapshot,
          sealed: body?.sealed,
          mode: body?.mode,
          password: body?.password,
          expiresAt: body?.expiresAt,
          live: body?.live,
        });
        if (!result.ok) return fail(res, 400, result.error, { code: 'SHARE_REJECTED' });
        return send(res, 201, result.value);
      }

      if (path === '/api/shares/live' && req.method === 'PUT') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const body = (await readBody(req)) as
          | { shareId?: unknown; sealed?: unknown; mode?: unknown; snapshot?: unknown }
          | undefined;
        const result = await ShareService.syncLive(ctx.userId, {
          shareId: body?.shareId,
          sealed: body?.sealed,
          mode: body?.mode,
          snapshot: body?.snapshot,
        });
        if (!result.ok) return fail(res, 400, result.error, { code: 'SHARE_REJECTED' });
        return send(res, 200, result.value);
      }

      const shareRevoke = path.match(/^\/api\/shares\/([0-9a-f-]{36})$/);
      if (shareRevoke && req.method === 'DELETE') {
        const ctx = await requireCtx();
        if (!ctx) return;
        const removed = await ShareService.revoke(ctx.userId, shareRevoke[1]);
        if (!removed) return fail(res, 404, 'no such share');
        return send(res, 200, { ok: true });
      }

      // --- Supporters -------------------------------------------------------
      //
      // `/api/supporters` and `/api/supporters/apply` are public on purpose: the
      // thank-you list sits on the donation page, before anyone has an account.
      // The webhook is public too, but authenticated by its HMAC rather than by
      // anything a caller can replay.
      if (path === '/api/supporters' && req.method === 'GET') {
        const supporters = await listApproved();
        // A minute of caching keeps the donation page from hitting the database on
        // every view without making a new supporter invisible for long.
        res.setHeader('Cache-Control', 'public, max-age=60');
        return send(res, 200, { supporters });
      }

      if (path === '/api/supporters/apply' && req.method === 'POST') {
        const ip = clientIp(req);
        // Two gates: a burst limit, then an hourly one. Each attempt can fan out to
        // four RPC endpoints, so a single script must not be able to spend the shared
        // chain-verification budget.
        if (rateLimited(`supporters-burst:${ip}`, 3, 60_000)
          || rateLimited(`supporters:${ip}`, 10, 3_600_000)) {
          return fail(res, 429, 'too many applications; try again later', { code: 'RATE_LIMITED' });
        }
        const body = (await readBody(req, 8_192)) as
          | { txHash?: unknown; name?: unknown; turnstileToken?: unknown }
          | undefined;

        // Human check before any outbound chain call: Turnstile is configured in
        // production, and a bot should not be able to spend the RPC budget.
        const human = await verifyTurnstile(body?.turnstileToken, 'donate', ip);
        if (!human.ok) {
          return fail(res, 403, human.error, { code: 'TURNSTILE' });
        }

        const result = await applySupporter(body?.txHash, body?.name);
        if (!result.ok) {
          const status = result.code === 'duplicate_tx'
            ? 409
            : result.code === 'verify_unavailable'
              ? 503
              : result.code === 'invalid_name' || result.code === 'invalid_tx_hash'
                ? 400
                : 422;
          return fail(res, status, result.message, {
            code: SUPPORTER_CODES[result.code] ?? 'INVALID_REQUEST',
          });
        }
        return send(res, 201, result);
      }

      // A browser GET on a webhook URL is a common way to "test" it. Answer with the
      // actual reason instead of the generic 404, which reads like the route is missing.
      if ((path === '/api/supporters/bmc' || path === '/api/supporters/afdian') && req.method !== 'POST') {
        return fail(res, 405, 'method not allowed; webhooks are POST only');
      }

      if (path === '/api/supporters/bmc' && req.method === 'POST') {
        const secret = getConfig().bmcWebhookSecret ?? null;
        // No secret means the deployment has not finished setting the webhook up.
        // Refusing is the only safe answer: accepting unsigned deliveries would let
        // anyone write a name onto the public list.
        if (!secret) return fail(res, 503, 'webhook not configured');

        const raw = await readRawBody(req, 64_000);
        const header = req.headers['x-signature-sha256'];
        const signature = Array.isArray(header) ? header[0] : header;
        if (!bmcSignatureMatches(raw, signature, secret)) {
          return fail(res, 401, 'invalid signature');
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          return fail(res, 400, 'body is not JSON');
        }

        const type = typeof event.type === 'string' ? event.type : '';
        const data = (event.data ?? {}) as Record<string, unknown>;
        const paymentId = data.id === undefined || data.id === null ? '' : String(data.id);
        // Payment ids and subscription ids are separate integer sequences, so the
        // stored key is prefixed. Without it a payment and a subscription that share
        // a number would overwrite or delete each other.
        const paymentKey = paymentId ? `pay:${paymentId}` : '';
        const subscriptionKey = paymentId ? `sub:${paymentId}` : '';

        // The dashboard labels these "Support created" / "Support refunded", while
        // the documented wire values (OpenAPI `EventType`) are `donation.*`. Both
        // spellings are accepted so a label/wire rename on either side cannot make
        // a real donation silently disappear.
        const created = type === 'donation.created' || type === 'support.created';
        const refunded = type === 'donation.refunded' || type === 'support.refunded';
        const subscriptionStarted = type === 'membership.started' || type === 'recurring_donation.started';
        const subscriptionUpdated = type === 'membership.updated' || type === 'recurring_donation.updated';
        const subscriptionCancelled = type === 'membership.cancelled' || type === 'recurring_donation.cancelled';

        // A dashboard test delivery is acknowledged so the dashboard shows success,
        // but never written: `live_mode: false` means no money moved.
        if (event.live_mode !== true) return send(res, 200, { ok: true, ignored: 'test' });

        if (created) {
          if (data.status !== 'succeeded') return send(res, 200, { ok: true, ignored: 'status' });
          const name = cleanBmcName(data.supporter_name);
          // An anonymous donation has no name to thank. Skipping it is also the
          // privacy-preserving default: the provider can supply a name the donor
          // did not intend to publish.
          if (!name || !paymentKey) return send(res, 200, { ok: true, ignored: 'anonymous' });
          await acceptBmcDonation({ name, paymentKey });
          return send(res, 200, { ok: true });
        }

        if (refunded) {
          if (paymentKey) await removeBmcRecord(paymentKey);
          return send(res, 200, { ok: true });
        }

        // A monthly support is a subscription, not a one-time payment: it arrives as
        // `membership.*` or `recurring_donation.*`. Ignoring these was the difference
        // between a monthly supporter appearing on the list and never appearing.
        if (subscriptionStarted || subscriptionUpdated) {
          const name = cleanBmcName(data.supporter_name);
          if (!name || !subscriptionKey) return send(res, 200, { ok: true, ignored: 'anonymous' });
          await acceptBmcSubscription({ name, subscriptionKey });
          return send(res, 200, { ok: true });
        }

        // Cancelled means the subscription has actually ended. Paused is deliberately
        // not handled: a paused supporter is still a supporter and may resume.
        if (subscriptionCancelled) {
          if (subscriptionKey) await removeBmcRecord(subscriptionKey);
          return send(res, 200, { ok: true });
        }

        // Every other event is acknowledged: a non-2xx makes BMC retry, and retrying
        // an event this service never intended to handle is noise.
        return send(res, 200, { ok: true, ignored: type || 'unknown' });
      }

      // Afdian's webhook. It has no shared secret: every delivery is signed with
      // Afdian's RSA key over the order's four identifying fields. The order object
      // carries no display name, so a verified order is queued as `pending` for the
      // maintainer to name and approve.
      if (path === '/api/supporters/afdian' && req.method === 'POST') {
        let body: unknown;
        try {
          body = await readBody(req, 64_000);
        } catch {
          return send(res, 200, { ec: 400003, em: 'params was not valid json string' });
        }
        const data = (body as { data?: Record<string, unknown> } | undefined)?.data;
        // Afdian expects this envelope, not a bare object: a response without
        // `ec: 200` is treated as a failed callback and retried.
        if (!data || typeof data !== 'object') return send(res, 200, { ec: 200, em: '' });
        const order = data.order as Record<string, unknown> | undefined;
        if (data.type !== 'order' || !order) return send(res, 200, { ec: 200, em: '' });
        if (Number(order.status) !== 2) return send(res, 200, { ec: 200, em: '' });

        const fields = {
          outTradeNo: String(order.out_trade_no ?? ''),
          userId: String(order.user_id ?? ''),
          planId: String(order.plan_id ?? ''),
          totalAmount: String(order.total_amount ?? ''),
        };
        const publicKey = getConfig().afdianPublicKey ?? undefined;
        if (!fields.outTradeNo || !afdianSignatureMatches(fields, String(data.sign ?? ''), publicKey)) {
          return send(res, 200, { ec: 400005, em: 'sign validation failed' });
        }

        // The order has a user id, not a name. When the Open API is configured this
        // resolves the nickname and publishes immediately; otherwise the row waits
        // for the maintainer.
        const name = await resolveAfdianSponsorName(fields.userId);
        await acceptAfdianOrder(fields.outTradeNo, name);
        return send(res, 200, { ec: 200, em: '' });
      }

      // Maintainer surface. Token-only, no session: it is called from a shell, not
      // from a browser, and a missing token means the feature is off.
      if (path.startsWith('/api/supporters/admin')) {
        const token = getConfig().supportersAdminToken ?? null;
        if (!token) return fail(res, 404, 'not found');
        if (!adminTokenMatches(req.headers.authorization, token)) {
          return fail(res, 401, 'unauthorized');
        }

        if (path === '/api/supporters/admin/pending' && req.method === 'GET') {
          return send(res, 200, { pending: await listPending() });
        }

        const approveMatch = path.match(/^\/api\/supporters\/admin\/([0-9a-f-]{36})\/approve$/);
        if (approveMatch && req.method === 'POST') {
          const approved = await approveSupporter(approveMatch[1]);
          return approved
            ? send(res, 200, { ok: true })
            : fail(res, 404, 'no such pending supporter');
        }

        // Afdian orders arrive without a name and BMC names can be hostile; this is
        // how a row is given the name that will actually be published.
        const renameMatch = path.match(/^\/api\/supporters\/admin\/([0-9a-f-]{36})$/);
        if (renameMatch && req.method === 'PATCH') {
          const body = (await readBody(req, 4_096)) as { name?: unknown } | undefined;
          const renamed = await renameSupporter(renameMatch[1], body?.name);
          if (!renamed.ok) {
            return fail(res, renamed.error === 'not_found' ? 404 : 400, renamed.message, {
              code: SUPPORTER_CODES[renamed.error] ?? 'INVALID_REQUEST',
            });
          }
          return send(res, 200, { ok: true, name: renamed.name });
        }

        const removeMatch = path.match(/^\/api\/supporters\/admin\/([0-9a-f-]{36})$/);
        if (removeMatch && req.method === 'DELETE') {
          const removed = await removeSupporter(removeMatch[1]);
          return removed
            ? send(res, 200, { ok: true })
            : fail(res, 404, 'no such supporter');
        }

        return fail(res, 404, 'not found');
      }

      fail(res, 404, 'not found');
    } catch (error) {
      // Log the whole thing, answer with nothing. A thrown driver or DNS error
      // carries hostnames, database names and query fragments — useful to us,
      // reconnaissance to a caller. The audit's example was a malformed uuid that
      // reached Postgres and echoed "invalid input syntax for type uuid" back.
      console.error('[hrt] unhandled request error:', error);
      if (!res.headersSent) fail(res, 500, 'internal error');
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
