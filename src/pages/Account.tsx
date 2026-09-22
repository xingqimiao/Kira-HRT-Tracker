import React, { useEffect, useState } from 'react';
import Icon from '../components/Icon';
import { Link2, LogOut, ShieldCheck, UserCircle } from '../icons';
import { Progress } from '../components/ui';
import CoreAuthForm from '../components/CoreAuthForm';
import { SettingsListItem, settingsMuted } from '../components/SettingsListItem';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { coreAuth, type AccountSummary, type LoginMethods } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import type { CoreSyncStatus } from '../hooks/useCoreSync';
import { hrtDaysSince } from '../utils/hrtStart';

interface AccountProps {
    session: CoreSession;
    /** Opens the Core account-security page. */
    onNavigateToSecurity: () => void;
    /** Moves to a ViewKey — used for the MCP page. */
    onNavigate: (view: string) => void;
    /**
     * The Core sync's live status.
     *
     * Shown here because this is the page that answers "is my record saved" — and
     * until now nothing displayed it at all. `useCoreSync` reported a status nobody
     * rendered, so a failing sync was invisible on the one screen a user would visit
     * to check.
     */
    syncStatus: CoreSyncStatus;
    lastSyncedAt: number | null;
    /** Runs a sync now. Present so the status row can be acted on, not just read. */
    onSyncNow: () => void;
    /**
     * A username to pre-fill the sign-in form with.
     *
     * Set when the X landing sent the user here: X has just confirmed who they are,
     * so asking them to type the same name again is a step with no purpose. It
     * previously reached only the modal, so the inline form — the one on this page —
     * came up empty.
     */
    initialUsername?: string;
    /** Opens the fallback-credential screen, offered while this account has no password. */
    onBindCredentials: () => void;
    /**
     * `YYYY-MM-DD` from the intro's start-date question, or '' when it was
     * skipped — in which case the day-count line is not rendered at all. An
     * account-scoped setting, so it arrives here through the same bag as the
     * calibration preferences.
     */
    hrtStartDate?: string;
}

const divider = 'border-b border-[var(--color-m3-outline-variant)] ';
const sectionLabel = 'text-xs font-semibold text-[var(--color-m3-on-surface-variant)]  mb-2 block';
const on = 'text-[var(--color-m3-on-surface)] ';
const muted = settingsMuted;

/**
 * The account page: one identity, the Core's.
 *
 * ── What changed, and why ────────────────────────────────────────────────────
 *
 * This page used to present **two** sign-ins at once. The inline form belonged to a
 * second, legacy backend (cloud backup, its own password, its own session list) and
 * the Core — the backend that actually holds the records — was a pair of rows opening
 * a *modal* underneath it. So the form a visitor saw first belonged to the backend
 * they did not need, and the one that owned their data was hidden behind a link.
 *
 * That was backwards, and it was visible the moment you signed in: the other form
 * stayed on screen while the Core showed as signed in. Two identities, two
 * credential stores, no way to tell from the page which one you were in.
 *
 * Now there is one form, and it is the Core's: the same `CoreAuthForm` the modal
 * renders, so the two cannot drift. The second backend's rows (cloud backup, its
 * password, its session list, profile and avatar) went with that backend when it was
 * removed.
 */
const Account: React.FC<AccountProps> = ({
    session,
    onNavigateToSecurity,
    onNavigate,
    syncStatus,
    lastSyncedAt,
    onSyncNow,
    initialUsername,
    onBindCredentials,
    hrtStartDate,
}) => {
    const { t } = useTranslation();
    // Null when the date is absent, unusable, or still in the future — the line
    // then simply does not render.
    const daysSinceStart = hrtDaysSince(hrtStartDate);
    const { showDialog } = useDialog();
    const [summary, setSummary] = useState<AccountSummary | null>(null);
    const [methods, setMethods] = useState<LoginMethods | null>(null);

    const token = session.token;

    useEffect(() => {
        if (!token) { setSummary(null); setMethods(null); return; }
        let cancelled = false;
        void Promise.all([
            coreAuth.summary(token),
            // Null on failure rather than a scream: this only decides whether a
            // suggestion is shown, and a suggestion that cannot be read is not an error
            // worth putting in front of someone who came here to look at their account.
            coreAuth.loginMethods(token).catch(() => null),
        ])
            .then(([s, m]) => { if (!cancelled) { setSummary(s); setMethods(m); } })
            .catch(() => { if (!cancelled) { setSummary(null); setMethods(null); } });
        return () => { cancelled = true; };
    }, [token]);

    const handleSignOut = () => {
        showDialog('confirm', t('core.acct.sign_out_confirm'), () => { void session.signOut(); });
    };

    return (
        <div className="relative pb-36 px-6 md:px-10">
            <h1 className={`sticky top-0 z-20 -mx-6 md:-mx-10 px-6 md:px-10 pt-8 pb-3 mb-3 bg-[var(--color-m3-surface-dim)]  text-m3-title-xl ${on}`}>
                {t('account.title')}
            </h1>

            {/* Restoring a stored session: a spinner rather than the sign-in form, so a
                returning user is not shown a login box for a session that is about to
                appear. */}
            {session.restoring ? (
                <div className="flex justify-center py-16">
                    <Progress size={22} />
                </div>
            ) : session.isSignedIn ? (
                <div className="mx-auto w-full max-w-2xl">
                    {/* The one way in is a social provider, so losing it loses the
                        account. Said here, before the server has to refuse a record,
                        because afterwards is too late to be useful. */}
                    {methods?.recoveryRisk && (
                        <div className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container)] p-4">
                            <p className="text-sm leading-relaxed">{t('core.bind.banner')}</p>
                            <button type="button" onClick={onBindCredentials} className="btn-primary mt-3 w-full">
                                {t('core.bind.action')}
                            </button>
                        </div>
                    )}

                    {/* Identity. The account's avatar when there is one, and the generic
                        glyph when there is not — the same rule the provider rows below
                        use, so this either shows the picture copied at link/sign-in time
                        or reads as a deliberate placeholder rather than a missing image.
                        The URL is the API's own, re-serving that copy. It is never the
                        provider's: `img-src 'self'` blocks those, and hotlinking one
                        would announce every visit to this page to X or Google. */}
                    <div className={`flex items-center gap-3 py-5 ${divider}`}>
                        {summary?.avatarUrl ? (
                            <img
                                src={summary.avatarUrl}
                                alt=""
                                className="w-9 h-9 rounded-full object-cover shrink-0"
                                // A broken fetch must not leave a torn glyph; degrading to
                                // the placeholder is better than an empty hole. `hidden`
                                // rather than an inline display style, because React keeps
                                // this node when the summary refreshes and a stale
                                // `display:none` would outlive a perfectly good new URL.
                                onError={(e) => { e.currentTarget.hidden = true; }}
                            />
                        ) : (
                            <Icon icon={UserCircle} size={36} strokeWidth={1.5} className={`${muted} shrink-0`} />
                        )}
                        <div className="min-w-0">
                            <p className={`${on} font-semibold text-lg truncate`}>
                                {session.user?.username ?? t('core.acct.signed_in_as')}
                            </p>
                            {/* Held open rather than conditionally rendered: this line and
                                the counts below both come from the server, and letting them
                                appear a beat after the page slid in read as the pane moving
                                on its own. The height is theirs from the first frame. */}
                            <p className={`text-xs ${muted} tabular-nums`}>
                                {summary?.createdAt
                                    ? t('core.acct.created').replace('{date}', summary.createdAt.slice(0, 10))
                                    : '\u00A0'}
                            </p>
                        </div>
                    </div>

                    {/* The one thing the intro's date question is for. Its own row
                        rather than a caption on the identity block: it is a fact
                        about the person, not about the sign-in. */}
                    {daysSinceStart !== null && (
                        <div className={`py-4 ${divider}`}>
                            <p className={`text-m3-body-medium ${on}`}>
                                {t('account.hrt_started').replace('{days}', String(daysSinceStart))}
                            </p>
                        </div>
                    )}

                    {/* What the account holds. Counts only — the record contents are
                        ciphertext server-side, so this is all that can be shown. */}
                    <div className={`py-4 ${divider}`}>
                        <span className={sectionLabel}>{t('core.acct.your_records')}</span>
                        <div className="flex gap-8">
                            <div>
                                <p className={`${on} text-2xl font-semibold tabular-nums`}>{summary ? summary.doseCount : '—'}</p>
                                <p className={`text-xs ${muted}`}>{t('core.acct.doses')}</p>
                            </div>
                            <div>
                                <p className={`${on} text-2xl font-semibold tabular-nums`}>{summary ? summary.labCount : '—'}</p>
                                <p className={`text-xs ${muted}`}>{t('core.acct.labs')}</p>
                            </div>
                        </div>
                    </div>

                    {/* Sync. Beside the record counts because the two answer one
                        question between them: what the account holds, and whether it
                        has been saved. */}
                    <div className={`flex items-center justify-between gap-3 py-4 ${divider}`}>
                        <div className="min-w-0">
                            <p className={`text-m3-body-medium ${on}`}>{t('sync.title')}</p>
                            <p className={`text-xs ${muted} mt-0.5`}>
                                {t(`sync.status.${syncStatus}`)}
                                {lastSyncedAt !== null && syncStatus !== 'off' && (
                                    <> · {t('sync.last_synced').replace('{time}', new Date(lastSyncedAt).toLocaleTimeString())}</>
                                )}
                            </p>
                        </div>
                        <button
                            onClick={onSyncNow}
                            disabled={syncStatus === 'syncing' || syncStatus === 'off'}
                            className={`shrink-0 text-sm font-medium text-[var(--color-m3-primary)] hover:underline disabled:opacity-40 disabled:no-underline`}
                        >
                            {syncStatus === 'syncing'
                                ? <Progress size={14} />
                                : t('sync.now')}
                        </button>
                    </div>

                    {/* Where to go next. Both live here rather than in Settings → About
                        because both act on this account: security manages its
                        credentials, and a token can only be minted against a session. */}
                    <div className="py-4">
                        <span className={sectionLabel}>{t('core.acct.title')}</span>
                        <SettingsListItem
                            icon={ShieldCheck}
                            title={t('settings.security')}
                            description={t('settings.security_desc')}
                            onClick={onNavigateToSecurity}
                        />
                        <SettingsListItem
                            icon={Link2}
                            title={t('mcp.title')}
                            description={t('mcp.row_desc')}
                            onClick={() => onNavigate('settings-mcp')}
                        />
                    </div>

                    <button
                        onClick={handleSignOut}
                        className={`w-full flex items-center gap-2.5 py-4 ${muted} hover:${on} transition-colors`}
                    >
                        <Icon icon={LogOut} size={16} strokeWidth={1.5} />
                        {t('core.acct.sign_out')}
                    </button>
                </div>
            ) : (
                /* The one sign-in form in the app, rendered inline. `onCancel` is
                   deliberately absent: there is nothing to close, the form is the page. */
                <div className="mx-auto w-full max-w-sm">
                    <CoreAuthForm session={session} initialUsername={initialUsername} />
                </div>
            )}

            {/* The credit link at the end of the page content. Sits in normal flow so
                it never collides with form buttons on short mobile viewports (e.g. Via
                browser), and clears the floating navigation bar via the container's bottom padding. */}
            <footer className="mt-8 pb-4 text-center">
                <a
                    href="https://kiramyao.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block py-2 text-m3-body-compact text-[var(--color-m3-on-surface-variant)] transition-colors hover:text-[var(--color-m3-primary)]"
                >
                    Powered by KiraEqual
                </a>
            </footer>
        </div>
    );
};

export default Account;
