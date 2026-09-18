import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon';
import { CheckCircle2, Loader2, AlertTriangle } from '../icons';

import {
  coreAuth,
  CoreAuthError,
  PROVIDER_NAMES,
  readAuthCallbackParams,
  type LoginProvider,
} from '../services/coreAuth';
import { useCoreSession } from '../hooks/useCoreSession';
import { useTranslation } from '../contexts/LanguageContext';
import type { ViewKey } from '../hooks/useAppNavigation';

/**
 * Where the browser lands after an X or Google authorization.
 *
 * Two outcomes arrive here and they are genuinely different things:
 *
 *   - **`code`** — the provider verified an existing, complete account. Exchange it. The
 *     result may carry no token, which is the expected case rather than a failure: the
 *     provider proved identity, but the records are locked with the password, so the flow
 *     continues into the normal sign-in.
 *   - **`linked`** — a provider account was attached to the signed-in one.
 *
 * One component for both providers, because the two flows are the same flow: the server
 * answers the same shapes, and only the brand name in the copy differs.
 */

interface OAuthLandingProps {
  /** Which provider sent the browser here. */
  provider: LoginProvider;
  /**
     * Leave the landing for a view in the app.
     *
     * The landing renders instead of the app shell — it has to, so the spent
     * callback code is cleaned before anything else runs — so it cannot switch
     * views in place. The destination and any username are persisted, the page
     * reloads, and App applies them on the other side.
     */
  navigate: (view: ViewKey, options?: { username?: string }) => void;
  onPrefillSignIn?: (username: string) => void;
  onSignedIn?: () => void;
}

type Phase = 'working' | 'needs_password' | 'linked' | 'failed';

const OAuthLanding: React.FC<OAuthLandingProps> = ({
  provider,
  navigate,
  onPrefillSignIn,
  onSignedIn,
}) => {
  const { t: translate } = useTranslation();
  const session = useCoreSession();
  const params = useMemo(() => readAuthCallbackParams(), []);

  /**
   * The copy names a provider in almost every sentence, so it travels as a placeholder
   * rather than as a second set of translated strings: fifteen sentences saying "X" and
   * fifteen saying "Google" would be thirty places for the two flows to drift apart.
   */
  const t = (key: string) => translate(key).replaceAll('{provider}', PROVIDER_NAMES[provider]);

  const [phase, setPhase] = useState<Phase>('working');
  const [message, setMessage] = useState('');
  const [username, setUsername] = useState(params.username ?? '');

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
    if (!params.code) {
      setPhase('failed');
      setMessage(t('core.oauth.missing'));
      return;
    }

    void (async () => {
      try {
        const result = await coreAuth.exchangeOAuthCode(provider, params.code!);
        setUsername(result.username);
        if (result.token) {
          session.adoptSession(result.token, result.userId, result.username);
          onSignedIn?.();
          navigate('home');
          return;
        }
        // No token. In advanced mode a locked token comes with it: the provider proved
        // identity, the data is sealed, and that is a legitimate state to show — not a
        // failure.
        if (result.lockedToken) {
          session.adoptLockedSession(result.lockedToken, result.userId, result.username);
          setPhase('needs_password');
          return;
        }
        // Standard-shape fallback: identity known, no locked session to carry it. The
        // user finishes with the normal password sign-in.
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
          {t('core.oauth.working')}
        </p>
      </Page>
    );
  }

  if (phase === 'linked') {
    return (
      <Page>
        <PageHeader title={t('core.oauth.linked_title')} />
        <StatusLine
          icon={<Icon icon={CheckCircle2} size={18} className="text-[var(--color-m3-primary)]" />}
          // Google sends no handle, so this reads as the plain sentence rather than
          // rendering an empty `@` or a placeholder for a handle that never existed.
          body={(params.handle ? `@${params.handle}. ` : '') + t('core.oauth.linked_body')}
        />
        <button type="button" onClick={() => navigate('account')} className="btn-primary mt-6 w-full">
          {t('core.oauth.back_settings')}
        </button>
      </Page>
    );
  }

  if (phase === 'failed') {
    return (
      <Page>
        <PageHeader title={t('core.oauth.failed_title')} />
        <StatusLine
          icon={<Icon icon={AlertTriangle} size={18} className="text-[var(--color-m3-error)]" />}
          body={message}
        />
        <div className="mt-6 flex gap-2">
          <button type="button" onClick={() => navigate('home')} className="btn-secondary flex-1">
            {t('core.oauth.back')}
          </button>
          <button
            type="button"
            onClick={() => {
              // Drop the query string, so a reload cannot replay a spent code.
              window.location.href = window.location.pathname;
            }}
            className="btn-primary flex-1"
          >
            {t('core.oauth.retry')}
          </button>
        </div>
      </Page>
    );
  }

  // phase === 'needs_password' — the only phase left once the branches above have
  // returned. With a locked token this is advanced mode: identity is proven and the
  // records are sealed. Saying "verified" rather than "failed" is the whole point of
  // separating authentication from data unlock, so the copy and the single action
  // both reflect that.
  const locked = !!session.lockedToken;
  return (
    <Page>
      <PageHeader title={locked ? t('core.oauth.verified_title') : t('core.oauth.identified_title')} />
      <StatusLine body={locked ? t('core.oauth.verified_body') : t('core.oauth.identified_body')} />
      <button
        type="button"
        onClick={() => {
          if (locked) {
            navigate('account');
            return;
          }
          onPrefillSignIn?.(username);
          navigate('account', { username });
        }}
        className="btn-primary mt-6 w-full"
      >
        {locked
          ? t('core.privacy.unlock_action')
          : username
            ? t('core.oauth.sign_in_as').replace('{username}', username)
            : t('core.oauth.go_signin')}
      </button>
    </Page>
  );
};

/**
 * The landing's shell.
 *
 * Built to the same shape as the app's other pages: a content column centred on a
 * wide window, a left-aligned header, and the whole thing inside the scrolling
 * region. It previously used `modal-card`, which is why it read as a different
 * product — that class is a dialog (elevated, bordered, 88vh, its own scrollbar),
 * so a full page appeared as one floating box pinned to the left with none of the
 * app's page rhythm.
 *
 * No `scroll-pb-nav`: the bottom tab bar is part of `AppContent`'s shell, and this
 * route renders before that shell exists.
 */
const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex min-h-[100dvh] flex-col bg-[var(--color-m3-surface-dim)]">
    <div className="flex-1 overflow-y-auto scrollbar-hide">
      <div className="mx-auto w-full max-w-[32rem] px-6 pb-20 pt-8 md:px-8 md:pt-10">
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

export default OAuthLanding;
