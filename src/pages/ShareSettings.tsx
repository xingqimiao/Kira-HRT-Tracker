import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { Check, Copy, Eye, EyeOff, LockKeyhole, Trash2 } from '../icons';
import { Progress } from '../components/ui';
import { DoseEvent, HRTMode, SimulationResult } from '../../logic';
import { useTranslation } from '../contexts/LanguageContext';
import { getShareCopy } from '../i18n/share';
import { CreatedShare, notifyLiveSharesChanged, ShareApiError, ShareSummary, sharingService } from '../services/sharing';
import { useDialog } from '../contexts/DialogContext';
import { LOCALE_MAP } from '../utils/helpers';
import { TimePage } from '../components/TimePage';
import { buildSharedDosageSnapshot } from '../services/shareSnapshot';
import Switch from '../components/Switch';
import { estimatePasswordBits, passwordStrength, WEAK_BITS } from '../utils/passwordStrength';
import { Icon as SpriteIcon } from '../ui/SvgDefs';

interface ShareSettingsProps {
    onBack: () => void;
    authToken: string;
    mode: HRTMode;
    events: DoseEvent[];
    simulation: SimulationResult | null;
    calibrationFn: (timeH: number) => number;
    calibrationOffsetFn?: (timeH: number) => number;
}

const toLocalDateTimeValue = (timestamp: number): string => {
    const date = new Date(timestamp);
    return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

// `toLocaleString()` renders seconds, which makes every timestamp in the list
// read as noise. Share stamps only ever matter to the minute.
const formatStamp = (timestamp: number, lang: string): string =>
    new Date(timestamp).toLocaleString((LOCALE_MAP as Record<string, string>)[lang] || 'en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });

/** A chip in the prototype's shape, tinted by the role it names. */
const Chip: React.FC<{ tone?: 'primary' | 'meta'; children: React.ReactNode }> = ({ tone = 'primary', children }) => (
    <span
        className="chip"
        style={tone === 'meta'
            ? { background: 'var(--sch-h)', color: 'var(--var)' }
            : { background: 'var(--pric)', color: 'var(--onpric)' }}
    >
        {children}
    </span>
);

/**
 * 分享用药详情 — a read-only snapshot of the chart and history.
 *
 * Rebuilt on the M3E surfaces the rest of the app now uses (`SegmentedList`
 * rows, `.cg`-free switches inside a row's trailing slot, `.fld` for the one
 * text field, `.chip` for state) rather than the Tailwind role utilities this
 * page shipped with. It is a *page*, not a sheet: the link is something people
 * come back to manage, so revoking lives here beside creating.
 *
 * Two facts drive the layout. The snapshot note is a caveat, so it is a plain
 * paragraph on `surface-container` rather than a bordered callout — nothing here
 * is an error. And the created link is a *result*, not a form: once the Core
 * returns it, the form is replaced (the link cannot be read again) instead of
 * sitting under a still-submittable button.
 */
const ShareSettings: React.FC<ShareSettingsProps> = ({
    onBack,
    authToken,
    mode,
    events,
    simulation,
    calibrationFn,
    calibrationOffsetFn,
}) => {
    const { lang, t } = useTranslation();
    const { showDialog } = useDialog();
    const copy = getShareCopy(lang);
    const [passwordEnabled, setPasswordEnabled] = useState(false);
    const [liveEnabled, setLiveEnabled] = useState(false);
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [expiresAtInput, setExpiresAtInput] = useState('');
    const [isExpiryPickerOpen, setIsExpiryPickerOpen] = useState(false);
    const [createdShare, setCreatedShare] = useState<CreatedShare | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [shares, setShares] = useState<ShareSummary[]>([]);
    const [sharesLoading, setSharesLoading] = useState(false);
    const [revokingId, setRevokingId] = useState<string | null>(null);
    const linkInputRef = useRef<HTMLInputElement>(null);

    // Share passwords are gated on estimated entropy, not on length alone: an
    // 8-character birthday passes `minLength` and is still trivial to guess.
    const passwordBits = passwordEnabled ? estimatePasswordBits(password) : 0;
    const passwordLevel = passwordStrength(password);
    const passwordMeterPct = Math.min(100, (passwordBits / 80) * 100);
    const passwordMeterColor = passwordLevel === 'strong' ? 'var(--pri)' : passwordLevel === 'fair' ? 'var(--var)' : 'var(--err)';
    const passwordMessage = passwordLevel === 'strong'
        ? t('share.passwordStrong')
        : passwordLevel === 'fair'
            ? t('share.passwordFair')
            : t('share.passwordTooWeak');

    useEffect(() => {
        setPasswordEnabled(false);
        setLiveEnabled(false);
        setPassword('');
        setShowPassword(false);
        setExpiresAtInput(toLocalDateTimeValue(Date.now() + 7 * 24 * 60 * 60_000));
        setIsExpiryPickerOpen(false);
        setCreatedShare(null);
        setSubmitting(false);
        setCopied(false);
        setError(null);
        setShares([]);
        setSharesLoading(true);
        sharingService.list(authToken)
            .then(items => setShares(items.filter(item => !item.expired)))
            .catch(() => setShares([]))
            .finally(() => setSharesLoading(false));
    }, [authToken]);

    const shareSnapshot = useMemo(
        () => buildSharedDosageSnapshot({ mode, events, simulation, calibrationFn, offsetFn: calibrationOffsetFn }),
        [mode, events, simulation, calibrationFn, calibrationOffsetFn],
    );

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (submitting || !events.length) return;

        setError(null);
        setSubmitting(true);
        try {
            const expiresAt = new Date(expiresAtInput).getTime();
            if (
                !Number.isFinite(expiresAt)
                || expiresAt <= Date.now()
                || expiresAt > Date.now() + 365 * 24 * 60 * 60_000
            ) {
                setError(copy.invalidExpiry);
                return;
            }
            const result = await sharingService.create(authToken, shareSnapshot, {
                password: passwordEnabled ? password : undefined,
                expiresAt,
                live: liveEnabled,
            });
            setCreatedShare(result);
            if (result.live) notifyLiveSharesChanged();
            setShares(previous => [{
                id: result.id,
                createdAt: result.createdAt,
                expiresAt: result.expiresAt,
                passwordRequired: result.passwordRequired,
                live: result.live,
                mode: result.mode,
                updatedAt: result.updatedAt,
                expired: false,
            }, ...previous.filter(item => item.id !== result.id)]);
        } catch (requestError) {
            if (requestError instanceof ShareApiError) {
                if (requestError.code === 'SNAPSHOT_TOO_LARGE') setError(copy.tooLarge);
                else if (requestError.code === 'SHARE_LIMIT_REACHED') setError(copy.limitReached);
                else if (requestError.code === 'INVALID_EXPIRATION') setError(copy.invalidExpiry);
                else if (requestError.code === 'SHARE_REJECTED') setError(t('share.passwordTooWeak'));
                else setError(copy.createError);
            } else {
                setError(copy.createError);
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleCopy = async () => {
        if (!createdShare) return;
        try {
            await navigator.clipboard.writeText(createdShare.url);
        } catch {
            linkInputRef.current?.select();
            document.execCommand('copy');
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
    };

    const handleRevoke = (share: ShareSummary) => {
        showDialog('confirm', copy.revokeConfirm, async () => {
            setRevokingId(share.id);
            try {
                await sharingService.revoke(authToken, share.id);
                setShares(previous => previous.filter(item => item.id !== share.id));
                if (createdShare?.id === share.id) setCreatedShare(null);
                if (share.live) notifyLiveSharesChanged();
            } catch {
                showDialog('alert', copy.revokeError);
            } finally {
                setRevokingId(null);
            }
        });
    };

    const expiryLabel = expiresAtInput ? formatStamp(new Date(expiresAtInput).getTime(), lang) : '—';

    return (
        <div className="pg on long" style={{ maxWidth: 720, width: '100%', margin: '0 auto' }}>
            <button type="button" className="hback" onClick={onBack}>
                <SpriteIcon id="chev" />
                <span className="ht">{copy.modalTitle}</span>
            </button>

            <p className="sub" style={{ margin: '0 6px 4px' }}>{copy.modalDescription}</p>

            {createdShare ? (
                <div className="list m3e-rise" key={createdShare.id}>
                    <div className="li" style={{ cursor: 'default', alignItems: 'flex-start', padding: '16px' }}>
                        <span className="ic p"><SpriteIcon id="check" /></span>
                        <div className="t" style={{ minWidth: 0 }}>
                            <b>{copy.created}</b>
                            <span className="s" style={{ marginTop: 6 }}>
                                {`${copy.expiresOn} ${createdShare.expiresAt ? formatStamp(createdShare.expiresAt, lang) : copy.neverExpires}`}
                            </span>
                            <div className="fld" style={{ marginTop: 10 }}>
                                <input
                                    ref={linkInputRef}
                                    readOnly
                                    value={createdShare.url}
                                    aria-label={copy.copy}
                                    onFocus={event => event.currentTarget.select()}
                                    style={{ fontSize: 14, fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                                />
                            </div>
                            {/* The part after `#` is the key. It never reaches the
                                server, so a link without it is unopenable — hence the
                                warning. A link created against a server that predates
                                sealing has no key, and saying otherwise would be false. */}
                            {createdShare.url.includes('#k=') && (
                                <p className="sub" style={{ margin: '8px 2px 0', fontSize: 12.5 }}>
                                    {copy.linkKeyNote}
                                </p>
                            )}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                                <button type="button" className="btn" onClick={handleCopy} style={{ height: 40, minWidth: 0, padding: '0 16px', fontSize: 13.5 }}>
                                    <Icon icon={copied ? Check : Copy} size={16} />
                                    {copied ? copy.copied : copy.copy}
                                </button>
                                {createdShare.live && <Chip>{copy.liveBadge}</Chip>}
                                {createdShare.passwordRequired && (
                                    <Chip tone="meta">
                                        <Icon icon={LockKeyhole} size={12} />
                                        {copy.protected}
                                    </Chip>
                                )}
                            </div>
                            {createdShare.passwordRequired && (
                                <span className="s" style={{ marginTop: 8 }}>{copy.passwordHint}</span>
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div className="card" style={{ background: 'var(--sch)', padding: '16px 18px', borderRadius: 24 }}>
                        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--var)' }}>
                            {liveEnabled ? copy.liveSnapshotNote : copy.snapshotNote}
                        </p>
                    </div>

                    <div className="list">
                        <div className="li" style={{ cursor: 'default' }}>
                            <span className="ic p"><SpriteIcon id="sync" /></span>
                            <div className="t">
                                <b>{copy.liveToggle}</b>
                                <span className="s">{liveEnabled ? copy.liveBadge : copy.updatedOn}</span>
                            </div>
                            <Switch id="share-live-toggle" checked={liveEnabled} onChange={setLiveEnabled} label={copy.liveToggle} />
                        </div>

                        <div className="li" style={{ cursor: 'default' }}>
                            <span className="ic am"><Icon icon={LockKeyhole} size={20} /></span>
                            <div className="t">
                                <b>{copy.passwordToggle}</b>
                                <span className="s">{copy.passwordHint}</span>
                            </div>
                            <Switch
                                id="share-password-toggle"
                                checked={passwordEnabled}
                                onChange={(next) => { setPasswordEnabled(next); setError(null); }}
                                label={copy.passwordToggle}
                            />
                        </div>

                        <button
                            type="button"
                            className="li"
                            onClick={() => setIsExpiryPickerOpen(value => !value)}
                            aria-expanded={isExpiryPickerOpen}
                            style={{ width: '100%', border: 0, font: 'inherit', color: 'inherit', textAlign: 'left' }}
                        >
                            <span className="ic"><SpriteIcon id="cal" /></span>
                            <div className="t">
                                <b>{copy.expiryLabel}</b>
                                <span className="s">{expiryLabel}</span>
                            </div>
                            <SpriteIcon id="chev" style={{ transform: isExpiryPickerOpen ? 'rotate(90deg)' : 'none' }} />
                        </button>
                    </div>
                    <p className="sub" style={{ margin: '0 6px' }}>{copy.expiryHint}</p>

                    {passwordEnabled && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <p className="sub" style={{ margin: '2px 6px 0' }}>{copy.passwordLabel}</p>
                            <div className="fld" style={{ marginTop: 0 }}>
                                <input
                                    id="share-password"
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={event => setPassword(event.target.value)}
                                    placeholder={copy.passwordPlaceholder}
                                    aria-label={copy.passwordLabel}
                                    minLength={8}
                                    maxLength={128}
                                    autoComplete="new-password"
                                    required
                                    autoFocus
                                    style={{ fontSize: 17, fontWeight: 600 }}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(value => !value)}
                                    aria-label={copy.passwordLabel}
                                    className="btn x"
                                    style={{ minWidth: 0, padding: '0 4px' }}
                                >
                                    <Icon icon={showPassword ? EyeOff : Eye} size={18} />
                                </button>
                            </div>

                            {/* Entropy meter: width and colour both track the estimate,
                                and the text says what to do next. */}
                            <div
                                style={{ height: 6, borderRadius: 3, background: 'var(--sch-h)', overflow: 'hidden' }}
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={80}
                                aria-valuenow={Math.round(passwordBits)}
                                aria-label={copy.passwordLabel}
                            >
                                <div
                                    style={{
                                        width: `${passwordMeterPct}%`,
                                        height: '100%',
                                        borderRadius: 3,
                                        background: passwordMeterColor,
                                        transition: 'width .3s cubic-bezier(.2,.9,.3,1), background .2s',
                                    }}
                                />
                            </div>
                            {password.length > 0 && (
                                <p
                                    className="sub"
                                    style={{ margin: 0, color: passwordLevel === 'weak' ? 'var(--err)' : 'var(--var)' }}
                                >
                                    {passwordMessage} · {Math.round(passwordBits)} bits
                                </p>
                            )}
                        </div>
                    )}

                    {error && (
                        <p className="sub" style={{ margin: 0, color: 'var(--err)' }} role="alert">{error}</p>
                    )}

                    <div className="hrow" style={{ gap: 10, marginTop: 2 }}>
                        <button type="button" onClick={onBack} className="btn x" style={{ minWidth: 80 }}>
                            {t('btn.cancel')}
                        </button>
                        <button
                            type="submit"
                            disabled={submitting || !events.length || (passwordEnabled && estimatePasswordBits(password) < WEAK_BITS)}
                            className="btn"
                            style={{ flex: 1, opacity: submitting || !events.length ? 0.5 : 1 }}
                        >
                            {submitting ? <Progress size={15} /> : <SpriteIcon id="link" />}
                            {submitting ? copy.creating : copy.create}
                        </button>
                    </div>
                </form>
            )}

            <div className="lab" style={{ marginTop: 18 }}>{copy.manageTitle}</div>
            <p className="sub" style={{ margin: '0 6px 2px' }}>{copy.manageDescription}</p>

            {sharesLoading ? (
                <div className="empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    <Progress size={14} /> {copy.loading}
                </div>
            ) : shares.length === 0 ? (
                <div className="empty">{copy.noneActive}</div>
            ) : (
                <div className="list">
                    {shares.map(share => (
                        <div className="li" key={share.id} style={{ cursor: 'default' }}>
                            <span className="ic"><SpriteIcon id="link" /></span>
                            <div className="t">
                                <b>{`${copy.sharedOn} ${formatStamp(share.createdAt, lang)}`}</b>
                                <span className="s">
                                    {`${copy.expiresOn} ${share.expiresAt ? formatStamp(share.expiresAt, lang) : copy.neverExpires}`}
                                </span>
                            </div>
                            {share.live && <Chip>{copy.liveBadge}</Chip>}
                            {share.passwordRequired && (
                                <span
                                    aria-label={copy.protected}
                                    style={{ display: 'inline-flex', color: 'var(--var)', flex: 'none' }}
                                >
                                    <Icon icon={LockKeyhole} size={16} />
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={() => handleRevoke(share)}
                                disabled={revokingId === share.id}
                                aria-label={copy.revoke}
                                className="icon-del"
                            >
                                {revokingId === share.id ? <Progress size={15} /> : <Icon icon={Trash2} size={17} />}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <TimePage
                open={isExpiryPickerOpen}
                onClose={() => setIsExpiryPickerOpen(false)}
                onConfirm={(date) => {
                    setExpiresAtInput(toLocalDateTimeValue(date.getTime()));
                    setIsExpiryPickerOpen(false);
                }}
                initialDate={expiresAtInput ? new Date(expiresAtInput) : new Date(Date.now() + 7 * 24 * 60 * 60_000)}
                mode="datetime"
                title={copy.expiryLabel}
            />
        </div>
    );
};

export default ShareSettings;
