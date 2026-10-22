import { get as secureGet, set as secureSet, remove as secureRemove } from '../utils/secureStore';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import {
    AlertTriangle,
    CalendarDays,
    ChevronDown,
    LogOut,
    RefreshCw,
    Trash2,
    UserCircle,
    X,
} from '../icons';
import { M3LoadingIndicator } from '@alerix/m3-loading-indicator/react';
import CoreAuthForm from '../components/CoreAuthForm';
import { TimePage } from '../components/TimePage';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { coreAuth, type AccountSummary, type LoginMethods } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import type { CoreSyncStatus } from '../hooks/useCoreSync';
import { hrtDaysSince, toYmd, fromYmd } from '../utils/hrtStart';
import { LOCALE_MAP } from '../utils/helpers';
import { getCachedAvatar, refreshCachedAvatar, clearCachedAvatar } from '../utils/avatarCache';
import { CookieAvatar, prefersReducedMotion } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import { cookie } from '../ui/cookie';

const HERO_COOKIE_D = cookie(0, 0, 70, 8, 0.09).d;

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

/**
 * The summary as this account last had it, one storage key per account — the
 * same account-scoped shape the calibration preferences use (`hrt-u<id>-…`).
 *
 * This page mounts fresh on every visit, and the summary used to start at null:
 * the avatar, the created date and the record counts all popped in a beat after
 * the page had already slid in, which read as the pane flickering. Reading the
 * last known values back makes the page draw whole on frame one; the fetch
 * below still runs every time and corrects the numbers underneath, so the cache
 * is a first paint, never the answer.
 */
const summaryCacheKey = (userId: string | null | undefined) =>
    userId ? `hrt-u${userId}-summary` : null;

const readCachedSummary = (userId: string | null | undefined): AccountSummary | null => {
    const key = summaryCacheKey(userId);
    if (!key) return null;
    try {
        const raw = secureGet(key);
        if (!raw) return null;
        const v = JSON.parse(raw) as AccountSummary;
        // Shaped-enough guard: a half-written or stale-schema value must not
        // render as an account.
        if (!v || typeof v !== 'object') return null;
        if (typeof v.doseCount !== 'number' || typeof v.labCount !== 'number') return null;
        if (v.createdAt !== null && typeof v.createdAt !== 'string') return null;
        if (v.avatarUrl !== null && typeof v.avatarUrl !== 'string') return null;
        return v;
    } catch {
        return null;
    }
};

/** Chip tone per sync state — the status is also written, the tone is the glance. */
const SYNC_CHIP: Record<CoreSyncStatus, string> = {
    off: '',
    idle: '',
    syncing: 'pri',
    synced: 'ok',
    error: 'err',
};

/**
 * The account page, as M3 Expressive.
 *
 * One identity, the Core's. Two columns from 1024px — the person and their
 * anniversary on the left, the sync state and the two ways deeper into the
 * account on the right — stacked below that.
 *
 * There used to be two sign-ins on this screen: an inline form for a legacy
 * backend that owned no records, and the Core (the backend that owns them) behind
 * a modal. The form a visitor saw first belonged to the backend they did not
 * need. Now there is one form, and it is the Core's: the same `CoreAuthForm` the
 * modal renders, so the two cannot drift.
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
    const userId = session.user?.userId ?? null;
    const username = session.user?.username ?? '';
    // Seeded from what this account cached last visit, so the first paint is whole.
    const [summary, setSummary] = useState<AccountSummary | null>(() => readCachedSummary(userId));
    // The avatar as a local data URL, so it paints with the first render like the
    // text does. `summary.avatarUrl` is a network URL: even though the cached summary
    // supplies it on the first paint, the <img> still has to fetch the bytes, so the
    // identity block painted twice — text, then picture. See utils/avatarCache.ts.
    const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(
        () => getCachedAvatar(username)?.dataUrl ?? null,
    );
    const [methods, setMethods] = useState<LoginMethods | null>(null);
    const [isStartPickerOpen, setIsStartPickerOpen] = useState(false);

    // Cookie polygon rotation during sync:
    // Non-linear continuous physics with smooth ease-in (缓动起步) and smooth cubic
    // ease-out (缓停归位). Guaranteed to rotate at least one full 360° turn, never stops
    // abruptly, and glides gracefully to rest at its natural baseline angle.
    const cookieRef = useRef<SVGSVGElement | null>(null);
    const rafRef = useRef<number>(0);
    const animStateRef = useRef({
        angle: 0,
        velocity: 0, // degrees per ms
        mode: 'idle' as 'idle' | 'accel' | 'cruise' | 'decel',
        decelStartAngle: 0,
        decelTargetAngle: 0,
        decelDuration: 0,
        decelStartTime: 0,
        lastTime: 0,
    });

    useEffect(() => {
        if (prefersReducedMotion()) return;
        const state = animStateRef.current;
        const isSyncing = syncStatus === 'syncing';

        if (isSyncing) {
            state.lastTime = performance.now();
            if (state.mode === 'idle') {
                state.mode = 'accel';
                state.velocity = 0;
            } else if (state.mode === 'decel') {
                state.mode = 'accel';
            }
        }

        const CRUISE_VEL = 0.32; // degrees per ms (~320 deg/s, ~1.1s per revolution)
        const ACCEL_RATE = 0.00045; // degrees per ms^2 (~700ms to cruise speed)
        const MIN_DECEL_DIST = 90; // at least 90 deg of gentle cubic deceleration

        const tick = (now: number) => {
            const dt = Math.min(now - state.lastTime, 64);
            state.lastTime = now;

            if (syncStatus === 'syncing') {
                if (state.mode === 'accel') {
                    state.velocity = Math.min(CRUISE_VEL, state.velocity + ACCEL_RATE * dt);
                    if (state.velocity >= CRUISE_VEL) state.mode = 'cruise';
                } else if (state.mode === 'cruise') {
                    state.velocity = CRUISE_VEL;
                }
                state.angle += state.velocity * dt;
            } else {
                if (state.mode === 'accel' || state.mode === 'cruise') {
                    let target = Math.ceil(state.angle / 360) * 360;
                    if (target < 360) target = 360; // guarantee at least one full circle
                    if (target - state.angle < MIN_DECEL_DIST) target += 360;

                    state.decelStartAngle = state.angle;
                    state.decelTargetAngle = target;
                    state.decelStartTime = now;
                    const dist = target - state.angle;
                    const initialV = Math.max(0.12, state.velocity);
                    state.decelDuration = Math.max(800, Math.min(1800, (3 * dist) / initialV));
                    state.mode = 'decel';
                }

                if (state.mode === 'decel') {
                    const elapsed = now - state.decelStartTime;
                    const progress = Math.min(1, elapsed / state.decelDuration);
                    // Smooth cubic ease-out: 1 - (1 - progress)^3 (缓停, zero velocity at rest)
                    const eased = 1 - Math.pow(1 - progress, 3);
                    state.angle = state.decelStartAngle + (state.decelTargetAngle - state.decelStartAngle) * eased;

                    if (progress >= 1) {
                        state.angle = state.decelTargetAngle % 360;
                        state.mode = 'idle';
                        state.velocity = 0;
                    }
                }
            }

            if (cookieRef.current) {
                cookieRef.current.style.transform = `rotate(${state.angle.toFixed(2)}deg)`;
            }

            if (state.mode !== 'idle') {
                rafRef.current = requestAnimationFrame(tick);
            } else {
                rafRef.current = 0;
            }
        };

        if (state.mode !== 'idle' && !rafRef.current) {
            rafRef.current = requestAnimationFrame(tick);
        }

        return () => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = 0;
            }
        };
    }, [syncStatus]);

    // Today, for the picker's ceiling: a start date in the future would make the
    // day count negative, which `hrtDaysSince` then refuses to show at all.
    const now = new Date();
    const today = toYmd(now);

    const token = session.token;

    useEffect(() => {
        if (!token) { setSummary(null); setMethods(null); return; }
        // A user id can change under an unchanged page (fast account switch), so
        // hydrate here too rather than trusting the mount-time seed.
        setSummary(readCachedSummary(session.user?.userId));
        let cancelled = false;
        void Promise.all([
            coreAuth.summary(token),
            // Null on failure rather than a scream: this only decides whether a
            // suggestion is shown, and a suggestion that cannot be read is not an error
            // worth putting in front of someone who came here to look at their account.
            coreAuth.loginMethods(token).catch(() => null),
        ])
            .then(([s, m]) => {
                if (cancelled) return;
                setSummary(s);
                setMethods(m);
                const key = summaryCacheKey(session.user?.userId);
                if (key) {
                    try { secureSet(key, JSON.stringify(s)); } catch { /* storage refused — the fetch stays the only source */ }
                }
            })
            .catch(() => {
                // `methods` clears, but `summary` deliberately keeps whatever the
                // cache seeded: yesterday's counts describe the same account, while
                // dashes describe nothing. The sync row below tells the truth about
                // the connection either way.
                if (!cancelled) setMethods(null);
            });
        return () => { cancelled = true; };
    }, [token, userId]);

    // Re-seed the avatar from cache when the account changes under the page, then
    // refresh it in the background — the same copy the security page keeps, so a
    // changed provider picture swaps in without ever blanking the avatar.
    useEffect(() => {
        setAvatarDataUrl(getCachedAvatar(username)?.dataUrl ?? null);
    }, [username]);

    useEffect(() => {
        const url = summary?.avatarUrl;
        if (!username) return;
        if (!url) { clearCachedAvatar(username); setAvatarDataUrl(null); return; }
        if (getCachedAvatar(username)?.url === url) return;
        let cancelled = false;
        void refreshCachedAvatar(username, url).then((dataUrl) => {
            if (!cancelled && dataUrl) setAvatarDataUrl(dataUrl);
        });
        return () => { cancelled = true; };
    }, [username, summary?.avatarUrl]);

    const handleSignOut = () => {
        showDialog('confirm', t('core.acct.sign_out_confirm'), () => { void session.signOut(); });
    };

    /**
     * Sign out *and* wipe what this browser kept for the account.
     *
     * Records live in localStorage so the next sign-in here finds them; on a shared
     * browser that also means the next person to open DevTools reads the previous
     * user's history. Two confirms, because the records are restored from the
     * server only while the account still has them in its cloud copy.
     */
    const handleSignOutAndClear = () => {
        showDialog('confirm', t('core.acct.sign_out_clear_confirm'), () => {
            showDialog('confirm', t('core.acct.sign_out_clear_confirm_2'), () => {
                void session.signOut({ clearLocal: true });
            });
        });
    };

    const avatarSrc = avatarDataUrl ?? summary?.avatarUrl ?? null;
    const initial = username.trim().charAt(0).toUpperCase();
    const dateLabel = hrtStartDate
        ? fromYmd(hrtStartDate).toLocaleDateString(LOCALE_MAP[lang] || 'en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        })
        : t('account.hrt_start_set');

    return (
        <div className="pg on long" id="p4" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <h1>{t('account.title')}</h1>

            {session.restoring ? (
                <div className="hrow" style={{ justifyContent: 'center', padding: '64px 0' }}>
                    <M3LoadingIndicator size={22} color="var(--pri)" />
                </div>
            ) : session.isSignedIn ? (
                <div className="d-grid">
                    <div className="d-col">
                        <div className="prof">
                            <div style={{ position: 'relative', width: 64, height: 64, flex: 'none', color: 'var(--pri)' }}>
                                <CookieAvatar size={64} replayKey={username} src={avatarSrc ?? undefined} />
                                {!avatarSrc && initial ? (
                                    <span aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--onpri)', fontSize: 22, fontWeight: 700 }}>
                                        {initial}
                                    </span>
                                ) : null}
                                {!avatarSrc && !initial ? (
                                    <span aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--onpri)' }}>
                                        <Icon icon={UserCircle} size={24} />
                                    </span>
                                ) : null}
                            </div>
                            <div style={{ minWidth: 0 }}>
                                <b style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    {username || t('core.acct.signed_in_as')}
                                    <span className="chip ok" style={{ padding: '3px 8px' }}>{t('core.acct.active')}</span>
                                </b>
                                <span>{summary?.createdAt ? t('core.acct.created').replace('{date}', summary.createdAt.slice(0, 10)) : '\u00A0'}</span>
                            </div>
                        </div>

                        {methods?.recoveryRisk && (
                            <div className="card" style={{ background: 'var(--warnc)', color: 'var(--onterc)' }}>
                                <div className="hrow" style={{ alignItems: 'flex-start' }}>
                                    <Icon icon={AlertTriangle} size={20} />
                                    <p className="sub" style={{ margin: 0, color: 'inherit' }}>{t('core.bind.banner')}</p>
                                </div>
                                <button type="button" onClick={onBindCredentials} className="btn tonal-add" style={{ marginTop: 10 }}>
                                    {t('core.bind.action')}
                                </button>
                            </div>
                        )}

                        <div className="hero">
                            <svg
                                id="ck2"
                                ref={cookieRef}
                                className="deco"
                                viewBox="-80 -80 160 160"
                                aria-hidden="true"
                                style={{
                                    transformOrigin: '50% 50%',
                                }}
                            >
                                <path d={HERO_COOKIE_D} fill="currentColor" />
                            </svg>
                            <div className="l">{t('account.hrt_start_label')}</div>
                            {hrtStartDate && (
                                <button type="button" className="ib" onClick={() => { onHrtStartChange(''); setIsStartPickerOpen(false); }} aria-label={t('onboarding.start_clear')}>
                                    <Icon icon={X} size={20} />
                                </button>
                            )}
                            <div className="row2">
                                <div className="n">
                                    {daysSinceStart !== null ? daysSinceStart : '—'}
                                    {daysSinceStart !== null && <small>{t('unit.day_short')}</small>}
                                </div>
                                <button type="button" className="hc" onClick={() => setIsStartPickerOpen(v => !v)} aria-expanded={isStartPickerOpen}>
                                    <Icon icon={CalendarDays} size={16} />
                                    {dateLabel}
                                    <Icon icon={ChevronDown} size={14} className={isStartPickerOpen ? 'rotate-180' : ''} />
                                </button>
                            </div>
                            <TimePage
                                open={isStartPickerOpen}
                                mode="date"
                                onClose={() => setIsStartPickerOpen(false)}
                                onConfirm={(date) => {
                                    const picked = toYmd(date);
                                    onHrtStartChange(picked > today ? today : picked);
                                    setIsStartPickerOpen(false);
                                }}
                                initialDate={hrtStartDate ? fromYmd(hrtStartDate) : now}
                                title={t('account.hrt_start_label')}
                            />
                        </div>

                        <div className="tiles">
                            <div className="tile a" data-m style={{ ['--mo' as string]: '46px 14px 46px 14px', minHeight: 104 }}>
                                <span className="n">{summary ? summary.doseCount : '—'}</span>
                                <span className="l">{t('core.acct.doses')}</span>
                            </div>
                            <div className="tile b" data-m style={{ ['--mo' as string]: '28px', minHeight: 104 }}>
                                <span className="n">{summary ? summary.labCount : '—'}</span>
                                <span className="l">{t('core.acct.labs')}</span>
                            </div>
                        </div>
                    </div>

                    <div className="d-col">
                        <div className="sync">
                            <div className="t">
                                <b>{t('sync.title')}</b>
                                <span>
                                    {lastSyncedAt !== null
                                        ? t('sync.last_synced').replace('{time}', new Date(lastSyncedAt).toLocaleTimeString())
                                        : t('sync.never')}
                                </span>
                            </div>
                            <button
                                type="button"
                                onClick={onSyncNow}
                                disabled={syncStatus === 'syncing'}
                                className="btn t"
                                style={{
                                    opacity: syncStatus === 'syncing' ? .5 : 1,
                                    minWidth: 104,
                                    justifyContent: 'center',
                                }}
                            >
                                <Icon icon={RefreshCw} size={16} className={syncStatus === 'syncing' ? 'animate-spin' : ''} />
                                <span>{t('sync.now')}</span>
                            </button>
                        </div>

                        <div className="list">
                            <div className="li" role="button" tabIndex={0} onClick={() => onNavigate('settings-mcp')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate('settings-mcp'); } }}>
                                <span className="ic p"><SpriteIcon id="link" /></span>
                                <div className="t"><b>{t('mcp.title')}</b><span className="s">{t('mcp.row_desc')}</span></div>
                                <SpriteIcon id="chev" />
                            </div>
                            <div className="li" role="button" tabIndex={0} onClick={onNavigateToSecurity} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigateToSecurity(); } }}>
                                <span className="ic"><SpriteIcon id="shield" /></span>
                                <div className="t"><b>{t('settings.security')}</b><span className="s">{t('settings.security_desc')}</span></div>
                                <SpriteIcon id="chev" />
                            </div>
                        </div>

                        <div className="list">
                            <div className="li danger" role="button" tabIndex={0} onClick={handleSignOut} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSignOut(); } }}>
                                <span className="ic err"><Icon icon={LogOut} size={22} /></span>
                                <div className="t"><b>{t('core.acct.sign_out')}</b></div>
                            </div>
                            <div className="li danger" role="button" tabIndex={0} onClick={handleSignOutAndClear} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSignOutAndClear(); } }}>
                                <span className="ic err"><Icon icon={Trash2} size={22} /></span>
                                <div className="t">
                                    <b>{t('core.acct.sign_out_clear')}</b>
                                    <span className="s">{t('core.acct.sign_out_clear_hint')}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="d-col" style={{ width: '100%', maxWidth: 460, marginInline: 'auto' }}>
                    <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{ color: 'var(--pri)', flex: 'none' }}>
                            <CookieAvatar size={64} spin />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <h2 style={{ fontSize: 20, lineHeight: 1.3 }}>{t('account.title')}</h2>
                            <p className="sub" style={{ margin: '4px 0 0' }}>{t('onboarding.signin_subtitle')}</p>
                        </div>
                    </div>
                    <div className="card">
                        <CoreAuthForm session={session} initialUsername={initialUsername} />
                    </div>
                </div>
            )}

            {/* One footer for both states, after the columns, not in the middle of
                the account content. The mark links to the project's site. */}
            <footer className="foot" style={{ marginTop: 'auto', paddingTop: 24 }}>
                <a href="https://kiramyao.com" target="_blank" rel="noopener noreferrer">Powered by KiraEqual</a>
            </footer>
        </div>
    );
};
export default Account;



