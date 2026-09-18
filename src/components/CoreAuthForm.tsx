import React, { useState } from 'react';
import Icon from './Icon';
import { Loader2, AlertTriangle, X } from '../icons';

import TotpEnrollment from './TotpEnrollment';
import TurnstileWidget from './TurnstileWidget';
import { coreAuth, CoreAuthError, type PrivacyMode, type RegistrationResponse } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import { useTranslation } from '../contexts/LanguageContext';
import { passkeysSupported, prfAvailable } from '../utils/passkeys';

/**
 * Sign in or sign up against the Application Core — the credentials, the second
 * factor and the enrolment step, as one component.
 *
 * Extracted from `CoreAuthModal` because there are now two places that need exactly
 * this flow: the modal (reached from a cloud-backup action, or from the MCP page)
 * and the Account page itself, inline. The Account page previously carried a
 * *separate*, Worker-backed sign-in form, so the app had two credential forms for
 * two different backends on one screen, and the one that owned the user's records
 * was the smaller of the two. This is the single form now.
 *
 * Three screens in one component, because they are one task: credentials → second
 * factor → enrol. Splitting them across routes would mean a half-finished sign-in
 * could be navigated away from and lost, and the enrolment token is single-use.
 *
 * The rule the whole flow exists to honour: **a new account cannot be used until its
 * second factor is confirmed.** Registration returns enrolment material and no
 * session, so the flow cannot be dismissed mid-enrolment — see the `onCancel` note
 * below.
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

type Screen = 'credentials' | 'two_factor' | 'enroll' | 'unlock';

const CoreAuthForm: React.FC<CoreAuthFormProps> = ({
    session,
    onSignedIn,
    onDone,
    onCancel,
    initialUsername = '',
    active = true,
}) => {
    const { t } = useTranslation();

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

    // Registration: the chosen data-security mode, and the human-verification token.
    const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('standard');
    const [turnstileToken, setTurnstileToken] = useState('');
    // Bumped to force a fresh challenge after a rejected submit, since a solved
    // token is single use.
    const [turnstileReset, setTurnstileReset] = useState(0);

    // Data unlock (advanced mode): which factor, and the secret for it.
    const [unlockFactor, setUnlockFactor] = useState<'password' | 'recovery'>('password');
    const [unlockSecret, setUnlockSecret] = useState('');

    // Passkeys, probed rather than assumed. `null` means "still checking", so the
    // button does not flash in and out on load.
    const [passkeyReady, setPasskeyReady] = useState<boolean | null>(null);

    React.useEffect(() => {
        if (active && initialUsername) setUsername(initialUsername);
    }, [active, initialUsername]);

    // A locked session is a real state to show, not an error: the identity is known
    // and the only thing missing is the data credential.
    React.useEffect(() => {
        if (session.lockedToken) setScreen('unlock');
    }, [session.lockedToken]);

    // Ask whether X is offered once, when the form becomes active.
    React.useEffect(() => {
        if (!active) return;
        let cancelled = false;
        void coreAuth.xAvailable().then(v => {
            if (!cancelled) setXAvailable(v);
        });
        return () => {
            cancelled = true;
        };
    }, [active]);

    /** Turn a CoreAuthError into something worth reading, per kind. */
    function describe(error: unknown): string {
        if (!(error instanceof CoreAuthError)) return t('core.err.generic');
        switch (error.kind) {
            case 'invalid_credentials':
                // Deliberately vague, matching the server: it cannot tell you which part
                // was wrong, and guessing here would be a lie that teaches the wrong thing.
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

    // Probe passkey support once. `prfAvailable()` creates and discards a throwaway
    // credential, which is the only honest way to know whether the extension actually
    // works — a browser can expose the API and still not honour PRF, and offering the
    // button there would fail at the OS prompt.
    React.useEffect(() => {
        if (!active) return;
        let cancelled = false;
        if (!passkeysSupported()) {
            setPasskeyReady(false);
            return;
        }
        void prfAvailable().then((ok) => {
            if (!cancelled) setPasskeyReady(ok);
        });
        return () => {
            cancelled = true;
        };
    }, [active]);

    /** Sign in with a passkey alone. No username, no password, no TOTP. */
    async function handlePasskey() {
        setError(null);
        setBusy(true);
        try {
            await session.signInWithPasskey();
            finish({});
        } catch (err) {
            setError(err instanceof CoreAuthError ? err.message : t('core.err.generic'));
        } finally {
            setBusy(false);
        }
    }

    /** Shared tail of both successful exits: announce, then let the caller react. */
    function finish(result: { recoveryCodesRemaining?: number }) {
        if (result.recoveryCodesRemaining !== undefined) {
            setNotice(t('core.2fa.recovery_signed_in').replace('{n}', String(result.recoveryCodesRemaining)));
        }
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
                const result = await session.signIn(username, password);
                if (result.step === 'two_factor') {
                    setScreen('two_factor');
                    return;
                }
                finish(result);
            } else {
                // Registration produces enrolment material, not a session.
                const material = await session.register(username, password, {
                    privacyMode,
                    turnstileToken,
                });
                setEnrollment(material);
                setScreen('enroll');
            }
        } catch (err) {
            // A rejected challenge must be re-solved: the token is spent either way.
            setTurnstileReset(v => v + 1);
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

    async function handleUnlock(e: React.FormEvent) {
        e.preventDefault();
        if (busy) return;
        setError(null);
        setBusy(true);
        try {
            await session.unlockData(unlockFactor, unlockSecret);
            setUnlockSecret('');
            onSignedIn?.();
            onDone?.();
        } catch (err) {
            setError(describe(err));
            setUnlockSecret('');
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
            finish(result);
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
        <>
            <div className="flex items-start justify-between gap-3 mb-1">
                <h3 className="modal-title !mb-0">
                    {screen === 'enroll'
                        ? t('core.setup_2fa')
                        : screen === 'unlock'
                            ? t('core.privacy.unlock_title')
                            : isLogin
                                ? t('core.sign_in')
                                : t('core.create_account')}
                </h3>
                {/* Not closable mid-enrolment: the account exists but is unusable, and
                    the single-use enrolment token would be lost with the form. */}
                {onCancel && screen !== 'enroll' && screen !== 'unlock' && (
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
                        onDone?.();
                    }}
                />
            )}

            {/* ── Data unlock (advanced mode) ────────────────────────────────── */}
            {screen === 'unlock' && (
                <form onSubmit={handleUnlock} className="space-y-4">
                    {/* The honest state, spelled out: identity is done, the records are
                        not open. This is not "sign-in failed". */}
                    <p className="text-sm text-[var(--color-m3-on-surface-variant)]  !mt-0">
                        {t('core.privacy.unlock_intro')}
                    </p>
                    {session.lockedUser && (
                        <p className="text-sm font-medium">
                            {t('core.privacy.unlock_as').replace('{username}', session.lockedUser.username)}
                        </p>
                    )}

                    <div className="space-y-1.5">
                        <label className="text-sm" htmlFor="core-unlock-secret">
                            {unlockFactor === 'password'
                                ? t('core.privacy.factor_password')
                                : t('core.privacy.factor_recovery')}
                        </label>
                        <input
                            id="core-unlock-secret"
                            type={unlockFactor === 'password' ? 'password' : 'text'}
                            className={unlockFactor === 'password' ? 'input-base' : 'input-base font-mono'}
                            value={unlockSecret}
                            onChange={(e) =>
                                setUnlockSecret(
                                    unlockFactor === 'password' ? e.target.value : e.target.value.toUpperCase(),
                                )
                            }
                            placeholder={unlockFactor === 'recovery' ? 'XXXX-XXXX-…' : undefined}
                            autoComplete={unlockFactor === 'password' ? 'current-password' : 'off'}
                            autoFocus
                            required
                        />
                    </div>

                    {error && (
                        <p className="text-xs flex items-start gap-1.5 text-[#B3261E]" role="alert">
                            <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
                            <span>{error}</span>
                        </p>
                    )}

                    <button type="submit" disabled={busy} className="btn-primary w-full">
                        {busy && <Icon icon={Loader2} size={16} className="animate-spin" />}
                        {t('core.privacy.unlock_action')}
                    </button>

                    {/* A passkey opens the same data without any secret typed, so it is
                        offered here beside the two secret-based factors. */}
                    {passkeyReady === true && (
                        <button type="button" onClick={handlePasskey} disabled={busy} className="btn-secondary w-full">
                            {t('core.passkey.unlock')}
                        </button>
                    )}

                    <div className="flex flex-col items-center gap-1.5 pt-1">
                        <button
                            type="button"
                            onClick={() => {
                                setUnlockFactor(v => (v === 'password' ? 'recovery' : 'password'));
                                setUnlockSecret('');
                                setError(null);
                            }}
                            className="text-xs text-[var(--color-m3-primary)]  hover:underline"
                        >
                            {unlockFactor === 'password'
                                ? t('core.privacy.use_recovery')
                                : t('core.privacy.use_password')}
                        </button>
                    </div>
                </form>
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

                    {!isLogin && (
                        <div className="space-y-2">
                            <p className="text-sm font-medium">{t('core.privacy.choose_title')}</p>
                            {(['standard', 'advanced'] as PrivacyMode[]).map((mode) => {
                                const selected = privacyMode === mode;
                                return (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => setPrivacyMode(mode)}
                                        aria-pressed={selected}
                                        className={`w-full rounded-xl border p-3 text-left  transition-colors ${
                                            selected
                                                ? 'border-[var(--color-m3-primary)] bg-[var(--color-m3-surface-container)]'
                                                : 'border-[var(--color-m3-outline-variant)]'
                                        }`}
                                        style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
                                    >
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={`h-4 w-4 shrink-0 rounded-full border-2 ${
                                                    selected
                                                        ? 'border-[var(--color-m3-primary)] bg-[var(--color-m3-primary)]'
                                                        : 'border-[var(--color-m3-outline-variant)]'
                                                }`}
                                            />
                                            <span className="text-sm font-medium">
                                                {mode === 'standard'
                                                    ? t('core.privacy.standard_name')
                                                    : t('core.privacy.advanced_name')}
                                            </span>
                                        </span>
                                        <span className="mt-1 block pl-6 text-xs text-[var(--color-m3-on-surface-variant)]">
                                            {mode === 'standard'
                                                ? t('core.privacy.standard_blurb')
                                                : t('core.privacy.advanced_blurb')}
                                        </span>
                                    </button>
                                );
                            })}
                            {privacyMode === 'advanced' && (
                                <p className="text-xs text-[var(--color-m3-on-surface-variant)]">
                                    {t('core.privacy.advanced_warning')}
                                </p>
                            )}
                        </div>
                    )}

                    {!isLogin && (
                        <TurnstileWidget action="register" onToken={setTurnstileToken} resetSignal={turnstileReset} />
                    )}

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

                    {/* Passkey sign-in sits above the X divider and is offered on the
                        sign-in side only: registering does not have a session to
                        attach a credential to yet. */}
                    {isLogin && passkeyReady === true && (
                        <button type="button" onClick={handlePasskey} disabled={busy} className="btn-secondary w-full">
                            {t('core.passkey.sign_in')}
                        </button>
                    )}

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
        </>
    );
};

export default CoreAuthForm;
