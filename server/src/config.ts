/**
 * Configuration, validated at boot.
 *
 * Two origins rather than one, because the site and the API are deliberately on
 * different hosts (`hrt.` and `api.`): the web app is static files behind a CDN or
 * the reverse proxy, while the API is a stateful process. Splitting them means a
 * cache or a compromise on the static side cannot reach the data plane.
 *
 * Everything here is read once and checked once. A misconfigured origin is the
 * kind of mistake that silently breaks CORS in production and works locally (or
 * vice versa), so the checks are loud and happen before the server listens rather
 * than on the first request that needs the value.
 */

import { isIP } from 'node:net';
import { keyFromEnv } from './payloadCrypto.ts';

export interface XOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match the app's Callback URI byte for byte. */
  redirectUri: string;
}

/**
 * A configured social provider, named so the callback knows which one it is serving.
 *
 * `X` and `Google` differ in more than their endpoints — Google returns identity inside
 * the ID token rather than at a profile endpoint, and needs no PKCE — so the name
 * travels with the config instead of being inferred from which variable was set.
 */
export interface ProviderOAuthConfig extends XOAuthConfig {
  provider: 'x' | 'google';
}

export interface TurnstileConfig {
  secret: string;
  /** Hostnames the widget is served from. Verified against the siteverify reply. */
  hostnames: string[];
}

export interface WebAuthnConfig {
  /** The registrable domain a credential is scoped to, e.g. `kiramyao.com`. */
  rpId: string;
  /** Shown in the OS passkey prompt. */
  rpName: string;
  /**
   * Every origin a ceremony may legitimately happen on.
   *
   * Both hosts, because the browser page is on `hrt.` while the API it calls is on
   * `api.` — a discoverable sign-in starts on the page, and the registration that
   * created the credential may have been started from either. Assertions are checked
   * against this list, so leaving a host out is a lockout rather than a weakening.
   */
  origins: string[];
}

export interface Config {
  /** Where the web app lives. Used for the CORS allowlist and OAuth bounce targets. */
  publicOrigin: string;
  /** This server's own public origin — the OAuth callback host. */
  apiOrigin: string;
  /**
   * Path prefix this service is mounted under, e.g. `/hrt`.
   *
   * The API host is shared: `api.kiramyao.com` already serves the comment API at
   * `/comments/*`, and the convention there is one prefix per service. Without a
   * prefix, `/auth/x/callback` would collide with the sibling service's own OAuth
   * callback — and both are OAuth callbacks, so the collision would not fail
   * loudly, it would silently send one service's codes to the other.
   *
   * Empty means mounted at the root, which is what tests and a dedicated host use.
   * The prefix is also folded into the default X redirect URI, because X compares
   * the callback byte for byte.
   */
  basePath: string;
  /** The public URL of this service, prefix included: `${apiOrigin}${basePath}`. */
  apiBaseUrl: string;
  port: number;
  databaseUrl: string;
  /**
   * Encrypts TOTP secrets at rest. TOTP is a second factor, so a database dump
   * that carries the secrets in the clear silently removes that factor for every
   * account — the same class of failure as storing passwords unsalted.
   */
  totpEncKey: string;
  /** Absent until the X app is registered; X login is then reported as unconfigured. */
  x: XOAuthConfig | null;
  /**
   * Google sign-in. Null until the OAuth client is configured, and the app then
   * reports Google as unconfigured rather than offering a button that cannot work.
   *
   * Requests only the `openid` scope. That is enough because identity comes from the
   * ID token's `sub` claim, which Google marks as always present and never reused —
   * so no email, no name, no picture, and no second call to the userinfo endpoint.
   */
  google: XOAuthConfig | null;
  /**
   * The key the standard-mode `server` wrapper is wrapped under.
   *
   * Optional so a self-hosted instance can run advanced-only, and so the test
   * suite does not have to carry every field. But its presence *is* the standard
   * mode's promise ("the server can recover your data"), so production refuses to
   * start without it rather than silently degrading: an instance that let people
   * choose Standard and then could not recover them would be lying.
   */
  serverDekKey: string | null;
  /**
   * The master key for record payloads, or null outside production.
   *
   * Not end-to-end encryption: the server decrypts on read. What it buys is that a
   * stolen database dump is useless on its own. `null` means no record can be written,
   * which is why production requires it rather than degrading silently.
   */
  encryptionKey: Buffer | null;
  /** Human-verification on the register and X-setup entry points. Absent = off. */
  turnstile: TurnstileConfig | null;
  /**
   * WebAuthn relying party. Absent = passkeys disabled (no button, no routes).
   *
   * Derived from the origins rather than configured separately where possible: the
   * RP ID must be a registrable domain that *suffixes* both the site and the API host,
   * or a credential created on one cannot be asserted to the other. `kiramyao.com`
   * covers `hrt.` and `api.` at once, which is why this works at all on a split
   * deployment — a credential is scoped to the domain, not the host.
   */
  webauthn: WebAuthnConfig | null;
  /** Tokens live this long without use. */
  sessionTtlMinutes: number;
  /**
   * Per-IP request budgets for the credential endpoints.
   *
   * Configurable because the right value is deployment-specific, not universal:
   * a household behind one NAT address shares an IP, so the same limit that suits
   * a single user is too tight for a family or a corporate network. The defaults
   * are conservative; raise them when legitimate users hit them.
   */
  rateLimits: RateLimitConfig;
}

export interface RateLimitConfig {
  /** Registration attempts per IP per window. */
  register: number;
  /** Sign-in attempts per IP per window. */
  login: number;
  /** Enrolment-resume attempts per IP per window. */
  resume: number;
  /** Window length in milliseconds, shared by all three. */
  windowMs: number;
}

const MIN_SECRET_LENGTH = 32;

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Require an absolute http(s) origin with no trailing slash.
 *
 * Normalised here so every comparison downstream (CORS allowlist, redirect
 * building) can be a plain string equality rather than a regex that has to
 * remember whether a trailing slash was tolerated.
 */
function requireOrigin(raw: string | undefined, name: string): string {
  if (!raw) throw new ConfigError(`${name} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL (got ${JSON.stringify(raw)})`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${name} must use http or https`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError(`${name} must be a bare origin, e.g. https://example.com (got ${raw})`);
  }
  return url.origin;
}

function requireSecret(raw: string | undefined, name: string): string {
  if (!raw) throw new ConfigError(`${name} is required`);
  if (raw.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return raw;
}

/**
 * Common second-level labels that are themselves a public suffix.
 *
 * `ponytail:` a small known list, not the full Public Suffix List — pulling in a PSL
 * dependency to derive one string would be the larger change, and the failure mode is
 * benign at this scale: a wrong guess produces an RP ID that does not suffix the host,
 * which the caller's check rejects loudly at boot rather than silently at the OS
 * prompt. Add an entry when a deployment on a new ccTLD is configured, or override
 * the derivation entirely with `WEBAUTHN_RP_ID`.
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp', 'com.cn',
  'net.cn', 'org.cn', 'gov.cn', 'com.tw', 'org.tw', 'co.kr', 'or.kr', 'com.au',
  'com.br', 'com.hk', 'com.sg',
]);

/**
 * The registrable domain an origin's credential should be scoped to.
 *
 * A passkey is bound to a domain, not a host, which is what lets one created on
 * `hrt.example.com` be asserted from `api.example.com`. Returns the host unchanged
 * for `localhost` and for an IP literal, where there is nothing to strip.
 */
function registrableDomain(origin: string): string {
  const host = new URL(origin).hostname.toLowerCase();
  if (host === 'localhost' || isIP(host) !== 0) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * Load configuration from the environment.
 *
 * `allowInsecureHttp` exists for local development, where the app is served over
 * plain http on localhost. Production values are https, and a plain-http public
 * origin in production would put unlock tokens on the wire in the clear — so it
 * is an explicit opt-in rather than an inferred allowance.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicOrigin = requireOrigin(env.PUBLIC_ORIGIN ?? env.VITE_PUBLIC_ORIGIN, 'PUBLIC_ORIGIN');
  const apiOrigin = requireOrigin(env.API_ORIGIN, 'API_ORIGIN');

  const isLocal = (origin: string) =>
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.startsWith('http://[::1]');

  if (env.NODE_ENV === 'production' && !isLocal(publicOrigin) && publicOrigin.startsWith('http://')) {
    throw new ConfigError('PUBLIC_ORIGIN must be https in production');
  }
  if (env.NODE_ENV === 'production' && !isLocal(apiOrigin) && apiOrigin.startsWith('http://')) {
    throw new ConfigError('API_ORIGIN must be https in production');
  }

  // Normalised to either '' or '/segment' — leading slash, no trailing slash — so
  // every comparison downstream is a plain prefix test rather than a regex that has
  // to remember which forms were tolerated.
  const basePath = (() => {
    const raw = env.BASE_PATH?.trim() ?? '';
    if (!raw || raw === '/') return '';
    const trimmed = raw.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(trimmed)) {
      throw new ConfigError(
        `BASE_PATH must be a plain path like /hrt (got ${JSON.stringify(raw)})`,
      );
    }
    // `.` and `..` pass the character class above, so they need refusing on their
    // own. A `..` segment would make the prefix match paths outside itself after any
    // normalisation — and the whole point of the prefix is that this service stays
    // inside its own subtree of a shared host.
    for (const segment of trimmed.split('/')) {
      if (segment === '.' || segment === '..') {
        throw new ConfigError(
          `BASE_PATH must not contain "." or ".." segments (got ${JSON.stringify(raw)})`,
        );
      }
    }
    return `/${trimmed}`;
  })();

  const port = Number(env.PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be 1–65535 (got ${env.PORT})`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');

  const totpEncKey = requireSecret(env.TOTP_ENC_KEY, 'TOTP_ENC_KEY');

  // X is optional as a whole: an instance with no X app configured runs purely on
  // password + TOTP. Half-configured is the failure worth catching, so if any of
  // the three is present all three must be.
  const xClientId = env.X_CLIENT_ID?.trim();
  const xClientSecret = env.X_CLIENT_SECRET?.trim();
  const xRedirect = env.X_REDIRECT_URI?.trim();
  let x: XOAuthConfig | null = null;
  if (xClientId || xClientSecret || xRedirect) {
    if (!xClientId) throw new ConfigError('X_CLIENT_ID is required when X login is configured');
    if (!xClientSecret) throw new ConfigError('X_CLIENT_SECRET is required when X login is configured');
    // The prefix is part of the callback, and X compares it byte for byte.
    const redirectUri = xRedirect ?? `${apiOrigin}${basePath}/auth/x/callback`;
    const redirectUrl = new URL(redirectUri);
    if (redirectUrl.protocol !== 'https:' && !isLocal(redirectUrl.origin)) {
      throw new ConfigError('X_REDIRECT_URI must be https (X rejects http callbacks outside localhost)');
    }
    x = { clientId: xClientId, clientSecret: xClientSecret, redirectUri };
  }

  // Google is optional on the same terms, and half-configured is refused the same way.
  // No PKCE here: Google's web client authenticates with the secret, and asking for a
  // verifier it does not require would be a parameter to keep correct for no gain.
  const gClientId = env.GOOGLE_CLIENT_ID?.trim();
  const gClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const gRedirect = env.GOOGLE_REDIRECT_URI?.trim();
  let google: XOAuthConfig | null = null;
  if (gClientId || gClientSecret || gRedirect) {
    if (!gClientId) throw new ConfigError('GOOGLE_CLIENT_ID is required when Google login is configured');
    if (!gClientSecret) throw new ConfigError('GOOGLE_CLIENT_SECRET is required when Google login is configured');
    // Google matches the redirect URI exactly, including scheme, case and any trailing
    // slash, so the value must be the one registered in the Cloud Console.
    const redirectUri = gRedirect ?? `${apiOrigin}${basePath}/auth/google/callback`;
    const redirectUrl = new URL(redirectUri);
    if (redirectUrl.protocol !== 'https:' && !isLocal(redirectUrl.origin)) {
      throw new ConfigError('GOOGLE_REDIRECT_URI must be https (Google allows http only for localhost)');
    }
    google = { clientId: gClientId, clientSecret: gClientSecret, redirectUri };
  }

  // The standard-mode server key. Optional generally, required in production —
  // see the interface comment. 32 bytes is the floor, same as TOTP_ENC_KEY.
  const serverDekKeyRaw = env.SERVER_DEK_KEY?.trim();
  const serverDekKey = serverDekKeyRaw ? serverDekKeyRaw : null;
  if (serverDekKey && serverDekKey.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`SERVER_DEK_KEY must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (env.NODE_ENV === 'production' && !serverDekKey) {
    throw new ConfigError(
      'SERVER_DEK_KEY is required in production: standard-mode accounts rely on it for ' +
        'recovery. Set it to 32+ random characters, or run advanced-only.',
    );
  }

  // The record-payload key. Required in production: every business field is stored as
  // one AES-256-GCM blob under this key, so a deployment without it cannot store a
  // single record. Validated here rather than at the first write so a bad paste fails
  // at startup, where it is obvious, instead of as "nothing saves".
  //
  // Note this is NOT end-to-end encryption: the server decrypts on read. The guarantee
  // is "a database dump is useless without this key", nothing stronger.
  const encryptionKeyRaw = env.ENCRYPTION_KEY?.trim();
  if (env.NODE_ENV === 'production' && !encryptionKeyRaw) {
    throw new ConfigError(
      'ENCRYPTION_KEY is required in production: record payloads are encrypted under it. '
      + 'Generate one with: openssl rand -base64 32',
    );
  }
  const encryptionKey = encryptionKeyRaw
    ? (() => {
      // Delegated to the crypto module so the format rules live in one place: this is
      // the same function the check script exercises, not a second parser that could
      // accept a key the cipher would then refuse.
      try {
        return keyFromEnv(encryptionKeyRaw);
      } catch (error) {
        throw new ConfigError(`ENCRYPTION_KEY is invalid: ${(error as Error).message}`);
      }
    })()
    : null;

  // Turnstile is optional as a unit. Half-configured is the failure worth catching:
  // a secret with no hostname allowlist would accept a token minted on any site.
  const turnstileSecret = env.TURNSTILE_SECRET?.trim();
  const turnstileHostsRaw = env.TURNSTILE_HOSTNAMES?.trim();
  let turnstile: TurnstileConfig | null = null;
  if (turnstileSecret || turnstileHostsRaw) {
    if (!turnstileSecret) throw new ConfigError('TURNSTILE_SECRET is required when TURNSTILE_HOSTNAMES is set');
    if (!turnstileHostsRaw) throw new ConfigError('TURNSTILE_HOSTNAMES is required when TURNSTILE_SECRET is set');
    const hostnames = turnstileHostsRaw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (hostnames.length === 0) throw new ConfigError('TURNSTILE_HOSTNAMES must list at least one hostname');
    turnstile = { secret: turnstileSecret, hostnames };
  }

  // WebAuthn. On by default wherever the origins share a registrable domain, because
  // the RP ID can be derived correctly and a misconfigured RP ID is the kind of
  // mistake that only shows up as "the passkey does not work on this device".
  // WEBAUTHN_RP_ID overrides the derivation for an unusual deployment.
  const webauthnEnabled = env.WEBAUTHN_ENABLED !== 'false';
  let webauthn: WebAuthnConfig | null = null;
  if (webauthnEnabled) {
    const origins = [publicOrigin, apiOrigin];
    const rpId = env.WEBAUTHN_RP_ID?.trim() || registrableDomain(apiOrigin);
    if (!rpId) {
      webauthn = null;
    } else {
      // An RP ID that does not suffix an origin means no credential made on that
      // origin could ever be used — refuse loudly rather than offering a button that
      // fails at the OS prompt.
      for (const origin of origins) {
        const host = new URL(origin).hostname;
        if (host !== rpId && !host.endsWith(`.${rpId}`)) {
          throw new ConfigError(
            `WEBAUTHN_RP_ID (${rpId}) must be a suffix of the host ${host}; ` +
              'a credential scoped to it could not be used on that origin',
          );
        }
      }
      webauthn = { rpId, rpName: env.WEBAUTHN_RP_NAME?.trim() || 'Kira Tracker', origins };
    }
  }

  const sessionTtlMinutes = Number(env.SESSION_TTL_MINUTES ?? 30);
  if (!Number.isFinite(sessionTtlMinutes) || sessionTtlMinutes <= 0) {
    throw new ConfigError('SESSION_TTL_MINUTES must be a positive number');
  }

  const positiveInt = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(`${name} must be a positive integer (got ${raw})`);
    }
    return value;
  };

  const rateLimits: RateLimitConfig = {
    register: positiveInt(env.RATE_LIMIT_REGISTER, 5, 'RATE_LIMIT_REGISTER'),
    login: positiveInt(env.RATE_LIMIT_LOGIN, 10, 'RATE_LIMIT_LOGIN'),
    resume: positiveInt(env.RATE_LIMIT_RESUME, 5, 'RATE_LIMIT_RESUME'),
    windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS'),
  };

  return {
    publicOrigin,
    apiOrigin,
    basePath,
    apiBaseUrl: `${apiOrigin}${basePath}`,
    port,
    databaseUrl,
    totpEncKey,
    x,
    google,
    serverDekKey,
    turnstile,
    webauthn,
    sessionTtlMinutes,
    encryptionKey,
    rateLimits,
  };
}

let cached: Config | null = null;

/** Process-wide config. Throws on first use if the environment is unusable. */
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam: install a config without going through the environment. */
export function setConfigForTesting(config: Config): void {
  cached = config;
}

export { ConfigError };
