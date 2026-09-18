import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { coreAuth, CoreAuthError, type PrivacyMode } from '../services/coreAuth';
import { createPasskey, getPasskeyAssertion } from '../utils/passkeys';

/**
 * The Application Core session.
 *
 * Kept separate from `AuthContext`, which speaks to the legacy Worker API. The two
 * are genuinely different models and merging them would obscure which backend each
 * call reaches:
 *
 *   - The Worker hands out a JWT and the browser derives a **cloud key** from the
 *     password to encrypt backups locally.
 *   - The Core hands out an unlock token (`ks_…`) that **is** the key holder: the
 *     server keeps the data key in memory while the session is live, so the browser
 *     needs no key of its own. Signing out — or the idle timeout — drops it.
 *
 * The token lives in `localStorage` rather than memory so a refresh does not sign
 * the user out. That is a real trade: any script on the origin can read it. It is
 * the same posture the existing session already takes, and the Core mitigates it by
 * binding the token to a short idle window server-side.
 */

const TOKEN_KEY = 'hrt_core_token';
const USER_KEY = 'hrt_core_user';
/** A session whose identity X proved but whose data is still locked (advanced mode). */
const LOCKED_KEY = 'hrt_core_locked';
const MODE_KEY = 'hrt_core_privacy';

export interface CoreUser {
  userId: string;
  username: string;
}

/** The shared session, as consumers see it. Declared rather than inferred from the
 *  implementation, which would make the type circular with the hook that returns it. */
export interface CoreSession {
  user: CoreUser | null;
  token: string | null;
  /** True until a stored token has been checked against the server. */
  restoring: boolean;
  isSignedIn: boolean;
  /**
   * Whether this session holds the data key.
   *
   * Equal to `isSignedIn` today — a `ks_` token *is* the key holder — but named
   * separately because the two are conceptually distinct, and the locked state below
   * is exactly where they come apart: identity known, key not.
   */
  isDataUnlocked: boolean;
  /** The account's privacy mode, once known. Null until the server has said. */
  privacyMode: PrivacyMode | null;
  /**
   * A token proving identity when the data is still locked (advanced mode, after X).
   * Present on its own, with no `token`, is the legitimate "verified, not unlocked"
   * state — not an error.
   */
  lockedToken: string | null;
  lockedUser: CoreUser | null;
  signIn: (username: string, password: string) => Promise<void>;
  register: (
    username: string,
    password: string,
    opts?: { privacyMode?: PrivacyMode; turnstileToken?: string },
  ) => Promise<void>;
  adoptSession: (token: string, userId: string, username: string) => void;
  /** Record an identity X proved, pending a data unlock. */
  adoptLockedSession: (lockedToken: string, userId: string, username: string) => void;
  /** Unlock data with a password or recovery key, turning a locked session into a real one. */
  unlockData: (factor: 'password' | 'recovery', secret: string) => Promise<void>;
  /** Sign in with a passkey alone — no username, no password. */
  signInWithPasskey: (opts?: { username?: string; stepUpToken?: string }) => Promise<void>;
  /** Add a passkey to the signed-in account. Needs the password, and a PRF-capable device. */
  addPasskey: (currentPassword: string, name?: string) => Promise<{ credentialId: string }>;
  signOut: () => Promise<void>;
}

interface CoreSessionState {
  user: CoreUser | null;
  token: string | null;
  /** True until the stored token has been checked against the server. */
  restoring: boolean;
  lockedToken: string | null;
  lockedUser: CoreUser | null;
  privacyMode: PrivacyMode | null;
}

function readStored(): {
  token: string | null;
  user: CoreUser | null;
  lockedToken: string | null;
  lockedUser: CoreUser | null;
  privacyMode: PrivacyMode | null;
} {
  let lockedToken: string | null = null;
  let lockedUser: CoreUser | null = null;
  let privacyMode: PrivacyMode | null = null;
  try {
    lockedToken = localStorage.getItem(LOCKED_KEY);
    const rawLocked = localStorage.getItem(`${LOCKED_KEY}_user`);
    lockedUser = rawLocked ? (JSON.parse(rawLocked) as CoreUser) : null;
    const rawMode = localStorage.getItem(MODE_KEY);
    privacyMode = rawMode === 'advanced' || rawMode === 'standard' ? rawMode : null;
  } catch {
    // Best-effort; a corrupt value just means no locked session.
  }
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    const user = rawUser ? (JSON.parse(rawUser) as CoreUser) : null;
    if (token && user?.userId) return { token, user, lockedToken, lockedUser, privacyMode };
  } catch {
    // Corrupt storage: treat as signed out rather than throwing at import time.
  }
  return { token: null, user: null, lockedToken, lockedUser, privacyMode };
}

const CoreSessionContext = createContext<CoreSession | null>(null);

/**
 * Read the shared session.
 *
 * A context rather than a plain hook because the X landing route renders outside the
 * main app tree, and two `useState` instances would be two sessions: the callback would
 * store a token that the main app never sees. One provider, one state.
 */
export function useCoreSession(): CoreSession {
  const ctx = useContext(CoreSessionContext);
  if (!ctx) throw new Error('useCoreSession must be used within CoreSessionProvider');
  return ctx;
}

export const CoreSessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const session = useCoreSessionState();
  return <CoreSessionContext.Provider value={session}>{children}</CoreSessionContext.Provider>;
};

function useCoreSessionState() {
  const [state, setState] = useState<CoreSessionState>(() => {
    const { token, user, lockedToken, lockedUser, privacyMode } = readStored();
    return { token, user, restoring: !!token, lockedToken, lockedUser, privacyMode };
  });

  const persist = useCallback((token: string | null, user: CoreUser | null) => {
    setState(s => ({ ...s, token, user, restoring: false, lockedToken: null, lockedUser: null }));
    if (token && user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
    // A real session supersedes any pending locked one.
    localStorage.removeItem(LOCKED_KEY);
    localStorage.removeItem(`${LOCKED_KEY}_user`);
  }, []);

  const persistLocked = useCallback((lockedToken: string | null, user: CoreUser | null) => {
    setState(s => ({ ...s, lockedToken, lockedUser: user, restoring: false }));
    if (lockedToken && user) {
      localStorage.setItem(LOCKED_KEY, lockedToken);
      localStorage.setItem(`${LOCKED_KEY}_user`, JSON.stringify(user));
    } else {
      localStorage.removeItem(LOCKED_KEY);
      localStorage.removeItem(`${LOCKED_KEY}_user`);
    }
  }, []);

  const persistMode = useCallback((privacyMode: PrivacyMode | null) => {
    setState(s => ({ ...s, privacyMode }));
    if (privacyMode) localStorage.setItem(MODE_KEY, privacyMode);
    else localStorage.removeItem(MODE_KEY);
  }, []);

  // Verify a restored token on mount rather than trusting it. A stale token is the
  // normal case after the server restarts (sessions are in-memory) or after the
  // 30-minute idle window, and the app must not present itself as signed in while
  // every request 401s.
  useEffect(() => {
    const { token } = readStored();
    if (!token) {
      setState(s => ({ ...s, token: null, user: null, restoring: false }));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const summary = await coreAuth.summary(token);
        if (!cancelled) {
          setState(s => ({ ...s, restoring: false, privacyMode: summary.privacyMode }));
          localStorage.setItem(MODE_KEY, summary.privacyMode);
        }
      } catch (error) {
        // A lockout or a dead session both mean "sign in again"; a network failure
        // means we cannot tell, so the token is kept and the app stays signed in
        // until a request actually says otherwise.
        const network = error instanceof CoreAuthError && error.kind === 'network';
        if (!cancelled && !network) persist(null, null);
        else if (!cancelled) setState(s => ({ ...s, restoring: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persist]);

  /**
   * Sign in with a password.
   *
   * The password being accepted is the whole step: there is no second factor.
   */
  const signIn = useCallback(
    async (username: string, password: string): Promise<void> => {
      const session = await coreAuth.login(username, password);
      persist(session.token, { userId: session.userId, username: session.username });
    },
    [persist],
  );

  /** Create an account, which opens a session straight away. */
  const register = useCallback(
    async (
      username: string,
      password: string,
      opts: { privacyMode?: PrivacyMode; turnstileToken?: string } = {},
    ): Promise<void> => {
      const session = await coreAuth.register(username, password, opts);
      // Remember the chosen mode so the account page can label it before the first
      // server summary arrives.
      if (opts.privacyMode) persistMode(opts.privacyMode);
      persist(session.token, { userId: session.userId, username: session.username });
    },
    [persist, persistMode],
  );

  /** Adopt a session issued somewhere else — the X flow, or an X setup completion. */
  const adoptSession = useCallback(
    (token: string, userId: string, username: string) => {
      persist(token, { userId, username });
    },
    [persist],
  );

  /**
   * Adopt a locked session: identity proven by X, data still sealed (advanced mode).
   *
   * Not a sign-in and not a failure. It is what lets the Account page show the unlock
   * step for the right account without re-asking who the user is.
   */
  const adoptLockedSession = useCallback(
    (lockedToken: string, userId: string, username: string) => {
      persistLocked(lockedToken, { userId, username });
    },
    [persistLocked],
  );

  /**
   * Unlock data, turning a locked session into a real one.
   *
   * The password/recovery key is sent once to the server, which unwraps the DEK and
   * opens a normal session; nothing key-shaped is held in the browser.
   */
  const unlockData = useCallback(
    async (factor: 'password' | 'recovery', secret: string) => {
      if (!state.lockedToken) throw new CoreAuthError('unknown', 'No locked session to unlock', null);
      const session = await coreAuth.unlockData(state.lockedToken, factor, secret);
      persist(session.token, { userId: session.userId, username: session.username });
    },
    [persist, state.lockedToken],
  );

  /**
   * Sign in with a passkey alone.
   *
   * Two calls to the ceremony, not one: the options must come from the server so the
   * challenge is one the server will accept, and the assertion it produces is what the
   * server verifies. The PRF output rides along, and it is what opens the data — the
   * ceremony throws `no_prf` rather than returning null when it is missing, so the
   * failure reaches the UI with a reason instead of as an undefined.
   */
  const signInWithPasskey = useCallback(
    async (opts: { username?: string; stepUpToken?: string } = {}) => {
      const options = await coreAuth.startPasskeyAuthentication(opts.username);
      const assertion = await getPasskeyAssertion(options);
      const session = await coreAuth.finishPasskeyAuthentication(assertion.response, assertion.prfOutput, {
        ...(opts.stepUpToken ? { stepUpToken: opts.stepUpToken } : {}),
      });
      persist(session.token, { userId: session.userId, username: session.username });
    },
    [persist],
  );

  /** Add a passkey to the signed-in account. Requires the password, and PRF. */
  const addPasskey = useCallback(
    async (currentPassword: string, name?: string) => {
      if (!state.token) throw new CoreAuthError('unknown', 'Not signed in', null);
      const options = await coreAuth.startPasskeyRegistration(state.token, currentPassword);
      const created = await createPasskey(options);
      return await coreAuth.finishPasskeyRegistration(state.token, created.response, created.prfOutput, name);
    },
    [state.token],
  );

  const signOut = useCallback(async () => {
    const token = state.token;
    persist(null, null);
    persistMode(null);
    // Revoke server-side too. Fire-and-forget: the local session is already gone,
    // and a failure here must not leave the user stuck in a signed-in UI.
    if (token) await coreAuth.logout(token).catch(() => undefined);
  }, [persist, persistMode, state.token]);

  return useMemo(
    () => ({
      user: state.user,
      token: state.token,
      restoring: state.restoring,
      isSignedIn: !!state.token && !!state.user,
      isDataUnlocked: !!state.token,
      privacyMode: state.privacyMode,
      lockedToken: state.lockedToken,
      lockedUser: state.lockedUser,
      signIn,
      register,
      adoptSession,
      adoptLockedSession,
      unlockData,
      signInWithPasskey,
      addPasskey,
      signOut,
    }),
    [state, signIn, register, adoptSession, adoptLockedSession, unlockData, signInWithPasskey, addPasskey, signOut],
  );
}
