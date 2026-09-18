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

export interface XOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match the X app's Callback URI byte for byte. */
  redirectUri: string;
}

export interface TurnstileConfig {
  secret: string;
  /** Hostnames the widget is served from. Verified against the siteverify reply. */
  hostnames: string[];
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
   * The key the standard-mode `server` wrapper is wrapped under.
   *
   * Optional so a self-hosted instance can run advanced-only, and so the test
   * suite does not have to carry every field. But its presence *is* the standard
   * mode's promise ("the server can recover your data"), so production refuses to
   * start without it rather than silently degrading: an instance that let people
   * choose Standard and then could not recover them would be lying.
   */
  serverDekKey: string | null;
  /** Human-verification on the register and X-setup entry points. Absent = off. */
  turnstile: TurnstileConfig | null;
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
    serverDekKey,
    turnstile,
    sessionTtlMinutes,
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
