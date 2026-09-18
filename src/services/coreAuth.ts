/**
 * Client for the Application Core's authentication API.
 *
 * Separate from `services/auth.ts`, which speaks to the legacy Worker API
 * (session list, admin). The Core has a different model — password plus a
 * *mandatory* second factor — so mixing the two into one module would hide which
 * backend each call reaches, and they are reached at different origins.
 *
 * Paths here are relative to the service mount (`VITE_API_ORIGIN` already includes
 * the `/hrt` prefix in production), so `apiEndpoint('/auth/login')` resolves to
 * `https://api.kiramyao.com/hrt/auth/login`.
 *
 * The error handling is the load-bearing part, because three failure modes look
 * alike over HTTP and need different UI:
 *
 *   - **`two_factor_required`** — the password was accepted and a code is needed.
 *     Not an error; the next step of a normal sign-in.
 *   - **`locked`** (429 / account lockout) — stop retrying, tell the user to wait.
 *   - **`invalid credentials`** — indistinguishable on purpose, so the UI must not
 *     try to explain which part was wrong.
 */
import { apiEndpoint, apiFetch, UNAUTHORIZED_EVENT } from './apiClient';

/** What the server is willing to say about a failure. */
export type CoreErrorKind =
  | 'invalid_credentials'
  | 'two_factor_required'
  | 'locked'
  | 'rate_limited'
  | 'not_configured'
  | 'network'
  | 'unknown';

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
   *
   * `two_factor_required` is deliberately `false` — it is a prompt, not a failure,
   * and a UI that renders it red would train people to think their password was
   * wrong every time they sign in.
   */
  get isRecoverable(): boolean {
    return this.kind === 'two_factor_required' || this.kind === 'invalid_credentials';
  }
}

/** Classification of the server's error strings. Kept in one place so the UI never
 *  string-matches after a rename. */
function classify(body: { error?: string } | undefined, status: number): CoreErrorKind {
  const raw = (body?.error ?? '').toLowerCase();
  if (raw === 'two_factor_required') return 'two_factor_required';
  if (raw.includes('too many failed attempts')) return 'locked';
  if (raw.includes('too many attempts')) return 'rate_limited';
  if (raw.includes('not configured')) return 'not_configured';
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
    // A session that the server has invalidated should clear app state, which is
    // what this event is for. The Core reports a locked account as 401 too, so this
    // only fires when the response is *not* a lockout — a lockout is a prompt.
    if (res.status === 401 && kind !== 'two_factor_required' && typeof window !== 'undefined') {
      // Not dispatched: unlike the Worker API, a 401 here can mean "account locked",
      // and signing the user out of the app for that would be wrong. The caller
      // decides. Kept explicit so the reason is visible.
      void UNAUTHORIZED_EVENT;
    }
    const message =
      (body as { error?: string })?.error ?? `Request failed (${res.status})`;
    throw new CoreAuthError(kind, message, res.status);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Shapes returned by the server
// ---------------------------------------------------------------------------

export interface EnrollmentMaterial {
  secret: string;
  otpauthUri: string;
  /** Shown once. The server stores only hashes and cannot re-issue these. */
  backupCodes: string[];
}

export interface RegistrationResponse {
  userId: string;
  username: string;
  enrollmentToken: string;
  totp: EnrollmentMaterial;
}

export interface SessionResponse {
  userId: string;
  username: string;
  token: string;
  /** Present only after a recovery-code sign-in; how many remain. */
  recoveryCodesRemaining?: number;
}

export interface AccountSummary {
  createdAt: string | null;
  doseCount: number;
  labCount: number;
  recoveryCodesRemaining: number;
  xLinks: number;
  xLoginAvailable: boolean;
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

export interface XLink {
  handle: string | null;
  /** X avatar, captured server-side at link/login time. Null when X sent none. */
  avatarUrl: string | null;
  linkedAt: string;
  lastLoginAt: string | null;
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

// ---------------------------------------------------------------------------
// Wire decoding: snake_case in, camelCase out, in one place
// ---------------------------------------------------------------------------

const toEnrollment = (raw: any): EnrollmentMaterial => ({
  secret: raw.secret,
  otpauthUri: raw.otpauth_uri,
  backupCodes: raw.backup_codes ?? [],
});

const toRegistration = (raw: any): RegistrationResponse => ({
  userId: raw.user_id,
  username: raw.username,
  enrollmentToken: raw.enrollment_token,
  totp: toEnrollment(raw.totp),
});

const toSession = (raw: any): SessionResponse => ({
  userId: raw.user_id,
  username: raw.username,
  token: raw.token,
  ...(raw.recovery_codes_remaining !== undefined
    ? { recoveryCodesRemaining: raw.recovery_codes_remaining }
    : {}),
});

export const coreAuth = {
  // --- Registration and enrolment -------------------------------------------

  /** Create an account. Returns enrolment material, deliberately NOT a session. */
  async register(
    username: string,
    password: string,
    opts: { privacyMode?: PrivacyMode; turnstileToken?: string } = {},
  ): Promise<RegistrationResponse> {
    return toRegistration(
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

  /**
   * Resume an abandoned enrolment.
   *
   * Needed because someone who closed the tab between registering and confirming
   * would otherwise be stuck with a username they cannot reuse.
   */
  async resumeEnrollment(username: string, password: string): Promise<RegistrationResponse> {
    return toRegistration(
      await request('/auth/totp/resume', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    );
  },

  /** Confirm a code from the new secret. Only this makes the account usable. */
  async confirmEnrollment(enrollmentToken: string, code: string): Promise<SessionResponse> {
    return toSession(
      await request('/auth/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ enrollment_token: enrollmentToken, code }),
      }),
    );
  },

  // --- Sign-in -------------------------------------------------------------

  /**
   * Sign in.
   *
   * Pass `code` for the authenticator, or `backupCode` when the authenticator is
   * gone. Omitting both is valid and yields a `two_factor_required` error, which is
   * how the UI learns to ask for a code after checking the password first.
   */
  async login(
    username: string,
    password: string,
    opts: { code?: string; backupCode?: string } = {},
  ): Promise<SessionResponse> {
    return toSession(
      await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          ...(opts.code ? { code: opts.code } : {}),
          ...(opts.backupCode ? { backup_code: opts.backupCode } : {}),
        }),
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
      recoveryCodesRemaining: raw.recovery_codes_remaining,
      xLinks: raw.x_links,
      xLoginAvailable: raw.x_login_available,
      privacyMode: raw.privacy_mode === 'advanced' ? 'advanced' : 'standard',
      hasRecoveryKey: raw.has_recovery_key === true,
      serverRecoveryAvailable: raw.server_recovery_available === true,
    };
  },

  /**
   * Unlock data for a session whose identity X already proved.
   *
   * Distinct from `login`: X supplied the identity and the second factor, so the only
   * thing missing is the *data* credential. `factor` says which one was supplied.
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

  /** Switch privacy mode. Re-wraps the data key; records are never re-encrypted. */
  async switchPrivacyMode(
    token: string,
    mode: PrivacyMode,
    currentPassword: string,
  ): Promise<PrivacyMode> {
    const raw = await request<any>('/auth/privacy-mode', {
      method: 'POST',
      token,
      body: JSON.stringify({ privacy_mode: mode, current_password: currentPassword }),
    });
    return raw.privacy_mode === 'advanced' ? 'advanced' : 'standard';
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
  ): Promise<{ recoveryCodes: string[] | null }> {
    const raw = await request<any>('/auth/password', {
      method: 'POST',
      token,
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    // Present only for an account setting its FIRST password.
    return { recoveryCodes: raw.recovery_codes ?? null };
  },

  async regenerateRecoveryCodes(token: string, code: string): Promise<string[]> {
    const raw = await request<any>('/auth/recovery-codes/regenerate', {
      method: 'POST',
      token,
      body: JSON.stringify({ code }),
    });
    return raw.recovery_codes ?? [];
  },

  /**
   * Delete the account and everything in it.
   *
   * Requires the password AND a second factor, so a stolen session is not enough.
   * A recovery code is accepted in place of the authenticator code.
   */
  async deleteAccount(
    token: string,
    password: string,
    opts: { code?: string; backupCode?: string; reason?: string } = {},
  ): Promise<void> {
    await request('/auth/account/delete', {
      method: 'POST',
      token,
      body: JSON.stringify({
        password,
        ...(opts.code ? { code: opts.code } : {}),
        ...(opts.backupCode ? { backup_code: opts.backupCode } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      }),
    });
  },

  // --- X OAuth -------------------------------------------------------------

  /** Whether this instance has X login configured. */
  async xAvailable(): Promise<boolean> {
    try {
      const res = await apiFetch(apiEndpoint('/health'));
      const body = (await res.json()) as { x_login?: boolean };
      return body.x_login === true;
    } catch {
      return false;
    }
  },

  /**
   * Start an X authorization.
   *
   * Returns the URL to send the browser to. `purpose: 'link'` attaches an X account
   * to the signed-in one and needs a token.
   */
  async startX(
    purpose: 'login' | 'link',
    token?: string,
  ): Promise<{ authorizeUrl: string; state: string }> {
    const raw = await request<any>(
      `/auth/x/start${purpose === 'link' ? '?purpose=link' : ''}`,
      token ? { token } : {},
    );
    return { authorizeUrl: raw.authorize_url, state: raw.state };
  },

  /**
   * Exchange the one-time code from the X callback.
   *
   * Three outcomes, and the middle one is the interesting case:
   *   - `token` set → a real session (standard mode, or an already-live unlock).
   *   - `token: null` and `lockedToken` set → advanced mode: X proved identity, the
   *     data is still locked. The caller shows the unlock step with this token.
   *   - `token: null`, no `lockedToken` → shouldn't happen, but the caller falls back
   *     to the normal password sign-in.
   */
  async exchangeXCode(
    code: string,
  ): Promise<{ userId: string; username: string; token: string | null; lockedToken: string | null }> {
    const raw = await request<any>('/auth/x/exchange', {
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

  /** Complete setup for an X-created account: set a password and enrol TOTP. */
  async completeXSetup(
    setupToken: string,
    password: string,
    code: string,
    opts: { privacyMode?: PrivacyMode; turnstileToken?: string } = {},
  ): Promise<SessionResponse> {
    return toSession(
      await request('/auth/x/setup', {
        method: 'POST',
        body: JSON.stringify({
          setup_token: setupToken,
          password,
          code,
          ...(opts.privacyMode ? { privacy_mode: opts.privacyMode } : {}),
          ...(opts.turnstileToken ? { turnstile_token: opts.turnstileToken } : {}),
        }),
      }),
    );
  },

  async listXLinks(token: string): Promise<XLink[]> {
    const raw = await request<any>('/auth/x/links', { token });
    // The Core serialises these itself (`listXLinks` maps its rows), so they arrive
    // camelCase — not as the `oauth_links` column names. Reading `l.avatar_url` here
    // yielded undefined for every field, which is why the account page showed a
    // generic glyph and "Invalid Date": nothing was ever populated to render.
    return (raw.links ?? []).map((l: any) => ({
      handle: l.handle ?? null,
      avatarUrl: l.avatarUrl ?? null,
      linkedAt: l.linkedAt ?? null,
      lastLoginAt: l.lastLoginAt ?? null,
    }));
  },

  async unlinkX(token: string, code: string): Promise<void> {
    await request('/auth/x/unlink', { method: 'POST', token, body: JSON.stringify({ code }) });
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
};

/** Where the browser lands after an X authorization, read from the current URL. */
export function readXCallbackParams(): {
  code: string | null;
  setupToken: string | null;
  username: string | null;
  secret: string | null;
  handle: string | null;
  linked: boolean;
  error: string | null;
} {
  const p = new URLSearchParams(window.location.search);
  return {
    code: p.get('code'),
    setupToken: p.get('setup_token'),
    username: p.get('username'),
    secret: p.get('secret'),
    handle: p.get('handle'),
    linked: p.get('linked') === '1',
    error: p.get('error'),
  };
}
