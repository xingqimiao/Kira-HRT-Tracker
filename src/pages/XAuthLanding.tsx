import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon';
import { CheckCircle2, Loader2, AlertTriangle } from '../icons';

import TotpSecretDisplay from '../components/TotpSecretDisplay';
import { coreAuth, CoreAuthError, readXCallbackParams } from '../services/coreAuth';
import { useCoreSession } from '../hooks/useCoreSession';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * Where the browser lands after an X authorization.
 *
 * Three outcomes arrive here and they are genuinely different things:
 *
 *   - **`code`** — X verified an existing, complete account. Exchange it. The result
 *     may carry no token, which is the expected case rather than a failure: X proved
 *     identity, but the records are locked with the password, so the flow continues
 *     into the normal sign-in.
 *   - **`setup_token`** — an account X created that has no password and therefore no
 *     data key. It cannot store anything yet, so this is a required step, not a
 *     welcome screen.
 *   - **`linked`** — an X account was attached to the signed-in one.
 */

interface XAuthLandingProps {
  navigate: (view: string) => void;
  onPrefillSignIn?: (username: string) => void;
  onSignedIn?: () => void;
}

type Phase = 'working' | 'needs_password' | 'setup' | 'linked' | 'failed';

const XAuthLanding: React.FC<XAuthLandingProps> = ({
  navigate,
  onPrefillSignIn,
  onSignedIn,
}) => {
  const { t } = useTranslation();
  const session = useCoreSession();
  const params = useMemo(() => readXCallbackParams(), []);

  const [phase, setPhase] = useState<Phase>('working');
  const [message, setMessage] = useState('');
  const [username, setUsername] = useState(params.username ?? '');
  const [busy, setBusy] = useState(false);

  // Exchange the one-time code exactly once. It is single-use server-side, so a
  // second invocation (StrictMode, a re-render) would fail and report an error for a
  // sign-in that in fact succeeded.
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    setStarted(true);

    if (params.error) {
      setPhase('failed');
      setMessage(params.error);
      return;
    }
    if (params.linked) {
      setPhase('linked');
      return;
    }
    if (params.setupToken) {
      // An account with no key. There is no session to adopt, so it stays on this
      // screen until a password exists.
      setPhase('setup');
      return;
    }
    if (!params.code) {
      setPhase('failed');
      setMessage(t('core.x.missing'));
      return;
    }

    void (async () => {
      try {
        const result = await coreAuth.exchangeXCode(params.code!);
        setUsername(result.username);
        if (result.token) {
          session.adoptSession(result.token, result.userId, result.username);
          onSignedIn?.();
          navigate('home');
          return;
        }
        // No token: the honest case, and the reason X is an assist rather than a
        // login method.
        setPhase('needs_password');
        onPrefillSignIn?.(result.username);
      } catch (error) {
        setPhase('failed');
        setMessage(error instanceof CoreAuthError ? error.message : t('core.err.generic'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'working') {
    return (
      <Page>
        <p className="flex items-center gap-2.5 text-sm text-[var(--color-m3-on-surface-variant)]">
          <Icon icon={Loader2} size={17} className="animate-spin" />
          {t('core.x.working')}
        </p>
      </Page>
    );
  }

  if (phase === 'linked') {
    return (
      <Page>
        <PageHeader title={t('core.x.linked_title')} />
        <StatusLine
          icon={<Icon icon={CheckCircle2} size={18} className="text-[var(--color-m3-primary)]" />}
          body={(params.handle ? `@${params.handle}. ` : '') + t('core.x.linked_body')}
        />
        <button type="button" onClick={() => navigate('settings')} className="btn-primary mt-6 w-full">
          {t('core.x.back_settings')}
        </button>
      </Page>
    );
  }

  if (phase === 'failed') {
    return (
      <Page>
        <PageHeader title={t('core.x.failed_title')} />
        <StatusLine
          icon={<Icon icon={AlertTriangle} size={18} className="text-[var(--color-m3-error)]" />}
          body={message}
        />
        <div className="mt-6 flex gap-2">
          <button type="button" onClick={() => navigate('home')} className="btn-secondary flex-1">
            {t('core.x.back')}
          </button>
          <button
            type="button"
            onClick={() => {
              // Drop the query string, so a reload cannot replay a spent code.
              window.location.href = window.location.pathname;
            }}
            className="btn-primary flex-1"
          >
            {t('core.x.retry')}
          </button>
        </div>
      </Page>
    );
  }

  if (phase === 'needs_password') {
    return (
      <Page>
        <PageHeader title={t('core.x.identified_title')} />
        {/* The single most important thing to explain in this flow, and the thing a
            user is most likely to find surprising. Given as a reason, not an apology. */}
        <StatusLine body={t('core.x.identified_body')} />
        <button
          type="button"
          onClick={() => {
            onPrefillSignIn?.(username);
            navigate('home');
          }}
          className="btn-primary mt-6 w-full"
        >
          {username ? t('core.x.sign_in_as').replace('{username}', username) : t('core.x.go_signin')}
        </button>
      </Page>
    );
  }

  // phase === 'setup'
  return (
    <Page wide>
      <PageHeader title={t('core.x.setup_title')} intro={t('core.x.setup_body')} />

      <SetupForm
        setupToken={params.setupToken ?? ''}
        secret={params.secret ?? ''}
        username={username}
        busy={busy}
        setBusy={setBusy}
        onDone={(userId, name, token) => {
          session.adoptSession(token, userId, name);
          onSignedIn?.();
          navigate('home');
        }}
      />
    </Page>
  );
};

/**
 * The password-and-code step.
 *
 * Both are collected in one form because the server requires them together: it builds
 * the data key from the password only when a valid code proves the person completing
 * setup is the one who just scanned the secret. Confirming the code in a separate step
 * would be a promise this endpoint cannot keep.
 */
const SetupForm: React.FC<{
  setupToken: string;
  secret: string;
  username: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: (userId: string, username: string, token: string) => void;
}> = ({ setupToken, secret, username, busy, setBusy, onDone }) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const otpauthUri = useMemo(
    () =>
      `otpauth://totp/${encodeURIComponent(`Kira Tracker:${username}`)}?${new URLSearchParams({
        secret,
        issuer: 'Kira Tracker',
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
      }).toString()}`,
    [secret, username],
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        {/* An eyebrow, not a heading: the page's `h1` is the title, and a second
            heading at the same visual weight competed with it. */}
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-m3-on-surface-variant)]">
          1 · {t('core.x.setup_step1')}
        </p>
        <TotpSecretDisplay otpauthUri={otpauthUri} secret={secret} />
      </section>

      <form
        className="space-y-4 border-t border-[var(--color-m3-outline-variant)] pt-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setError(null);
          setBusy(true);
          try {
            const session = await coreAuth.completeXSetup(setupToken, password, code);
            onDone(session.userId, session.username, session.token);
          } catch (err) {
            setError(
              err instanceof CoreAuthError ? err.message : t('core.err.generic'),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-m3-on-surface-variant)]">
          2 · {t('core.x.setup_step2')}
        </p>

        <div className="space-y-1.5">
          <label className="text-sm" htmlFor="xsetup-password">{t('core.x.setup_password')}</label>
          <input
            id="xsetup-password"
            type="password"
            className="input-base"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
          <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
            {t('core.x.setup_password_hint')}
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm" htmlFor="xsetup-code">{t('core.x.setup_code')}</label>
          <input
            id="xsetup-code"
            className="input-base font-mono text-center text-lg tracking-[0.5em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            required
          />
        </div>

        {error && (
          <p
            className="flex items-start gap-1.5 text-xs text-[var(--color-m3-error)]"
            role="alert"
          >
            <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy && <Icon icon={Loader2} size={16} className="animate-spin" />}
          {t('core.x.setup_submit')}
        </button>
      </form>
    </div>
  );
};

/**
 * The X landing's shell.
 *
 * Built to the same shape as the app's other pages: a content column centred on a
 * wide window, a left-aligned header, and the whole thing inside the scrolling
 * region. It previously used `modal-card`, which is why it read as a different
 * product — that class is a dialog (elevated, bordered, 88vh, its own scrollbar),
 * so a full page appeared as one floating box pinned to the left with none of the
 * app's page rhythm. `wide` now means "this column also holds the larger content",
 * not "a bigger dialog".
 *
 * No `scroll-pb-nav`: the bottom tab bar is part of `AppContent`'s shell, and this
 * route renders before that shell exists.
 */
const Page: React.FC<{ children: React.ReactNode; wide?: boolean }> = ({ children, wide }) => (
  <div className="flex min-h-[100dvh] flex-col bg-[var(--color-m3-surface-dim)]">
    <div className="flex-1 overflow-y-auto scrollbar-hide">
      <div
        className={`mx-auto w-full px-6 pb-20 pt-8 md:px-8 md:pt-10 ${wide ? 'max-w-[36rem]' : 'max-w-[32rem]'}`}
      >
        {children}
      </div>
    </div>
  </div>
);

/** The page heading, matching the app's other pages rather than a dialog's. */
const PageHeader: React.FC<{ title: string; intro?: string }> = ({ title, intro }) => (
  <header className="mb-6">
    <h1 className="text-xl font-semibold">{title}</h1>
    {intro && (
      <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-m3-on-surface-variant)]">
        {intro}
      </p>
    )}
  </header>
);

/**
 * A status paragraph under the page title — the body copy for the short phases.
 *
 * The title is now the page's `h1` rather than a line inside this component, so
 * these phases read like a page that happens to be short instead of a dialog with
 * its heading in the wrong place.
 */
const StatusLine: React.FC<{ icon?: React.ReactNode; body: string }> = ({ icon, body }) => (
  <div className="flex items-start gap-2.5">
    {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
    <p className="text-sm leading-relaxed text-[var(--color-m3-on-surface-variant)]">{body}</p>
  </div>
);

export default XAuthLanding;
