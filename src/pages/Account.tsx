import React, { useEffect, useState } from 'react';
import Icon from '../components/Icon';
import { Link2, LogOut, ShieldCheck, UserCircle, ChevronDown, X } from '../icons';
import { Progress } from '../components/ui';
import CoreAuthForm from '../components/CoreAuthForm';
import DateTimePicker from '../components/DateTimePicker';
import { SettingsListItem, settingsMuted } from '../components/SettingsListItem';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { coreAuth, type AccountSummary, type LoginMethods } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import type { CoreSyncStatus } from '../hooks/useCoreSync';
import { hrtDaysSince, toYmd, fromYmd } from '../utils/hrtStart';
import { LOCALE_MAP } from '../utils/helpers';

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
    /**
     * Writes the start date back. It lives on the account page because the intro
     * that used to be the only place to set it is a replay now, and a replay must
     * not write — so the editable copy belongs where an account change belongs.
     */
    onHrtStartChange: (value: string) => void;
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
    onHrtStartChange,
}) => {
    const { t, lang } = useTranslation();
    // Null when the date is absent, unusable, or still in the future — the line
    // then simply does not render.
    const daysSinceStart = hrtDaysSince(hrtStartDate);
    const { showDialog } = useDialog();
    const [summary, setSummary] = useState<AccountSummary | null>(null);
    const [methods, setMethods] = useState<LoginMethods | null>(null);
    const [isStartPickerOpen, setIsStartPickerOpen] = useState(false);

    // Today, for the picker's ceiling: a start date in the future would make the
    // day count negative, which `hrtDaysSince` then refuses to show at all.
    const now = new Date();
    const today = toYmd(now);

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
        // The credit below is pushed to the floor of the page rather than trailing the
        // content, which needs the column to be at least as tall as the viewport.
        // `min-h` is measured against `svh` minus the bottom bar's reserve, not `h-full`,
        // because the wrapper this sits in is a plain block with no height to inherit —
        // `h-full` resolves against nothing and collapses to the content height again.
        //
        // The 92px is the floating bar (the same figure `scroll-pb-nav` reserves) and
        // the `2.5rem` is the shared wrapper's own `pb-10`: without it the page ran
        // 40px past the viewport and the credit sat one scroll-length above the bar.
        // Past 840px the rail replaces the bar and reserves nothing, so only the
        // wrapper's padding is left to subtract — 840 being the breakpoint the shell
        // itself switches over at, not one of Tailwind's.
        //
        // `pb-36` is gone: the scroll container already reserves the bar, and carrying
        // both left ~220px of dead space above the credit.
        <div className="relative flex min-h-[calc(100svh-92px-env(safe-area-inset-bottom,0px)-2.5rem)] flex-col px-6 min-[840px]:min-h-[calc(100svh-2.5rem)] md:px-10">
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
                                key={summary.avatarUrl}
                                className="m3-content-in w-9 h-9 rounded-full object-cover shrink-0"
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

                    {/* The start date and the day count it produces, in one row:
                        the count is the answer, the date is the input, and
                        splitting them would put a fact about the person away from
                        the control that produces it.

                        Editable here rather than in the intro, which is a replay
                        now and must not write back — a stray tap in a re-read
                        would replace a date set months ago. This is the account
                        page's own copy, so the setting still has a home. */}
                    <div className={`py-4 ${divider}`}>
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className={`text-m3-body-medium ${on}`}>{t('account.hrt_start_label')}</p>
                                {daysSinceStart !== null && (
                                    <p className={`text-xs ${muted} mt-0.5`}>
                                        {t('account.hrt_started').replace('{days}', String(daysSinceStart))}
                                    </p>
                                )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => setIsStartPickerOpen(v => !v)}
                                    aria-expanded={isStartPickerOpen}
                                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium tabular-nums text-[var(--color-m3-primary)] transition-colors hover:bg-[var(--color-m3-surface-container)]"
                                >
                                    {hrtStartDate
                                        ? fromYmd(hrtStartDate).toLocaleDateString(LOCALE_MAP[lang] || 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                                        : t('account.hrt_start_set')}
                                    <Icon
                                        icon={ChevronDown}
                                        size={14}
                                        className={`shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${isStartPickerOpen ? 'rotate-180' : ''}`}
                                    />
                                </button>
                                {/* Only when there is something to clear, the same
                                    rule the intro's copy of this control uses. */}
                                {hrtStartDate && (
                                    <button
                                        type="button"
                                        onClick={() => { onHrtStartChange(''); setIsStartPickerOpen(false); }}
                                        aria-label={t('onboarding.start_clear')}
                                        title={t('onboarding.start_clear')}
                                        className="rounded-md p-1.5 text-[var(--color-m3-on-surface-variant)] transition-colors hover:bg-[var(--color-m3-surface-container)] hover:text-cos-error"
                                    >
                                        <Icon icon={X} size={14} />
                                    </button>
                                )}
                            </div>
                        </div>
                        {/* DateTimePicker's inline mode owns the unfolding motion. */}
                        <DateTimePicker
                            isOpen={isStartPickerOpen}
                            inline
                            mode="date"
                            onClose={() => setIsStartPickerOpen(false)}
                            onConfirm={(date) => {
                                // Clamped to today: the picker has no max, and a future
                                // start would make the account's day count negative.
                                const picked = toYmd(date);
                                onHrtStartChange(picked > today ? today : picked);
                            }}
                            initialDate={hrtStartDate ? fromYmd(hrtStartDate) : now}
                            title={t('account.hrt_start_label')}
                        />
                    </div>

                    {/* What the account holds. Counts only — the record contents are
                        ciphertext server-side, so this is all that can be shown. */}
                    <div className={`py-4 ${divider}`}>
                        <span className={sectionLabel}>{t('core.acct.your_records')}</span>
                        <div className="flex gap-8">
                            <div>
                                <p className={`${on} text-2xl font-semibold tabular-nums ${summary ? 'm3-content-in' : ''}`}>{summary ? summary.doseCount : '—'}</p>
                                <p className={`text-xs ${muted}`}>{t('core.acct.doses')}</p>
                            </div>
                            <div>
                                <p className={`${on} text-2xl font-semibold tabular-nums ${summary ? 'm3-content-in' : ''}`}>{summary ? summary.labCount : '—'}</p>
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

            {/* The credit link, pinned to the floor of the page. `mt-auto` takes the
                slack in the column above, so it sits at the bottom of the scroll area
                whether the account holds a few rows or many; the `pt-8` is what keeps
                it clear of the content when there is no slack to take. Normal flow, not
                fixed, so it never collides with the floating navigation bar. */}
            <footer className="mt-auto pt-8 pb-4 text-center">
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
