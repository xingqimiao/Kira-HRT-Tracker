import React, { useState } from 'react';
import Icon from './Icon';
import { Loader2, AlertTriangle, X } from '../icons';

import TotpEnrollment from './TotpEnrollment';
import { coreAuth, CoreAuthError, type RegistrationResponse } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import { usePresence } from '../hooks/usePresence';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * Sign in or sign up against the Application Core.
 *
 * Three screens in one modal, because they are one task: credentials → second factor
 * → enrol. Splitting them across routes would mean a half-finished sign-in could be
 * navigated away from and lost, and the enrolment token is single-use.
 *
 * The rule the whole flow exists to honour: **a new account cannot be used until its
 * second factor is confirmed.** Registration returns enrolment material and no
 * session; the modal therefore cannot close on success until that step completes,
 * and the account is inert in the meantime.
 */

interface CoreAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: CoreSession;
  /** Called once a session exists, so the app can load records. */
  onSignedIn?: () => void;
  /** Pre-fill the username — used when X identified the account but cannot unlock it. */
  initialUsername?: string;
}

type Screen = 'credentials' | 'two_factor' | 'enroll';

const CoreAuthModal: React.FC<CoreAuthModalProps> = ({
  isOpen,
  onClose,
  session,
  onSignedIn,
  initialUsername = '',
}) => {
  const { t } = useTranslation();
  const { mounted, state } = usePresence(isOpen, 200);

  const [screen, setScreen] = useState<Screen>('credentials');
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<RegistrationResponse | null>(null);
  const [xAvailable, setXAvailable] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  React.useEffect(() => {
    if (isOpen && initialUsername) setUsername(initialUsername);
  }, [isOpen, initialUsername]);

  // Ask whether X is offered only while the modal is open, and only once per open.
  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void coreAuth.xAvailable().then(v => {
      if (!cancelled) setXAvailable(v);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!mounted) return null;

  /** Turn a CoreAuthError into something worth reading, per kind. */
  function describe(error: unknown): string {
    if (!(error instanceof CoreAuthError)) return t('core.err.generic');
    switch (error.kind) {
      case 'invalid_credentials':
        // Deliberately vague, matching the server: it cannot tell you which part was
        // wrong, and guessing here would be a lie that teaches the wrong thing.
        return t('core.err.bad_credentials');
      case 'two_factor_required':
        return t('core.err.need_code');
      case 'locked':
        return t('core.err.locked');
      case 'rate_limited':
        return t('core.err.rate_limited');
      case 'not_configured':
        return t('core.err.x_unavailable');
      case 'network':
        return t('core.err.network');
      default:
        return error.message || t('core.err.generic');
    }
  }

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (isLogin) {
        const result = await session.signIn(username, password);
        if (result.step === 'two_factor') {
          setScreen('two_factor');
          return;
        }
        if (result.recoveryCodesRemaining !== undefined) {
          setNotice(t('core.2fa.recovery_signed_in').replace('{n}', String(result.recoveryCodesRemaining)));
        }
        onSignedIn?.();
        onClose();
      } else {
        // Registration produces enrolment material, not a session.
        const material = await session.register(username, password);
        setEnrollment(material);
        setScreen('enroll');
      }
    } catch (err) {
      // A locked-out or previously-abandoned account is told how to finish rather
      // than left believing the password was wrong.
      if (err instanceof CoreAuthError && err.message.includes('not completed')) {
        try {
          const material = await coreAuth.resumeEnrollment(username, password);
          setEnrollment(material);
          setScreen('enroll');
          return;
        } catch {
          // Fall through to the original message.
        }
      }
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSecondFactor(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await session.signIn(username, password, useBackupCode ? { backupCode } : { code });
      if (result.step === 'two_factor') {
        setError(t('core.2fa.rejected'));
        setCode('');
        return;
      }
      if (result.recoveryCodesRemaining !== undefined) {
        setNotice(t('core.2fa.recovery_signed_in').replace('{n}', String(result.recoveryCodesRemaining)));
      }
      onSignedIn?.();
      onClose();
    } catch (err) {
      setError(describe(err));
      if (!useBackupCode) setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function handleX() {
    setError(null);
    setBusy(true);
    try {
      const { authorizeUrl } = await coreAuth.startX('login');
      // Full navigation, not a popup: the callback is on the API host and returns
      // the browser to a landing route, which a popup would break out of.
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-overlay z-[70]"
      data-state={state}
      role="dialog"
      aria-modal="true"
      aria-label={isLogin ? t('core.sign_in') : t('core.create_account')}
    >
      <div className="modal-shell">
        <div className="modal-card">
          <div className="flex items-start justify-between gap-3 mb-1">
            <h3 className="modal-title !mb-0">
              {screen === 'enroll'
                ? t('core.setup_2fa')
                : isLogin
                  ? t('core.sign_in')
                  : t('core.create_account')}
            </h3>
            {/* Not closable mid-enrolment: the account exists but is unusable, and
                the single-use enrolment token would be lost with the modal. */}
            {screen !== 'enroll' && (
              <button
                type="button"
                onClick={onClose}
                aria-label={t('core.close')}
                className="-mr-1 -mt-1 p-1.5 rounded-full hover:bg-[var(--color-m3-surface-container)]  transition-colors"
                style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
              >
                <Icon icon={X} size={17} />
              </button>
            )}
          </div>

          {/* ── Enrolment ──────────────────────────────────────────────────── */}
          {screen === 'enroll' && enrollment && (
            <TotpEnrollment
              material={enrollment.totp}
              heading={t('core.enroll.heading').replace('{username}', enrollment.username)}
              submitting={busy}
              error={error}
              onConfirm={async (confirmCode) => {
                setError(null);
                setBusy(true);
                try {
                  await session.confirmEnrollment(enrollment.enrollmentToken, confirmCode);
                } catch (err) {
                  setError(describe(err));
                  throw err;
                } finally {
                  setBusy(false);
                }
              }}
              onComplete={() => {
                onSignedIn?.();
                onClose();
              }}
            />
          )}

          {/* ── Second factor ──────────────────────────────────────────────── */}
          {screen === 'two_factor' && (
            <form onSubmit={handleSecondFactor} className="space-y-4">
              <p className="text-sm text-[var(--color-m3-on-surface-variant)] ">
                {useBackupCode ? t('core.2fa.intro_backup') : t('core.2fa.intro')}
              </p>

              {useBackupCode ? (
                <input
                  type="text"
                  value={backupCode}
                  onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
                  className="input-base font-mono text-center tracking-[0.2em]"
                  placeholder="XXXXX-XXXXX"
                  autoComplete="off"
                  autoFocus
                  required
                />
              ) : (
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="input-base font-mono text-center text-lg tracking-[0.5em]"
                  placeholder="000000"
                  autoFocus
                  required
                />
              )}

              {error && (
                <p className="text-xs flex items-start gap-1.5 text-[#B3261E]" role="alert">
                  <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </p>
              )}

              <button type="submit" disabled={busy} className="btn-primary w-full">
                {busy && <Icon icon={Loader2} size={16} className="animate-spin" />}
                {t('core.continue')}
              </button>

              <div className="flex flex-col items-center gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setUseBackupCode(v => !v);
                    setError(null);
                    setCode('');
                    setBackupCode('');
                  }}
                  className="text-xs text-[var(--color-m3-primary)]  hover:underline"
                >
                  {useBackupCode ? t('core.2fa.use_totp') : t('core.2fa.use_backup')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Back to credentials. The password is kept: it was accepted, and
                    // retyping it would be busywork.
                    setScreen('credentials');
                    setError(null);
                    setCode('');
                    setBackupCode('');
                    setUseBackupCode(false);
                  }}
                  className="text-xs text-[var(--color-m3-on-surface-variant)]  hover:underline"
                >
                  {t('core.2fa.back')}
                </button>
              </div>
            </form>
          )}

          {/* ── Credentials ────────────────────────────────────────────────── */}
          {screen === 'credentials' && (
            <form onSubmit={handleCredentials} className="space-y-4">
              <p className="text-sm text-[var(--color-m3-on-surface-variant)]  !mt-0">
                {isLogin ? t('core.signin.intro') : t('core.signup.intro')}
              </p>

              <div className="space-y-1.5">
                <label className="text-sm" htmlFor="core-username">{t('core.username')}</label>
                <input
                  id="core-username"
                  className="input-base"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                  minLength={3}
                  maxLength={30}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm" htmlFor="core-password">{t('core.password')}</label>
                <input
                  id="core-password"
                  type="password"
                  className="input-base"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  required
                  minLength={8}
                />
                {!isLogin && (
                  <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
                    {t('core.signup.hint')}
                  </p>
                )}
              </div>

              {error && (
                <p className="text-xs flex items-start gap-1.5 text-[#B3261E]" role="alert">
                  <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </p>
              )}
              {notice && (
                <p className="callout !text-[0.75rem]">{notice}</p>
              )}

              <button type="submit" disabled={busy} className="btn-primary w-full">
                {busy && <Icon icon={Loader2} size={16} className="animate-spin" />}
                {isLogin ? t('core.sign_in') : t('core.create_account')}
              </button>

              {xAvailable && (
                <>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-px bg-[var(--color-m3-outline-variant)] " />
                    <span className="text-xs text-[var(--color-m3-on-surface-variant)] ">
                      {t('core.or')}
                    </span>
                    <div className="flex-1 h-px bg-[var(--color-m3-outline-variant)] " />
                  </div>
                  <button type="button" onClick={handleX} disabled={busy} className="btn-secondary w-full">
                    {t('core.x.continue')}
                  </button>
                  {/* Stated up front, because the alternative is a user discovering
                      mid-flow that the button did not do what they expected. */}
                  <p className="text-xs text-center text-[var(--color-m3-on-surface-variant)] ">
                    {t('core.x.note')}
                  </p>
                </>
              )}

              <div className="pt-1 text-center text-sm text-[var(--color-m3-on-surface-variant)] ">
                {isLogin ? t('core.signin.no_account') : t('core.signin.has_account')}{' '}
                <button
                  type="button"
                  onClick={() => {
                    setIsLogin(v => !v);
                    setError(null);
                    setNotice(null);
                  }}
                  className="text-[var(--color-m3-primary)]  hover:underline"
                >
                  {isLogin ? t('core.signin.go_register') : t('core.signin.go_login')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default CoreAuthModal;
