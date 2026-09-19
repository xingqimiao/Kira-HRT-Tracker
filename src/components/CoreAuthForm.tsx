import React, { useState } from 'react';
import Icon from './Icon';
import { AlertTriangle, X } from '../icons';
import { Progress } from './ui';

import TurnstileWidget, { TURNSTILE_CONFIGURED } from './TurnstileWidget';
import {
    coreAuth,
    CoreAuthError,
    PROVIDER_NAMES,
    type LoginProvider,
} from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * Sign in or sign up against the Application Core.
 *
 * Extracted from `CoreAuthModal` because there are now two places that need exactly
 * this flow: the modal (reached from a cloud-backup action, or from the MCP page)
 * and the Account page itself, inline. The Account page previously carried a
 * *separate*, Worker-backed sign-in form, so the app had two credential forms for
 * two different backends on one screen, and the one that owned the user's records
 * was the smaller of the two. This is the single form now.
 *
 * One screen. It used to have a second — the "unlock your data" step — which only
 * appeared when a provider sign-in proved identity without handing over the data key.
 * That could only happen to an advanced-mode account, and advanced mode is gone, so
 * a provider sign-in now always yields a real session and there is nothing to unlock.
 */

interface CoreAuthFormProps {
    session: CoreSession;
    /** Called once a session exists, so the app can load records. */
    onSignedIn?: () => void;
    /** Called when the flow finishes successfully. In the modal this closes it. */
    onDone?: () => void;
    /**
     * Renders a close control when given. Omitted inline on the Account page, where
     * there is nothing to close — the form is the page.
     */
    onCancel?: () => void;
    /** Pre-fill the username — used when X identified the account but cannot unlock it. */
    initialUsername?: string;
    /** Ask whether X sign-in is offered. Skipped when the form is not presented yet. */
    active?: boolean;
}

const CoreAuthForm: React.FC<CoreAuthFormProps> = ({
    session,
    onSignedIn,
    onDone,
    onCancel,
    initialUsername = '',
    active = true,
}) => {
    const { t } = useTranslation();

    const [isLogin, setIsLogin] = useState(true);
    const [username, setUsername] = useState(initialUsername);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Null until `/health` has answered, so neither button is offered on a guess.
    const [providers, setProviders] = useState<{ x: boolean; google: boolean } | null>(null);

    // Registration: the human-verification token, and the reset that forces a fresh
    // challenge after a rejected submit (a solved token is single use).
    const [turnstileToken, setTurnstileToken] = useState('');
    const [turnstileReset, setTurnstileReset] = useState(0);

    // "Keep me signed in": asks the server for a session with no expiry, so only the
    // device list or a password change ends it. Off by default, because a shared
    // computer should not stay signed in because someone did not notice a checkbox.
    const [keepSignedIn, setKeepSignedIn] = useState(false);

    /**
     * Whether the challenge is satisfied, or whether there is none to satisfy.
     *
     * A deployment with no Turnstile configured reports an empty token and expects
     * submission anyway, so gating on the token alone would disable every button on
     * it. `TURNSTILE_CONFIGURED` is the build-time half of that distinction.
     */
    const verified = !TURNSTILE_CONFIGURED || turnstileToken !== '';

    React.useEffect(() => {
        if (active && initialUsername) setUsername(initialUsername);
    }, [active, initialUsername]);

    // Ask which providers are offered once, when the form becomes active.
    React.useEffect(() => {
        if (!active) return;
        let cancelled = false;
        void coreAuth.loginProviders().then(v => {
            if (!cancelled) setProviders(v);
        });
        return () => {
            cancelled = true;
        };
    }, [active]);

    /** The message for a failure, per kind. `provider` names the one that was refused. */
    function describe(error: unknown, provider?: LoginProvider): string {
        if (!(error instanceof CoreAuthError)) return t('core.err.generic');
        switch (error.kind) {
            case 'invalid_credentials':
                // Deliberately vague, matching the server: it cannot tell you which part
                // was wrong, and guessing here would be a lie that teaches the wrong thing.
                return t('core.err.bad_credentials');
            case 'locked':
                return t('core.err.locked');
            case 'rate_limited':
                return t('core.err.rate_limited');
            case 'not_configured':
                // Only a provider's start call reports this, so only that caller can
                // name the provider it was refused for.
                return provider
                    ? t('core.err.oauth_unavailable').replace('{provider}', PROVIDER_NAMES[provider])
                    : t('core.err.generic');
            case 'network':
                return t('core.err.network');
            default:
                return error.message || t('core.err.generic');
        }
    }

    /** Shared tail of both successful exits: announce, then let the caller react. */
    function finish() {
        onSignedIn?.();
        onDone?.();
    }

    async function handleCredentials(e: React.FormEvent) {
        e.preventDefault();
        if (busy) return;
        setError(null);
        setBusy(true);
        try {
            if (isLogin) {
                await session.signIn(username, password, { persistent: keepSignedIn });
            } else {
                await session.register(username, password, { turnstileToken, persistent: keepSignedIn });
            }
            finish();
        } catch (err) {
            // A rejected challenge must be re-solved: the token is spent either way.
            setTurnstileReset(v => v + 1);
            setError(describe(err));
        } finally {
            setBusy(false);
        }
    }

    /**
     * Leave for a provider's authorization page.
     *
     * The same call for both providers, because the server treats them identically and
     * only the brand name differs.
     */
    async function handleProvider(provider: LoginProvider) {
        setError(null);
        setBusy(true);
        try {
            const { authorizeUrl } = await coreAuth.startOAuth(provider, 'login', {
                turnstileToken,
                // Only the sign-up screen asks the server for verification; see the
                // note on `startOAuth` for why a plain sign-in must not be gated.
                ...(isLogin ? {} : { intent: 'register' as const }),
                // Carried through the round trip by the service, because this screen is
                // unloaded the moment the browser leaves for the provider.
                persistent: keepSignedIn,
            });
            // Full navigation, not a popup: the callback is on the API host and returns
            // the browser to a landing route, which a popup would break out of.
            window.location.href = authorizeUrl;
        } catch (err) {
            setError(describe(err, provider));
            setBusy(false);
        }
    }

    return (
        <>
            <div className="flex items-start justify-between gap-3 mb-1">
                <h3 className="modal-title !mb-0">
                    {isLogin ? t('core.sign_in') : t('core.create_account')}
                </h3>
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        aria-label={t('core.close')}
                        className="-mr-1 -mt-1 p-1.5 rounded-full hover:bg-[var(--color-m3-surface-container)]  transition-colors"
                        style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
                    >
                        <Icon icon={X} size={17} />
                    </button>
                )}
            </div>

            {/* ── Credentials ────────────────────────────────────────────────── */}
            <form onSubmit={handleCredentials} className="space-y-5">
                    <p className="text-sm text-[var(--color-m3-on-surface-variant)]  !mt-0">
                        {isLogin ? t('core.signin.intro') : t('core.signup.intro')}
                    </p>

                    {/* Fields, grouped. MD3 puts related inputs in one block with a
                        consistent 16dp rhythm rather than one gap per element. */}
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium" htmlFor="core-username">
                                {t('core.username')}
                            </label>
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
                            <label className="text-sm font-medium" htmlFor="core-password">
                                {t('core.password')}
                            </label>
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
                                // Supporting text belongs to its field rather than loose in
                                // the form, where it stops reading as advice about the
                                // password above it.
                                <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
                                    {t('core.signup.hint')}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Offered on both credential paths, because both open a session and
                        both can open a long-term one. Off by default: a shared machine
                        should not stay signed in because nobody noticed a checkbox. */}
                    <label className="flex items-center gap-2 text-sm text-[var(--color-m3-on-surface-variant)] cursor-pointer select-none">
                        <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--color-m3-primary)]"
                            checked={keepSignedIn}
                            onChange={(e) => setKeepSignedIn(e.target.checked)}
                        />
                        {t('core.signin.keep')}
                    </label>

                    {error && (
                        <p className="text-xs flex items-start gap-1.5 text-cos-error" role="alert">
                            <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
                            <span>{error}</span>
                        </p>
                    )}

                    {/* On the register screen the challenge sits above the submit, because
                        it gates that button *and* the provider buttons below the divider —
                        one placement, one token, both paths. On the login screen the password
                        button is not gated (it has its own lockout), so the widget belongs
                        with the providers instead. */}
                    {!isLogin && (
                        <>
                            <TurnstileWidget action="register" onToken={setTurnstileToken} resetSignal={turnstileReset} />
                            {TURNSTILE_CONFIGURED && !verified && (
                                <p className="text-xs text-center text-[var(--color-m3-on-surface-variant)] !mt-2">
                                    {t('core.oauth.verify_required')}
                                </p>
                            )}
                        </>
                    )}

                    <button
                        type="submit"
                        disabled={busy || (!isLogin && !verified)}
                        className="btn-primary w-full"
                    >
                        {busy && <Progress size={16} />}
                        {isLogin ? t('core.sign_in') : t('core.create_account')}
                    </button>

                    {(providers?.x || providers?.google) && (
                        <div className="space-y-3">
                            <div className="flex items-center gap-2">
                                {/* MD3 divider: 1dp of outline-variant, no shadow. */}
                                <div className="h-px flex-1 bg-[var(--color-m3-outline-variant)]" />
                                <span className="text-xs text-[var(--color-m3-on-surface-variant)]">
                                    {t('core.or')}
                                </span>
                                <div className="h-px flex-1 bg-[var(--color-m3-outline-variant)]" />
                            </div>

                            <div className="space-y-2">
                                {(['x', 'google'] as LoginProvider[]).filter(p => providers?.[p]).map(provider => (
                                    <button
                                        key={provider}
                                        type="button"
                                        onClick={() => handleProvider(provider)}
                                        disabled={busy || (!isLogin && !verified)}
                                        aria-label={t('core.oauth.continue').replace('{provider}', PROVIDER_NAMES[provider])}
                                        className="btn-secondary w-full"
                                    >
                                        {t('core.oauth.continue').replace('{provider}', PROVIDER_NAMES[provider])}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* One footer block, so the way out of this form and the legal line
                        read as a single closing section instead of two stray paragraphs.

                        The privacy line sits above the sign-in/register switch, not below
                        it: it qualifies the account being created, so it belongs with the
                        form's own content rather than after the link that leaves it. */}
                    <div className="space-y-2 pt-1">
                        {!isLogin && (
                            <p className="text-xs text-center">
                                {/* Opened in a new tab so reading it does not throw away a
                                    half-filled form. The whole sentence is the link: split
                                    into a label and a fragment it reads as broken grammar in
                                    half the seven languages this app ships. */}
                                <a
                                    href="https://kiramyao.com/privacy"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[var(--color-m3-on-surface-variant)]  underline underline-offset-2 hover:text-[var(--color-m3-primary)]"
                                >
                                    {t('core.signup.privacy')}
                                </a>
                            </p>
                        )}

                        <p className="text-center text-sm text-[var(--color-m3-on-surface-variant)] ">
                            {isLogin ? t('core.signin.no_account') : t('core.signin.has_account')}{' '}
                            <button
                                type="button"
                                onClick={() => {
                                    setIsLogin(v => !v);
                                    setError(null);
                                }}
                                className="text-[var(--color-m3-primary)]  hover:underline"
                            >
                                {isLogin ? t('core.signin.go_register') : t('core.signin.go_login')}
                            </button>
                        </p>
                    </div>
            </form>
        </>
    );
};

export default CoreAuthForm;
