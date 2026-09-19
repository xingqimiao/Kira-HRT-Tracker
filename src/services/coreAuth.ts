/**
 * Client for the Application Core's authentication API.
 *
 * Separate from `services/auth.ts`, which speaks to the legacy Worker API
 * (session list, admin). The Core has a different model — a password, and a data
 * key the server unwraps per session — so mixing the two into one module would hide
 * which backend each call reaches, and they are reached at different origins.
 *
 * Paths here are relative to the service mount (`VITE_API_ORIGIN` already includes
 * the `/hrt` prefix in production), so `apiEndpoint('/auth/login')` resolves to
 * `https://api.kiramyao.com/hrt/auth/login`.
 *
 * The error handling is the load-bearing part, because two failure modes look
 * alike over HTTP and need different UI:
 *
 *   - **`locked`** (429 / account lockout) — stop retrying, tell the user to wait.
 *   - **`invalid credentials`** — indistinguishable on purpose, so the UI must not
 *     try to explain which part was wrong.
 */
import { apiEndpoint, apiFetch } from './apiClient';

/** What the server is willing to say about a failure. */
export type CoreErrorKind =
  | 'invalid_credentials'
  | 'locked'
  | 'rate_limited'
  | 'not_configured'
  | 'username_taken'
  | 'network'
  | 'unknown';

/** The social sign-in providers this client speaks to. Both are the same flow. */
export type LoginProvider = 'x' | 'google';

/**
 * The provider's name as a reader sees it, for the copy that names one.
 *
 * One map rather than the literal sprinkled through three screens: the landing, the
 * sign-in form and the account rows all have to say the same word, and a provider
 * renamed in one place would otherwise disagree with the other two.
 */
export const PROVIDER_NAMES: Record<LoginProvider, string> = { x: 'X', google: 'Google' };

export class CoreAuthError extends Error {
  constructor(
    readonly kind: CoreErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'CoreAuthError';
  }

  /**
   * Whether the user can do something about it.
   */
  get isRecoverable(): boolean {
    return this.kind === 'invalid_credentials';
  }
}

/** Classification of the server's error strings. Kept in one place so the UI never
 *  string-matches after a rename. */
function classify(body: { error?: string } | undefined, status: number): CoreErrorKind {
  const raw = (body?.error ?? '').toLowerCase();
  if (raw.includes('too many failed attempts')) return 'locked';
  if (raw.includes('too many attempts')) return 'rate_limited';
  if (raw.includes('not configured')) return 'not_configured';
  // The one bind failure with a field to attach it to, so it must not arrive as
  // `unknown` and be shown as a generic error against the whole form.
  if (raw.includes('username_taken')) return 'username_taken';
  if (raw.includes('invalid credentials')) return 'invalid_credentials';
  if (status === 429) return 'rate_limited';
  return 'unknown';
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  let res: Response;
  try {
    res = await apiFetch(apiEndpoint(path), {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(rest.headers ?? {}),
      },
    });
  } catch {
    // A transport failure, not a rejection: distinct so the UI can say "check your
    // connection" rather than "wrong password".
    throw new CoreAuthError('network', 'Could not reach the server', null);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const kind = classify(body as { error?: string }, res.status);
    const message =
      (body as { error?: string })?.error ?? `Request failed (${res.status})`;
    throw new CoreAuthError(kind, message, res.status);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Shapes returned by the server
// ---------------------------------------------------------------------------

export interface SessionResponse {
  userId: string;
  username: string;
  token: string;
}

export interface AccountSummary {
  createdAt: string | null;
  doseCount: number;
  labCount: number;
  xLinks: number;
  xLoginAvailable: boolean;
  /** The linked X avatar, for the account header. Null when no X account is linked. */
  xAvatarUrl: string | null;
  privacyMode: PrivacyMode;
  /** Whether a recovery *wrapper* exists. The key itself is never stored. */
  hasRecoveryKey: boolean;
  /** Whether this deployment can offer standard mode (it needs a server key). */
  serverRecoveryAvailable: boolean;
}

/**
 * The two data-security modes.
 *
 * Not a security score — a different key model, described in plain terms in the UI.
 * See the settings screen and the register form.
 */
export type PrivacyMode = 'standard' | 'advanced';

export interface OAuthLink {
  /** Which provider this row is. Google sends no handle and no avatar by design. */
  provider: string;
  handle: string | null;
  /** The avatar the provider sent, captured server-side at link/login time. */
  avatarUrl: string | null;
  linkedAt: string | null;
  lastLoginAt: string | null;
}

/**
 * What `GET /auth/login-methods` reports about how an account can be entered.
 *
 * `recoveryRisk` is the honest headline: one way in, and it is a social provider, so
 * losing that provider loses the account. It is also what makes the fallback-credential
 * screen worth offering before the server has to refuse anything.
 */
export interface LoginMethods {
  username: string | null;
  hasPassword: boolean;
  providers: string[];
  recoveryRisk: boolean;
  /** Every linked social account, when the server sends them alongside. */
  links: OAuthLink[];
}

/**
 * One agent token, as the server describes it.
 *
 * There is no `token` field and there never will be: the plaintext is shown once at
 * mint time and only its hash is stored, so the list is metadata by construction
 * rather than by choice. `expiresAt: null` means permanent, which is the default.
 */
export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** One live unlock, as the account page's device list shows it. */
export interface SessionInfo {
  /** The handle for the newest unlock behind this row. */
  id: string;
  /** Every unlock behind this row, so revoking the row revokes all of them. */
  ids: string[];
  /** How many unlocks share this device. */
  sessions: number;
  current: boolean;
  createdAt: string | null;
  lastSeenAt: string | null;
  expiresAt: string | null;
  /** The raw user agent; the page turns it into a readable name. */
  userAgent: string | null;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// Wire decoding: snake_case in, camelCase out, in one place
// ---------------------------------------------------------------------------

const toSession = (raw: any): SessionResponse => ({
  userId: raw.user_id,
  username: raw.username,
  token: raw.token,
});

/** One linked provider row, as both the X list and `login-methods` describe it. */
const toOAuthLink = (raw: any): OAuthLink => ({
  provider: String(raw.provider ?? ''),
  handle: raw.handle ?? null,
  avatarUrl: raw.avatarUrl ?? null,
  linkedAt: raw.linkedAt ?? null,
  lastLoginAt: raw.lastLoginAt ?? null,
});

export const coreAuth = {
  // --- Registration ---------------------------------------------------------

  /** Create an account. Returns a live session; there is no separate enrolment step. */
  async register(
    username: string,
    password: string,
    opts: { privacyMode?: PrivacyMode; turnstileToken?: string } = {},
  ): Promise<SessionResponse> {
    return toSession(
      await request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          ...(opts.privacyMode ? { privacy_mode: opts.privacyMode } : {}),
          ...(opts.turnstileToken ? { turnstile_token: opts.turnstileToken } : {}),
        }),
      }),
    );
  },

  // --- Sign-in -------------------------------------------------------------

  /** Sign in with a username and password. */
  async login(username: string, password: string): Promise<SessionResponse> {
    return toSession(
      await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    );
  },

  async logout(token: string): Promise<void> {
    await request('/auth/logout', { method: 'POST', token, body: '{}' });
  },

  // --- Account -------------------------------------------------------------

  async summary(token: string): Promise<AccountSummary> {
    const raw = await request<any>('/auth/account', { token });
    return {
      createdAt: raw.created_at,
      doseCount: raw.dose_count,
      labCount: raw.lab_count,
      xLinks: raw.x_links,
      xLoginAvailable: raw.x_login_available,
      xAvatarUrl: raw.x_avatar_url ?? null,
      privacyMode: raw.privacy_mode === 'advanced' ? 'advanced' : 'standard',
      hasRecoveryKey: raw.has_recovery_key === true,
      serverRecoveryAvailable: raw.server_recovery_available === true,
    };
  },

  /**
   * Unlock data for a session whose identity X already proved.
   *
   * Distinct from `login`: X supplied the identity, so the only thing missing is the
   * *data* credential. `factor` says which one was supplied.
   */
  async unlockData(
    lockedToken: string,
    factor: 'password' | 'recovery',
    secret: string,
  ): Promise<SessionResponse> {
    return toSession(
      await request('/auth/unlock', {
        method: 'POST',
        body: JSON.stringify({
          locked_token: lockedToken,
          factor,
          ...(factor === 'password' ? { password: secret } : { recovery_key: secret }),
        }),
      }),
    );
  },

  /** Create or replace the recovery key. The plaintext is returned once, here only. */
  async createRecoveryKey(token: string, currentPassword: string): Promise<string> {
    const raw = await request<any>('/auth/recovery-key', {
      method: 'POST',
      token,
      body: JSON.stringify({ current_password: currentPassword }),
    });
    return raw.recovery_key;
  },

  /** Change the password. Re-wraps the data key; records survive. */
  async changePassword(
    token: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await request('/auth/password', {
      method: 'POST',
      token,
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
  },

  /**
   * Delete the account and everything in it.
   *
   * Requires the password, so a stolen session is not enough.
   */
  async deleteAccount(
    token: string,
    password: string,
    opts: { reason?: string } = {},
  ): Promise<void> {
    await request('/auth/account/delete', {
      method: 'POST',
      token,
      body: JSON.stringify({
        password,
        ...(opts.reason ? { reason: opts.reason } : {}),
      }),
    });
  },

  // --- Social sign-in (X, Google) ------------------------------------------

  /**
   * Which social providers this instance has configured.
   *
   * An unreachable or unreadable `/health` means neither is, deliberately: a button
   * that cannot work is worse than no button, because the user blames themselves for
   * the failure. One request answers for both, since the app always asks about both.
   */
  async loginProviders(): Promise<{ x: boolean; google: boolean }> {
    try {
      const res = await apiFetch(apiEndpoint('/health'));
      const body = (await res.json()) as { x_login?: boolean; google_login?: boolean };
      return { x: body.x_login === true, google: body.google_login === true };
    } catch {
      return { x: false, google: false };
    }
  },

  /**
   * Start a provider authorization.
   *
   * Returns the URL to send the browser to. `purpose: 'link'` attaches a provider
   * account to the signed-in one and needs a token.
   *
   * `intent: 'register'` tells the server this start came from the sign-up screen, so
   * it asks for human verification before minting an authorization URL — that is the
   * path that can create an account. A plain sign-in sends no intent and is not
   * gated: for an account created through a provider, the provider *is* the only way
   * in, so a blocked challenge must not be able to lock someone out of their records.
   */
  async startOAuth(
    provider: LoginProvider,
    purpose: 'login' | 'link',
    opts: { token?: string; turnstileToken?: string; intent?: 'register' } = {},
  ): Promise<{ authorizeUrl: string; state: string }> {
    const query = new URLSearchParams();
    if (purpose === 'link') query.set('purpose', 'link');
    if (opts.intent) query.set('intent', opts.intent);
    if (opts.turnstileToken) query.set('turnstile_token', opts.turnstileToken);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const raw = await request<any>(
      `/auth/${provider}/start${suffix}`,
      opts.token ? { token: opts.token } : {},
    );
    return { authorizeUrl: raw.authorize_url, state: raw.state };
  },

  /**
   * Exchange the one-time code from a provider callback.
   *
   * Three outcomes, and the middle one is the interesting case:
   *   - `token` set → a real session (standard mode, or an already-live unlock).
   *   - `token: null` and `lockedToken` set → advanced mode: the provider proved
   *     identity, the data is still locked. The caller shows the unlock step with
   *     this token.
   *   - `token: null`, no `lockedToken` → shouldn't happen, but the caller falls back
   *     to the normal password sign-in.
   */
  async exchangeOAuthCode(
    provider: LoginProvider,
    code: string,
  ): Promise<{ userId: string; username: string; token: string | null; lockedToken: string | null }> {
    const raw = await request<any>(`/auth/${provider}/exchange`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    return {
      userId: raw.user_id,
      username: raw.username,
      token: raw.token,
      lockedToken: raw.locked_token ?? null,
    };
  },

  async listXLinks(token: string): Promise<OAuthLink[]> {
    const raw = await request<any>('/auth/x/links', { token });
    // The Core serialises these itself (`listXLinks` maps its rows), so they arrive
    // camelCase — not as the `oauth_accounts` column names. Reading `l.avatar_url` here
    // yielded undefined for every field, which is why the account page showed a
    // generic glyph and "Invalid Date": nothing was ever populated to render.
    return ((raw.links ?? []) as any[]).map(toOAuthLink);
  },

  /**
   * How this account can be entered: a password, and each linked provider.
   *
   * Also the only place that reports `recovery_risk`, which is what the account page
   * needs in order to say "losing that provider would lose this account" *before* the
   * server has to refuse a record write.
   */
  async loginMethods(token: string): Promise<LoginMethods> {
    const raw = await request<any>('/auth/login-methods', { token });
    return {
      username: raw.username ?? null,
      hasPassword: raw.has_password === true,
      providers: Array.isArray(raw.providers) ? raw.providers.map(String) : [],
      recoveryRisk: raw.recovery_risk === true,
      links: Array.isArray(raw.accounts) ? raw.accounts.map(toOAuthLink) : [],
    };
  },

  /**
   * Bind a fallback account name and password to a session opened by a provider.
   *
   * The one call that makes an X- or Google-created account reachable without that
   * provider. Works on a session whose records are still refused, which is why it
   * cannot be behind the same gate as `/api/records`.
   */
  async bindCredentials(
    token: string,
    username: string,
    password: string,
  ): Promise<{ username: string }> {
    const raw = await request<{ username: string }>('/auth/credentials/bind', {
      method: 'POST',
      token,
      body: JSON.stringify({ username, password }),
    });
    return { username: raw.username };
  },

  /** Detach a provider. The server refuses this when it is the last way in. */
  async unlinkOAuth(token: string, provider: LoginProvider): Promise<void> {
    await request(`/auth/oauth/${provider}/unlink`, { method: 'POST', token, body: '{}' });
  },

  // --- Agent tokens ---------------------------------------------------------

  /**
   * Mint a token. The plaintext comes back here and only here.
   *
   * `name` is a label the user chooses so a stale token can be identified later —
   * "Claude Desktop", "my laptop". It has no security meaning.
   */
  async mintToken(token: string, name: string): Promise<{ token: string; name: string }> {
    const raw = await request<{ token: string; name: string }>('/api/tokens', {
      method: 'POST', token, body: JSON.stringify({ name }),
    });
    return raw;
  },

  async listTokens(token: string): Promise<ApiToken[]> {
    const raw = await request<{ tokens: ApiToken[] }>('/api/tokens', { token });
    return raw.tokens ?? [];
  },

  async revokeToken(token: string, id: string): Promise<void> {
    await request(`/api/tokens/${id}`, { method: 'DELETE', token });
  },

  /**
   * The account's live unlocks, grouped by device, with the caller's own marked.
   *
   * Carries no token: the server names sessions by an opaque id so that revoking one is
   * possible without either side handling the credential itself.
   */
  async listSessions(token: string): Promise<SessionInfo[]> {
    const raw = await request<{ sessions?: any[] }>('/auth/sessions', { token });
    return (raw.sessions ?? []).map((s) => ({
      id: String(s.id),
      ids: Array.isArray(s.ids) ? s.ids.map(String) : [String(s.id)],
      sessions: typeof s.sessions === 'number' ? s.sessions : 1,
      current: s.current === true,
      createdAt: s.createdAt ?? null,
      lastSeenAt: s.lastSeenAt ?? null,
      expiresAt: s.expiresAt ?? null,
      userAgent: typeof s.userAgent === 'string' ? s.userAgent : null,
      ip: typeof s.ip === 'string' ? s.ip : null,
    }));
  },

  /** End every unlock behind one row of that list. */
  async revokeSessions(token: string, ids: string[]): Promise<number> {
    const raw = await request<{ revoked?: number }>('/auth/sessions/revoke', {
      method: 'POST',
      token,
      body: JSON.stringify({ ids }),
    });
    return typeof raw.revoked === 'number' ? raw.revoked : 0;
  },

  /** End every unlock except this one: "sign out everywhere else". */
  async revokeOtherSessions(token: string): Promise<number> {
    const raw = await request<{ revoked?: number }>('/auth/sessions/revoke', {
      method: 'POST',
      token,
      body: JSON.stringify({ all_others: true }),
    });
    return typeof raw.revoked === 'number' ? raw.revoked : 0;
  },
};

/**
 * Where the browser lands after a provider authorization, read from the current URL.
 *
 * `handle` is X's alone: Google is asked for the `openid` scope only, so it sends no
 * handle and no avatar, and everything that renders one has to treat that as absent
 * rather than as a missing value to paper over.
 */
export function readAuthCallbackParams(): {
  code: string | null;
  username: string | null;
  handle: string | null;
  linked: boolean;
  error: string | null;
} {
  const p = new URLSearchParams(window.location.search);
  return {
    code: p.get('code'),
    username: p.get('username'),
    handle: p.get('handle'),
    linked: p.get('linked') === '1',
    error: p.get('error'),
  };
}
