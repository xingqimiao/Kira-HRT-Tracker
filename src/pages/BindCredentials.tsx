import React, { useState } from 'react';
import Icon from '../components/Icon';
import { AlertTriangle } from '../icons';
import { Progress } from '../components/ui';

import { coreAuth, CoreAuthError } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * Bind a fallback account name and password.
 *
 * The server refuses every record for an account whose only way in is X or Google, with
 * a 403 `account_incomplete`. This is the screen that answers it. The session is valid —
 * it is the credential this call is made with — so nothing here signs anyone out;
 * signing out would destroy the one thing that can fix the account.
 *
 * It is also reachable on purpose rather than only when refused: `/auth/login-methods`
 * reports `recovery_risk` while an account has no password, and the account page offers
 * this screen from there, before a provider ban has to teach the lesson.
 */

interface BindCredentialsProps {
  session: CoreSession;
  /** Called once the credential is bound, so the app can try the records again. */
  onDone: () => void | Promise<void>;
}

/** The server's own rule, mirrored so a bad name is refused before it is sent. */
const USERNAME = /^[A-Za-z0-9_-]{3,30}$/;
const PASSWORD_MIN = 8;

const BindCredentials: React.FC<BindCredentialsProps> = ({ session, onDone }) => {
  const { t } = useTranslation();
  // The provider derived a name at signup, so the field starts from it: it is a
  // legitimate choice and typing it again is a step with no purpose.
  const [username, setUsername] = useState(session.user?.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Kept apart from the form-level error because it belongs against the field it is
  // about: a taken name is something to change, not a failure of the whole action.
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const token = session.token;
  const ready = USERNAME.test(username) && password.length >= PASSWORD_MIN;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !token || !ready) return;
    setBusy(true);
    setError(null);
    setUsernameError(null);
    try {
      const bound = await coreAuth.bindCredentials(token, username, password);
      // The name is free text and the server is the one that settles it, so the session
      // takes the answer: the account page reads its "signed in as" from there, and a
      // rename that only happened server-side would be invisible until the next reload.
      if (session.user) session.adoptSession(token, session.user.userId, bound.username);
      setPassword('');
      await onDone();
    } catch (err) {
      if (err instanceof CoreAuthError && err.kind === 'username_taken') {
        setUsernameError(t('core.bind.taken'));
      } else {
        setError(err instanceof CoreAuthError ? err.message : t('core.err.generic'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[var(--color-m3-surface-dim)]">
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="mx-auto w-full max-w-[32rem] px-6 pb-20 pt-8 md:px-8 md:pt-10">
          <header className="mb-6">
            <h1 className="text-m3-title-xl">{t('core.bind.title')}</h1>
            {/* The real reason, in one line: not a formality, but the thing that keeps
                the records reachable if the provider account is ever lost. */}
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-m3-on-surface-variant)]">
              {t('core.bind.why')}
            </p>
          </header>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm" htmlFor="bind-username">{t('core.username')}</label>
              <input
                id="bind-username"
                className="input-base"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setUsernameError(null);
                }}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                required
                minLength={3}
                maxLength={30}
                autoFocus
                aria-invalid={usernameError ? true : undefined}
              />
              {usernameError && (
                <p className="text-xs flex items-start gap-1.5 text-[var(--color-m3-error)]" role="alert">
                  <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
                  <span>{usernameError}</span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm" htmlFor="bind-password">{t('core.password')}</label>
              <input
                id="bind-password"
                type="password"
                className="input-base"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN}
              />
              <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
                {t('core.pw.new_hint')}
              </p>
            </div>

            {error && (
              <p className="text-xs flex items-start gap-1.5 text-[var(--color-m3-error)]" role="alert">
                <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}

            <button type="submit" disabled={busy || !ready} className="btn-primary w-full">
              {busy && <Progress size={16} />}
              {t('core.bind.action')}
            </button>
          </form>

          {/* An escape hatch, and an honest one: someone who does not want a password
              here has to leave rather than sit on a screen with no exit. */}
          <button
            type="button"
            onClick={() => void session.signOut()}
            className="mt-6 w-full text-xs py-2 text-[var(--color-m3-on-surface-variant)]  hover:underline"
          >
            {t('core.acct.sign_out')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BindCredentials;
