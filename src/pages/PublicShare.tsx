import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { AlertCircle, Clock3, Eye, EyeOff, LockKeyhole } from '../icons';
import { Progress } from '../components/ui';
import { DoseEvent, Ester, ExtraKey, getToE2Factor, isTestosteroneEster, isAntiandrogen, isUnmodelledCompound, modelledEvents, Route } from '../../logic';
import ResultChart from '../components/ResultChart';
import { useTranslation } from '../contexts/LanguageContext';
import { getShareCopy } from '../i18n/share';
import { LOCALE_MAP } from '../utils/helpers';
import { openShareSnapshot, shareKeyFromHash } from '../utils/shareCrypto';
import { LockedShare, ShareApiError, ShareDetails, SharedDosageSnapshot, sharingService } from '../services/sharing';

interface PublicShareProps {
    token: string | null;
}

type ShareState =
    | { kind: 'loading' }
    | { kind: 'locked'; meta: LockedShare }
    | { kind: 'ready'; details: ShareDetails; snapshot: SharedDosageSnapshot }
    /**
     * The snapshot is sealed and this URL carries no key. The key lives after the `#`,
     * and browsers never send a fragment to the server — so a link pasted without it
     * (or truncated by a chat client) cannot be opened by anyone.
     */
    | { kind: 'noKey' }
    | { kind: 'expired' }
    | { kind: 'unavailable' };

const formatWearDays = (days: number): string =>
    (Math.round(days * 100) / 100).toString();

/**
 * A share payload is external input, and two shapes of it exist in the wild.
 *
 * The app writes full `DoseEvent`s — `timeH` plus `extras`. `hrt_create_share`
 * writes a minimal record (`at` as an ISO string, no extras), which is enough for
 * an assistant to describe but not what the viewer reads. Normalising once here
 * keeps the chart, the date grouping and the rows on the same numbers, and means a
 * link written by either path opens instead of throwing on `Invalid time value`.
 */
/**
 * Whether an IANA zone is usable. `Intl.DateTimeFormat` throws a RangeError on an
 * unknown one, and the zone comes from the shared snapshot — data the viewer does not
 * control and the server only validated loosely.
 */
const isUsableTimeZone = (zone: unknown): zone is string => {
    if (typeof zone !== 'string' || !zone) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
};

/**
 * A snapshot event, or null when it cannot be rendered.
 *
 * The page used to trust the payload's shape: a string `doseMG` reached
 * `toFixed` and threw, and an invalid zone threw at the first `Intl` call, so a
 * malformed link crashed the viewer instead of saying "this link cannot be opened".
 * Every field the renderer reads is coerced here, once.
 */
const sharedEvent = (event: unknown): DoseEvent | null => {
    if (!event || typeof event !== 'object') return null;
    const raw = event as DoseEvent & { at?: string };
    const timeH = typeof raw.timeH === 'number' && Number.isFinite(raw.timeH)
        ? raw.timeH
        : Date.parse(raw.at ?? '') / 3_600_000;
    const doseMG = Number(raw.doseMG);
    if (!Number.isFinite(timeH) || !Number.isFinite(doseMG)) return null;
    const extras = raw.extras && typeof raw.extras === 'object' && !Array.isArray(raw.extras)
        ? raw.extras
        : {};
    return { ...raw, timeH, doseMG, extras } as DoseEvent;
};

const normalizeSharedEvents = (events: DoseEvent[] | undefined): DoseEvent[] =>
    (Array.isArray(events) ? events : [])
        .map(sharedEvent)
        .filter((event): event is DoseEvent => event !== null);

const PublicShare: React.FC<PublicShareProps> = ({ token }) => {
    const { lang, t } = useTranslation();
    const copy = getShareCopy(lang);
    const [state, setState] = useState<ShareState>({ kind: 'loading' });
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [unlocking, setUnlocking] = useState(false);
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const unlockedPasswordRef = useRef('');
    const viewerPassRef = useRef('');
    const [lockUntil, setLockUntil] = useState(0);
    const [lockRemaining, setLockRemaining] = useState(0);

    // Countdown for a per-link lockout. The server's Retry-After is authoritative;
    // the page only renders it, so a reload does not invent a shorter wait.
    useEffect(() => {
        if (!lockUntil) { setLockRemaining(0); return; }
        const tick = () => {
            const seconds = Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000));
            setLockRemaining(seconds);
            if (seconds === 0) setLockUntil(0);
        };
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [lockUntil]);

    const classifyError = (error: unknown): ShareState => {
        if (error instanceof ShareApiError && (error.status === 410 || error.code === 'SHARE_EXPIRED')) {
            return { kind: 'expired' };
        }
        return { kind: 'unavailable' };
    };

    /**
     * Turn what the server returned into something renderable.
     *
     * A sealed link is opened here, in the browser, with the key from the fragment —
     * the server was never able to read it. A link written before sealing (or by an
     * agent) still arrives as a plaintext snapshot and is used as-is, so old links
     * keep working.
     */
    const resolveDetails = async (details: ShareDetails): Promise<ShareState> => {
        if (!details.sealed) {
            return details.snapshot
                ? { kind: 'ready', details, snapshot: details.snapshot }
                : { kind: 'unavailable' };
        }
        const key = shareKeyFromHash(window.location.hash);
        if (!key) return { kind: 'noKey' };
        try {
            const opened = await openShareSnapshot(details.sealed, key);
            if (!opened || typeof opened !== 'object' || Array.isArray(opened)) {
                return { kind: 'unavailable' };
            }
            return { kind: 'ready', details, snapshot: opened as SharedDosageSnapshot };
        } catch {
            // A wrong key and a damaged envelope are the same answer to the reader:
            // this link cannot be opened. Showing an empty record instead would look
            // like the sharer's history had been deleted.
            return { kind: 'unavailable' };
        }
    };

    useEffect(() => {
        document.title = `${copy.publicTitle} · Kira HRT Tracker`;
        let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
        const created = !robots;
        if (!robots) {
            robots = document.createElement('meta');
            robots.name = 'robots';
            document.head.appendChild(robots);
        }
        const previous = robots.content;
        robots.content = 'noindex, nofollow, noarchive';
        return () => {
            if (created) robots?.remove();
            else if (robots) robots.content = previous;
        };
    }, [copy.publicTitle]);

    useEffect(() => {
        let cancelled = false;
        unlockedPasswordRef.current = '';
        setPassword('');
        setPasswordError(null);

        if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
            setState({ kind: 'unavailable' });
            return () => { cancelled = true; };
        }

        setState({ kind: 'loading' });
        setLockUntil(0);
        sharingService.open(token, viewerPassRef.current || undefined)
            .then(async result => {
                if (cancelled) return;
                if ('snapshot' in result) {
                    viewerPassRef.current = result.viewerPass || viewerPassRef.current;
                    const next = await resolveDetails(result);
                    if (!cancelled) setState(next);
                } else setState({ kind: 'locked', meta: result });
            })
            .catch(error => {
                if (cancelled) return;
                if (error instanceof ShareApiError && error.status === 429) {
                    setLockUntil(Date.now() + (error.retryAfterMs ?? 15 * 60_000));
                    setState({
                        kind: 'locked',
                        meta: { passwordRequired: true, live: false, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: null },
                    });
                    return;
                }
                setState(classifyError(error));
            });
        return () => { cancelled = true; };
        // classifyError contains no reactive state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const handleUnlock = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!token || unlocking) return;
        setUnlocking(true);
        setPasswordError(null);
        try {
            const details = await sharingService.unlock(token, password, viewerPassRef.current || undefined);
            unlockedPasswordRef.current = password;
            viewerPassRef.current = details.viewerPass || viewerPassRef.current;
            const next = await resolveDetails(details);
            setState(next);
            if (next.kind === 'ready') {
                setPassword('');
                setLockUntil(0);
            }
        } catch (error) {
            if (error instanceof ShareApiError && error.code === 'INVALID_PASSWORD') {
                setPasswordError(copy.wrongPassword);
            } else if (error instanceof ShareApiError && error.status === 429) {
                setLockUntil(Date.now() + (error.retryAfterMs ?? 15 * 60_000));
                setPasswordError(null);
            } else {
                setState(classifyError(error));
            }
        } finally {
            setUnlocking(false);
        }
    };

    const liveReady = state.kind === 'ready' && state.details.live;
    useEffect(() => {
        if (!token || !liveReady) return;

        let cancelled = false;
        let refreshing = false;
        let retryAfter = 0;
        const refresh = async () => {
            if (cancelled || refreshing || document.hidden || Date.now() < retryAfter) return;
            refreshing = true;
            try {
                const result = viewerPassRef.current
                    ? await sharingService.unlock(token, undefined, viewerPassRef.current)
                    : (unlockedPasswordRef.current
                        ? await sharingService.unlock(token, unlockedPasswordRef.current)
                        : await sharingService.open(token));
                if (!cancelled && 'snapshot' in result) {
                    viewerPassRef.current = result.viewerPass || viewerPassRef.current;
                    // Each live update is a fresh envelope sealed under the same key,
                    // so it has to be opened again — by the same fragment key.
                    const next = await resolveDetails(result);
                    if (!cancelled && next.kind === 'ready') {
                        viewerPassRef.current = next.details.viewerPass || viewerPassRef.current;
                        setState(next);
                    }
                }
            } catch (error) {
                if (cancelled) return;
                if (error instanceof ShareApiError && (error.status === 410 || error.code === 'SHARE_EXPIRED')) {
                    setState({ kind: 'expired' });
                } else if (error instanceof ShareApiError && error.status === 404) {
                    setState({ kind: 'unavailable' });
                } else if (error instanceof ShareApiError && error.status === 429) {
                    retryAfter = Date.now() + (error.retryAfterMs ?? 60_000);
                }
                // Keep showing the most recently loaded data for transient
                // network failures and rate limits.
            } finally {
                refreshing = false;
            }
        };

        const onVisibilityChange = () => {
            if (!document.hidden) void refresh();
        };
        void refresh();
        const timer = window.setInterval(() => void refresh(), 10_000);
        window.addEventListener('focus', refresh);
        window.addEventListener('online', refresh);
        window.addEventListener('pageshow', refresh);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            window.removeEventListener('focus', refresh);
            window.removeEventListener('online', refresh);
            window.removeEventListener('pageshow', refresh);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [token, liveReady]);

    if (state.kind === 'loading') {
        return (
            <PublicShell>
                <div
                    aria-live="polite"
                    style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}
                >
                    <Progress size={24} />
                    <p className="sub" style={{ margin: 0 }}>{copy.loading}</p>
                </div>
            </PublicShell>
        );
    }

    if (state.kind === 'locked') {
        return (
            <PublicShell>
                <div className="card" style={{ background: 'var(--sc)', borderRadius: 28, padding: '22px 20px' }}>
                    <span
                        aria-hidden="true"
                        style={{ display: 'grid', placeItems: 'center', width: 44, height: 44, borderRadius: '50%', background: 'var(--pric)', color: 'var(--onpric)', marginBottom: 14 }}
                    >
                        <Icon icon={LockKeyhole} size={20} />
                    </span>
                    <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.3px', margin: '0 0 6px' }}>{copy.unlockTitle}</h1>
                    <p className="sub" style={{ margin: '0 0 16px' }}>{copy.unlockDescription}</p>
                    <form onSubmit={handleUnlock}>
                        <div className="fld" style={{ marginTop: 0 }}>
                            <input
                                id="shared-record-password"
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={(event) => {
                                    setPassword(event.target.value);
                                    setPasswordError(null);
                                }}
                                placeholder={copy.passwordPlaceholder}
                                autoComplete="current-password"
                                minLength={8}
                                maxLength={128}
                                required
                                autoFocus
                                aria-label={copy.passwordLabel}
                                aria-invalid={!!passwordError}
                                aria-describedby={passwordError ? 'share-password-error' : undefined}
                                style={{ fontSize: 17, fontWeight: 600 }}
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(value => !value)}
                                className="btn x"
                                style={{ minWidth: 0, padding: '0 4px' }}
                                aria-label={copy.passwordLabel}
                            >
                                <Icon icon={showPassword ? EyeOff : Eye} size={18} />
                            </button>
                        </div>
                        {passwordError && (
                            <p id="share-password-error" role="alert" style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--err)' }}>{passwordError}</p>
                        )}
                        {lockRemaining > 0 && (
                            <p role="status" style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--err)' }}>
                                {t('share.shareLocked').replace(
                                    '{time}',
                                    lockRemaining >= 60
                                        ? `${Math.ceil(lockRemaining / 60)} min`
                                        : `${lockRemaining}s`,
                                )}
                            </p>
                        )}
                        <button
                            type="submit"
                            className="btn"
                            style={{ width: '100%', marginTop: 16, opacity: unlocking || password.length < 8 || lockRemaining > 0 ? .5 : 1 }}
                            disabled={unlocking || password.length < 8 || lockRemaining > 0}
                        >
                            {unlocking ? copy.unlocking : copy.unlock}
                        </button>
                    </form>
                </div>
            </PublicShell>
        );
    }

    if (state.kind === 'expired' || state.kind === 'unavailable') {
        const expired = state.kind === 'expired';
        return (
            <PublicShell>
                <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                    <Icon icon={AlertCircle} size={30} strokeWidth={1.5} className="text-muted" />
                    <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.3px', margin: 0 }}>
                        {expired ? copy.expiredTitle : copy.unavailableTitle}
                    </h1>
                    <p className="sub" style={{ margin: 0, maxWidth: 320 }}>
                        {expired ? copy.expiredDescription : copy.unavailableDescription}
                    </p>
                </div>
            </PublicShell>
        );
    }

    if (state.kind === 'noKey') {
        // Deliberately not the "expired / unavailable" screen: the link is fine, the
        // part that opens it is missing, and the sender can fix it by copying it again.
        return (
            <PublicShell>
                <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                    <Icon icon={LockKeyhole} size={30} strokeWidth={1.5} className="text-muted" />
                    <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.3px', margin: 0 }}>
                        {copy.noKeyTitle}
                    </h1>
                    <p className="sub" style={{ margin: 0, maxWidth: 340 }}>
                        {copy.noKeyDescription}
                    </p>
                </div>
            </PublicShell>
        );
    }

    return <SharedRecord details={state.details} snapshot={state.snapshot} />;
};

/**
 * The page a shared link opens.
 *
 * A standalone surface, not the app: no navigation, no rail, no account — a reader
 * who came from a chat window should see the record and nothing else. It still
 * speaks the app's shape language (the same 26px segment corners, tonal rows and
 * `.chip` meta) so a link looks like the product that produced it.
 *
 * The column is centred and capped, and the vertical rhythm is the app's: the
 * content starts under the viewport edge, not under a header bar.
 */
const PublicShell = ({ children }: { children: React.ReactNode }) => (
    <div
        style={{
            /* Fixed, like the app shell: the page scrolls inside itself so the
               crawler footer that lives after `#root` can never be reached, and the
               background covers the window instead of ending where the content
               does. */
            position: 'fixed',
            inset: 0,
            overflowY: 'auto',
            background: 'var(--bg)',
            color: 'var(--on)',
            padding: 'calc(26px + max(env(safe-area-inset-top, 0px), var(--app-safe-top, 0px))) 16px calc(40px + max(env(safe-area-inset-bottom, 0px), var(--app-safe-bottom, 0px)))',
        }}
    >
        <div className="pg on" style={{ maxWidth: 780, width: '100%', margin: '0 auto', minHeight: 0, paddingBottom: 0, gap: 12 }}>
            {children}
        </div>
    </div>
);

const SharedRecord = ({ details, snapshot }: { details: ShareDetails; snapshot: SharedDosageSnapshot }) => {
    const { lang, t } = useTranslation();
    const copy = getShareCopy(lang);
    const locale = LOCALE_MAP[lang] || 'en-US';
    // An unusable zone falls back to UTC rather than throwing: the reading the viewer
    // gets is off by a fixed number of hours, which is a bad link's fault, not a reason
    // to show nothing at all.
    const timeZone = isUsableTimeZone(snapshot.timezone) ? snapshot.timezone : 'UTC';
    const events = useMemo(() => normalizeSharedEvents(snapshot.events), [snapshot.events]);
    // The chart plots modelled compounds only — see `modelledEvents`. The record
    // list below still shows every shared dose, CPA included.
    const chartEvents = useMemo(() => modelledEvents(events), [events]);

    const formatDateTime = (timestamp: number) => new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
    }).format(new Date(timestamp));

    const groups = useMemo(() => {
        const formatter = new Intl.DateTimeFormat(locale, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone,
        });
        const grouped: { label: string; events: DoseEvent[] }[] = [];
        for (const event of [...events].sort((a, b) => b.timeH - a.timeH)) {
            const label = formatter.format(new Date(event.timeH * 3_600_000));
            const current = grouped[grouped.length - 1];
            if (current?.label === label) current.events.push(event);
            else grouped.push({ label, events: [event] });
        }
        return grouped;
    }, [events, locale, timeZone]);

    const timeFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
    }), [locale, timeZone]);

    return (
        <PublicShell>
            <div>
                <p className="sub" style={{ margin: '0 0 4px' }}>{copy.publicEyebrow}</p>
                <h1 style={{ fontSize: 30, lineHeight: 1.12, fontWeight: 800, letterSpacing: '-.5px', margin: '0 0 8px' }}>
                    {copy.publicTitle}
                </h1>
                <p className="sub" style={{ margin: 0 }}>{copy.disclaimer}</p>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {details.live && (
                    <span className="chip" style={{ background: 'var(--pric)', color: 'var(--onpric)' }}>{copy.liveBadge}</span>
                )}
                {details.passwordRequired && (
                    <span className="chip" style={{ background: 'var(--sch-h)', color: 'var(--var)' }}>
                        <Icon icon={LockKeyhole} size={12} />{copy.protected}
                    </span>
                )}
                <span className="chip" style={{ background: 'var(--sch-h)', color: 'var(--var)' }}>
                    <Icon icon={Clock3} size={12} />{copy.sharedOn} {formatDateTime(details.createdAt)}
                </span>
                {details.live && (
                    <span className="chip" style={{ background: 'var(--sch-h)', color: 'var(--var)' }}>
                        {copy.updatedOn} {formatDateTime(details.updatedAt)}
                    </span>
                )}
            </div>

            {/* A link written by the app always carries a modelled curve; one written
                by `hrt_create_share` carries only the doses. An empty 400px chart
                frame above a full history reads as a broken chart, so the section is
                simply absent when there is no curve to draw. */}
            {snapshot.simulation && (
                <>
                    <div className="lab" style={{ marginTop: 4 }}>{`${copy.chartTitle} · ${timeZone}`}</div>
                    <div className="card" style={{ background: 'var(--sc)', borderRadius: 28, padding: 10 }}>
                        <ResultChart
                            sim={snapshot.simulation}
                            events={chartEvents}
                            mode={snapshot.mode}
                            timeZone={timeZone}
                            title={t('chart.title')}
                        />
                    </div>
                </>
            )}

            <div className="lab" style={{ marginTop: 8 }}>{`${copy.historyTitle} · ${events.length} ${copy.records}`}</div>

            {groups.length === 0 ? (
                <div className="empty">{t('timeline.empty')}</div>
            ) : groups.map(group => (
                <div key={group.label}>
                    <div className="sub" style={{ margin: '8px 6px 4px', fontWeight: 700 }}>{group.label}</div>
                    <div className="list">
                        {group.events.map(event => (
                            <DoseHistoryRow
                                key={event.id}
                                event={event}
                                time={timeFormatter.format(new Date(event.timeH * 3_600_000))}
                            />
                        ))}
                    </div>
                </div>
            ))}
        </PublicShell>
    );
};

const DoseHistoryRow = ({ event, time }: { event: DoseEvent; time: string }) => {
    const { t } = useTranslation();
    const isRemoval = event.route === Route.patchRemove;
    const releaseRate = event.extras[ExtraKey.releaseRateUGPerDay];
    const wearHours = event.extras[ExtraKey.patchWearH];

    // One line, in the same order a person says it: what, how much, by which route.
    const detail: string[] = [t(`route.${event.route}`)];
    if (releaseRate) {
        detail.push(`${releaseRate} µg/d`);
    } else if (!isRemoval) {
        detail.push(`${event.doseMG.toFixed(2)} mg`);
        if (event.ester !== Ester.E2 && !isAntiandrogen(event.ester) && !isTestosteroneEster(event.ester) && !isUnmodelledCompound(event.ester)) {
            detail.push(`(${t('label.e2')} eq ${(event.doseMG * getToE2Factor(event.ester)).toFixed(2)} mg)`);
        }
        if (isTestosteroneEster(event.ester) && event.ester !== Ester.T) {
            detail.push(`(${t('label.t')} eq ${(event.doseMG * getToE2Factor(event.ester)).toFixed(2)} mg)`);
        }
    }
    if (event.route === Route.patchApply && typeof wearHours === 'number' && wearHours > 0) {
        detail.push(`${formatWearDays(wearHours / 24)} ${t('unit.day_short')}`);
    }

    return (
        <div className="li" style={{ cursor: 'default' }}>
            <span
                aria-hidden="true"
                style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--pri)', flex: 'none' }}
            />
            <div className="t">
                <b>{isRemoval ? t('route.patchRemove') : t(`ester.${event.ester}`)}</b>
                <span className="s">{detail.join(' · ')}</span>
            </div>
            <span className="r">{time}</span>
        </div>
    );
};

export default PublicShare;
