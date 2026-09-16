import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { coreAuth, CoreAuthError, type RegistrationResponse } from '../services/coreAuth';

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

export interface CoreUser {
  userId: string;
  username: string;
}

/** How the sign-in form should proceed after the credentials were submitted. */
export type SignInStep = 'credentials' | 'two_factor';

/** The shared session, as consumers see it. Declared rather than inferred from the
 *  implementation, which would make the type circular with the hook that returns it. */
export interface CoreSession {
  user: CoreUser | null;
  token: string | null;
  /** True until a stored token has been checked against the server. */
  restoring: boolean;
  isSignedIn: boolean;
  signIn: (
    username: string,
    password: string,
    opts?: { code?: string; backupCode?: string },
  ) => Promise<{ step: SignInStep; recoveryCodesRemaining?: number }>;
  register: (username: string, password: string) => Promise<RegistrationResponse>;
  confirmEnrollment: (enrollmentToken: string, code: string) => Promise<{ userId: string; username: string; token: string }>;
  adoptSession: (token: string, userId: string, username: string) => void;
  signOut: () => Promise<void>;
}

interface CoreSessionState {
  user: CoreUser | null;
  token: string | null;
  /** True until the stored token has been checked against the server. */
  restoring: boolean;
}

function readStored(): { token: string | null; user: CoreUser | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    const user = rawUser ? (JSON.parse(rawUser) as CoreUser) : null;
    if (token && user?.userId) return { token, user };
  } catch {
    // Corrupt storage: treat as signed out rather than throwing at import time.
  }
  return { token: null, user: null };
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
    const { token, user } = readStored();
    return { token, user, restoring: !!token };
  });

  const persist = useCallback((token: string | null, user: CoreUser | null) => {
    setState({ token, user, restoring: false });
    if (token && user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  }, []);

  // Verify a restored token on mount rather than trusting it. A stale token is the
  // normal case after the server restarts (sessions are in-memory) or after the
  // 30-minute idle window, and the app must not present itself as signed in while
  // every request 401s.
  useEffect(() => {
    const { token } = readStored();
    if (!token) {
      setState({ token: null, user: null, restoring: false });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await coreAuth.summary(token);
        if (!cancelled) setState(s => ({ ...s, restoring: false }));
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
   * Sign in with a password and, when the server asks for it, a second factor.
   *
   * Returns which step to show next instead of throwing for the code prompt: the
   * password being accepted is progress, not an error.
   */
  const signIn = useCallback(
    async (
      username: string,
      password: string,
      opts: { code?: string; backupCode?: string } = {},
    ): Promise<{ step: SignInStep; recoveryCodesRemaining?: number }> => {
      try {
        const session = await coreAuth.login(username, password, opts);
        persist(session.token, { userId: session.userId, username: session.username });
        return {
          step: 'credentials',
          ...(session.recoveryCodesRemaining !== undefined
            ? { recoveryCodesRemaining: session.recoveryCodesRemaining }
            : {}),
        };
      } catch (error) {
        if (error instanceof CoreAuthError && error.kind === 'two_factor_required') {
          return { step: 'two_factor' };
        }
        throw error;
      }
    },
    [persist],
  );

  /** Start a registration. Returns the enrolment material; it is NOT a session. */
  const register = useCallback(
    async (username: string, password: string): Promise<RegistrationResponse> => {
      return await coreAuth.register(username, password);
    },
    [],
  );

  /** Finish enrolment. Only here does the account become usable and a session open. */
  const confirmEnrollment = useCallback(
    async (enrollmentToken: string, code: string) => {
      const session = await coreAuth.confirmEnrollment(enrollmentToken, code);
      persist(session.token, { userId: session.userId, username: session.username });
      return session;
    },
    [persist],
  );

  /** Adopt a session issued somewhere else — the X flow, or an X setup completion. */
  const adoptSession = useCallback(
    (token: string, userId: string, username: string) => {
      persist(token, { userId, username });
    },
    [persist],
  );

  const signOut = useCallback(async () => {
    const token = state.token;
    persist(null, null);
    // Revoke server-side too. Fire-and-forget: the local session is already gone,
    // and a failure here must not leave the user stuck in a signed-in UI.
    if (token) await coreAuth.logout(token).catch(() => undefined);
  }, [persist, state.token]);

  return useMemo(
    () => ({
      user: state.user,
      token: state.token,
      restoring: state.restoring,
      isSignedIn: !!state.token && !!state.user,
      signIn,
      register,
      confirmEnrollment,
      adoptSession,
      signOut,
    }),
    [state, signIn, register, confirmEnrollment, adoptSession, signOut],
  );
}
