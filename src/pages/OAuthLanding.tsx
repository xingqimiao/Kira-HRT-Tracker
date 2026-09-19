import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon';
import { CheckCircle2, AlertTriangle } from '../icons';
import { Progress } from '../components/ui';

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
 *   - **`code`** — exchange it for a session. A provider sign-in always yields one
 *     now: it used to be able to come back with identity proven and the data key
 *     withheld, which the flow finished by sending the user to the sign-in form, but
 *     that could only happen in the advanced privacy mode and the mode is gone.
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
     * views in place. The destination is persisted, the page reloads, and App
     * applies it on the other side.
     */
  navigate: (view: ViewKey, options?: { username?: string }) => void;
  onSignedIn?: () => void;
}

type Phase = 'working' | 'linked' | 'failed';

const OAuthLanding: React.FC<OAuthLandingProps> = ({
  provider,
  navigate,
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
        // A provider sign-in always yields a session. It used to be able to return a
        // "locked" outcome — identity proven, data key withheld — which is what the
        // `needs_password` screen below existed for, but that could only happen to an
        // advanced-mode account and the mode is gone. No token now means something went
        // wrong, and saying so is better than sending the user to a sign-in form to
        // solve a problem that is not theirs.
        if (!result.token) {
          setPhase('failed');
          setMessage(t('core.err.generic'));
          return;
        }
        session.adoptSession(result.token, result.userId, result.username);
        onSignedIn?.();
        navigate('home');
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
          <Progress size={17} />
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

  // The three phases above cover every outcome — `linked`, `failed`, and the working
  // state — so there is no fall-through screen. There used to be a fourth for a
  // provider sign-in that proved identity without handing over the key.
  return null;
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
    <h1 className="text-m3-title-xl">{title}</h1>
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
