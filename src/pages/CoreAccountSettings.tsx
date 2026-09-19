import React, { useCallback, useEffect, useState } from 'react';
import Icon from '../components/Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { AlertTriangle, Loader2, LogOut, MonitorSmartphone, RefreshCw, Trash2, Unlink } from '../icons';

import { coreAuth, CoreAuthError, PROVIDER_NAMES, type AccountSummary, type LoginMethods, type OAuthLink, type SessionInfo } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';

/**
 * Account security for an Application Core session.
 *
 * A separate screen from the legacy `Account.tsx`, which manages the Worker-backed
 * session (cloud backup, sessions, profile). Merging the two would produce a
 * page where some rows talk to one backend and some to the other, with no way for a
 * reader — or a debugger — to tell which.
 *
 * Everything here is destructive-or-sensitive, so each action re-proves identity
 * rather than trusting the session alone: unlink wants the account's password, and
 * deletion wants the password too. A stolen session should not be enough to change
 * how an account is reached.
 */

const on = 'text-[var(--color-m3-on-surface)] ';
const muted = 'text-[var(--color-m3-on-surface-variant)] ';
const divider = 'border-b border-[var(--color-m3-outline-variant)] ';

interface CoreAccountSettingsProps {
  session: CoreSession;
  onBack: () => void;
  /** Called after deletion, so the app can return to a signed-out state. */
  onDeleted: () => void;
}

type Dialog = null | 'password' | 'unlink' | 'delete';

/**
 * A date for display, or null when there is not one to show.
 *
 * Guarded rather than trusting the input: this is rendered from a value the server
 * sends, and "Invalid Date" is worse than a blank — it reads as a fault in the app
 * rather than a value we never had.
 */
function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

/**
 * What a linked-provider row says under the name.
 *
 * The linked date is normally known, but the string is chosen rather than assembled:
 * `linked_used` carries two placeholders and the template has to be picked before
 * either is filled, which is what makes a missing one fall back cleanly instead of
 * leaving a stray `{last}` on screen.
 */
function linkSubtitle(
  t: (key: string) => string,
  link: { linkedAt: string | null; lastLoginAt: string | null } | undefined,
  fallback: string,
): string {
  const linked = formatDate(link?.linkedAt);
  const last = formatDate(link?.lastLoginAt);
  if (!linked) return fallback;
  if (!last) return t('core.acct.linked').replace('{date}', linked);
  return t('core.acct.linked_used').replace('{date}', linked).replace('{last}', last);
}

/** "Windows · Edge" from a user agent, or the caller's fallback when it says nothing. */
function describeDevice(userAgent: string | null, fallback: string): string {
  if (!userAgent) return fallback;
  const os = /Windows NT/.test(userAgent) ? 'Windows'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent) ? 'iOS'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux' : '';
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari' : '';
  const parts = [os, browser].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : fallback;
}

const CoreAccountSettings: React.FC<CoreAccountSettingsProps> = ({ session, onBack, onDeleted }) => {
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [links, setLinks] = useState<OAuthLink[]>([]);
  /** `providers` here are the *linked* ones; whether Google is offered is `/health`. */
  const [methods, setMethods] = useState<LoginMethods | null>(null);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Nothing paints until the first load lands — see the skeleton below.
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Which provider the unlink dialog is about, set by the row that opened it. */
  const [unlinkTarget, setUnlinkTarget] = useState<'x' | 'google' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { t } = useTranslation();
  const token = session.token;
  const createdDate = formatDate(summary?.createdAt);

  const refresh = useCallback(async () => {
    if (!token) {
      setLoaded(true);
      return;
    }
    try {
      const [s, l, m, offered, d] = await Promise.all([
        coreAuth.summary(token),
        coreAuth.listXLinks(token),
        coreAuth.loginMethods(token).catch(() => null),
        coreAuth.loginProviders(),
        // A server that has not learned the sessions route yet must not break the page.
        coreAuth.listSessions(token).catch(() => [] as SessionInfo[]),
      ]);
      setSummary(s);
      setLinks(l);
      setMethods(m);
      setGoogleAvailable(offered.google);
      setSessions(d);
    } catch {
      // Leave the previous values rather than blanking the page on a transient
      // failure; the next refresh will correct them.
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function describe(error: unknown): string {
    if (error instanceof CoreAuthError) {
      switch (error.kind) {
        case 'invalid_credentials':
          return 'Incorrect password.';
        case 'locked':
          return 'Too many failed attempts. Wait a few minutes.';
        case 'not_configured':
          return 'X sign-in is not available on this server.';
        case 'network':
          return 'Could not reach the server.';
        default:
          return error.message;
      }
    }
    return 'Something went wrong.';
  }

  async function run(action: () => Promise<void>, successNotice?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successNotice) setNotice(successNotice);
      await refresh();
    } catch (err) {
      setError(describe(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  /** Send the browser to a provider's authorization page, to attach it to this account. */
  async function handleLink(provider: 'x' | 'google') {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await coreAuth.startOAuth(provider, 'link', { token: token ?? undefined });
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  /**
   * Whether a provider may be detached.
   *
   * Never when it is the last way in: the server refuses that, and a row whose only
   * outcome is an error should not be offered. Named per provider rather than read from
   * `recoveryRisk`, because an account with two providers linked and no password is at
   * risk of losing the *account* yet can still safely drop one of them.
   */
  const canDetach = (provider: 'x' | 'google') =>
    methods === null || methods.hasPassword || methods.providers.some((p) => p !== provider);

  // Nothing paints until the first load lands: the page used to render only the parts
  // that need no data and then grow as the summary and the X link arrived, which reads
  // as a flicker on every visit.
  if (!loaded) return <AccountSkeleton />;

  return (
    <div className="pt-4 pb-32 min-h-full flex justify-start md:justify-center">
      <div className="mx-auto w-full max-w-[36rem] px-4">
        <button
          onClick={onBack}
          className={`text-sm mb-4 inline-flex items-center gap-1.5 ${muted} hover:underline`}
        >
          ← {t('core.back')}
        </button>

        <h1 className="text-m3-title-xl mb-1">{t('core.acct.title')}</h1>
        <p className={`text-xs mb-6 ${muted}`}>
          {t('core.acct.signed_in_as')} <span className="font-medium">{session.user?.username}</span>
          {createdDate ? ` · ${t('core.acct.created').replace('{date}', createdDate)}` : ''}
        </p>

        {notice && (
          <p className="callout !text-m3-label-medium mb-4" role="status">{notice}</p>
        )}
        {error && (
          <p
            className="text-xs flex items-start gap-1.5 text-cos-error mb-4"
            role="alert"
          >
            <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {/* ── What this account holds ──────────────────────────────────────── */}
        {summary && (
          <section className="mb-6">
            <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.acct.your_records')}</span>
            <div className={`mt-2 rounded-[var(--radius-md)] border ${divider.replace('border-b ', '')} border-[var(--color-m3-outline-variant)]  px-4`}>
              <Stat label={t('core.acct.doses')} value={summary.doseCount} />
              <Stat label={t('core.acct.labs')} value={summary.labCount} />
            </div>
          </section>
        )}

        {/* ── Sign-in methods ─────────────────────────────────────────────── */}
        <section className="mb-6">
          <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.acct.signin_methods')}</span>

          <div className="mt-2 flex flex-col">
            <Row
              icon={<Icon icon={RefreshCw} size={17} />}
              title={t('core.acct.change_pw')}
              subtitle={t('core.acct.change_pw_sub')}
              onClick={() => setDialog('password')}
            />
          </div>
        </section>

        {/* ── X ────────────────────────────────────────────────────────────── */}
        {summary?.xLoginAvailable !== false && (
          <section className="mb-6">
            <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.acct.x_section')}</span>

            <div className="mt-2 flex flex-col">
              {links.length === 0 ? (
                <Row
                  icon={<span className="text-m3-title-medium font-semibold">𝕏</span>}
                  title={t('core.acct.connect').replace('{provider}', 'X')}
                  subtitle={t('core.acct.connect_sub').replace('{provider}', 'X')}
                  onClick={() => handleLink('x')}
                  disabled={busy}
                />
              ) : (
                links.map((l) => (
                  <Row
                    key={l.handle ?? l.linkedAt}
                    icon={l.avatarUrl ? (
                      // The real avatar once we have one. The provider’s own image is the honest
                      // marker that a *specific* X account is linked, which the generic glyph cannot say.
                      <img
                        src={l.avatarUrl}
                        alt=""
                        className="w-6 h-6 rounded-full object-cover"
                        // A broken image must not leave a torn-icon in the row; hiding it degrades to
                        // the empty slot rather than a broken glyph.
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : (
                      <span className="text-m3-title-medium font-semibold">𝕏</span>
                    )}
                    title={l.handle ? `@${l.handle}` : t('core.acct.x_section')}
                    subtitle={linkSubtitle(t, l, t('core.acct.x_section'))}
                    right={canDetach('x') ? <Icon icon={Unlink} size={15} className={muted} /> : undefined}
                    onClick={canDetach('x') ? () => { setUnlinkTarget('x'); setDialog('unlink'); } : undefined}
                  />
                ))
              )}
            </div>

            <p className={`text-xs mt-2 ${muted}`}>
              {canDetach('x') ? t('core.acct.unlink_note') : t('core.bind.banner')}
            </p>
          </section>
        )}

        {/* ── Google ───────────────────────────────────────────────────────── */}
        {/* Same row, same rules. No handle and no avatar by design: the app asks Google
            for the `openid` scope only, so there is nothing to show but the name.
            A link still shows when the deployment has stopped offering Google, or the
            account would have no way to detach it. */}
        {(googleAvailable || methods?.providers.includes('google')) && (
          <section className="mb-6">
            <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.acct.google_section')}</span>

            <div className="mt-2 flex flex-col">
              {methods?.providers.includes('google') ? (
                <Row
                  icon={<span className="text-m3-title-medium font-semibold">G</span>}
                  title={t('core.acct.google_section')}
                  subtitle={linkSubtitle(t, methods.links.find((l) => l.provider === 'google'), t('core.acct.google_section'))}
                  right={canDetach('google') ? <Icon icon={Unlink} size={15} className={muted} /> : undefined}
                  onClick={canDetach('google') ? () => { setUnlinkTarget('google'); setDialog('unlink'); } : undefined}
                />
              ) : (
                <Row
                  icon={<span className="text-m3-title-medium font-semibold">G</span>}
                  title={t('core.acct.connect').replace('{provider}', 'Google')}
                  subtitle={t('core.acct.connect_sub').replace('{provider}', 'Google')}
                  onClick={() => handleLink('google')}
                  disabled={busy}
                />
              )}
            </div>

            <p className={`text-xs mt-2 ${muted}`}>
              {canDetach('google') ? t('core.acct.unlink_note') : t('core.bind.banner')}
            </p>
          </section>
        )}

        {/* ── Signed-in devices ────────────────────────────────────────────── */}
        {/* Listed so a person can end access they no longer recognise. The list names
            devices, never tokens — see `listUserSessions` on the server. */}
        {sessions.length > 0 && (
          <section className="mb-6">
            <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.sessions.section')}</span>

            <div className="mt-2 flex flex-col">
              {sessions.map((s) => (
                <Row
                  key={s.id}
                  icon={<Icon icon={MonitorSmartphone} size={17} />}
                  title={`${describeDevice(s.userAgent, t('core.sessions.unknown_device'))}${
                    s.sessions > 1 ? ` · ${t('core.sessions.count').replace('{n}', String(s.sessions))}` : ''
                  }`}
                  subtitle={t('core.sessions.last_seen').replace('{when}', formatDate(s.lastSeenAt) ?? '—')}
                  right={s.current
                    ? <span className={`text-xs ${muted}`}>{t('core.sessions.current')}</span>
                    : <Icon icon={Trash2} size={15} className={muted} />}
                  danger={!s.current}
                  onClick={s.current ? undefined : () => {
                    void run(async () => {
                      await coreAuth.revokeSessions(token!, s.ids);
                      await refresh();
                    }, t('core.sessions.notice_revoked'));
                  }}
                  disabled={busy}
                />
              ))}

              {sessions.some((s) => !s.current) && (
                <Row
                  icon={<Icon icon={LogOut} size={17} />}
                  title={t('core.sessions.revoke_others')}
                  danger
                  onClick={() => {
                    void run(async () => {
                      await coreAuth.revokeOtherSessions(token!);
                      await refresh();
                    }, t('core.sessions.notice_revoked_others'));
                  }}
                  disabled={busy}
                />
              )}
            </div>

            <p className={`text-xs mt-2 ${muted}`}>{t('core.sessions.note')}</p>
          </section>
        )}

        {/* ── Delete ───────────────────────────────────────────────────────── */}
        <section>
          <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.acct.delete_section')}</span>
          <div className="mt-2 flex flex-col">
            <Row
              icon={<Icon icon={Trash2} size={17} />}
              title={t('core.acct.delete')}
              subtitle={
                summary
                  ? t('core.acct.delete_sub')
                      .replace('{doses}', String(summary.doseCount))
                      .replace('{labs}', String(summary.labCount))
                  : t('core.acct.delete_sub_basic')
              }
              danger
              onClick={() => setDialog('delete')}
            />
          </div>
        </section>

        <button
          onClick={() => void session.signOut().then(onBack)}
          className={`mt-6 w-full flex items-center justify-center gap-2 py-3 rounded-[var(--radius-sm)] border ${divider.replace('border-b ', '')} border-[var(--color-m3-outline-variant)]  text-sm hover:bg-[var(--color-m3-surface-container)]  transition-colors`}
          style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
        >
          <Icon icon={LogOut} size={16} />
          {t('core.acct.sign_out')}
        </button>
      </div>

      {/* ── Dialogs ────────────────────────────────────────────────────────── */}
      {dialog === 'password' && (
        <PasswordDialog
          busy={busy}
          onClose={() => { setDialog(null); setError(null); }}
          onSubmit={async (current, next) => {
            await run(async () => {
              await coreAuth.changePassword(token!, current, next);
              setNotice(t('core.acct.notice_pw_changed'));
            });
            setDialog(null);
          }}
          describeError={describe}
        />
      )}

      {dialog === 'unlink' && unlinkTarget && (
        <UnlinkDialog
          busy={busy}
          provider={unlinkTarget}
          handle={unlinkTarget === 'x' ? links[0]?.handle ?? null : null}
          onClose={() => { setDialog(null); setError(null); }}
          onSubmit={async () => {
            await run(async () => {
              await coreAuth.unlinkOAuth(token!, unlinkTarget);
            }, t('core.acct.notice_unlinked'));
            setDialog(null);
          }}
          describeError={describe}
        />
      )}

      {dialog === 'delete' && (
        <DeleteDialog
          busy={busy}
          summary={summary}
          onClose={() => { setDialog(null); setError(null); }}
          onSubmit={async (password) => {
            await run(async () => {
              await coreAuth.deleteAccount(token!, password);
            });
            // The session is gone server-side; clear it locally and leave.
            await session.signOut().catch(() => undefined);
            onDeleted();
          }}
          describeError={describe}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/** The account page's shape before the first load lands, so nothing moves when it does. */
const AccountSkeleton: React.FC = () => (
  <div className="pt-4 pb-32 min-h-full flex justify-start md:justify-center" aria-busy="true">
    <div className="mx-auto w-full max-w-[36rem] px-4 space-y-4">
      {[0, 1, 2].map((row) => (
        <div key={row} className="space-y-2">
          <div className="h-3 w-28 rounded bg-[var(--color-m3-surface-container-high)] animate-pulse motion-reduce:animate-none" />
          <div className="h-14 w-full rounded-[var(--radius-md)] bg-[var(--color-m3-surface-container-high)] animate-pulse motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  </div>
);

const Stat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className={`flex items-center justify-between py-3 ${divider} last:border-b-0`}>
    <span className={`text-sm ${muted}`}>{label}</span>
    <span className={`text-sm font-medium tabular-nums ${on}`}>{value}</span>
  </div>
);

const Row: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}> = ({ icon, title, subtitle, right, onClick, danger, disabled }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick, disabled } : {})}
      className={`w-full flex items-start gap-3 py-3.5 text-start ${divider} last:border-b-0 ${
        onClick ? 'hover:bg-[var(--color-m3-surface-container)]  -mx-2 px-2 rounded transition-colors disabled:opacity-50' : ''
      }`}
      style={onClick ? { transitionDuration: 'var(--md-sys-motion-duration-short3)' } : undefined}
    >
      <span className={`mt-0.5 shrink-0 ${danger ? 'text-cos-error' : muted}`}>{icon}</span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm ${danger ? 'text-cos-error' : on}`}>{title}</span>
        {subtitle && <span className={`block text-xs mt-0.5 leading-relaxed ${muted}`}>{subtitle}</span>}
      </span>
      {right && <span className="mt-0.5 shrink-0">{right}</span>}
    </Tag>
  );
};

/** Shared shell for the dialogs below, so motion and dismissal match everywhere. */
const Dialog: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  danger?: boolean;
}> = ({ title, onClose, children, danger }) => (
  <div className="modal-overlay z-[70]" data-state="open" role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-shell">
      <div className="modal-card">
        <h3 className={`modal-title ${danger ? 'text-cos-error' : ''}`}>{title}</h3>
        {children}
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full text-xs py-2 text-[var(--color-m3-on-surface-variant)]  hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
);

const Field: React.FC<{
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  hint?: string;
}> = ({ label, type = 'text', value, onChange, placeholder, autoFocus, hint }) => (
  <div className="space-y-1.5">
    <label className="text-sm">{label}</label>
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      autoComplete={type === 'password' ? 'off' : 'one-time-code'}
      className="input-base"
    />
    {hint && (
      <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
        {hint}
      </p>
    )}
  </div>
);

const Submit: React.FC<{ busy: boolean; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({
  busy,
  disabled,
  danger,
  children,
}) => (
  <button
    type="submit"
    disabled={busy || disabled}
    className={`${danger ? 'bg-cos-error text-cos-on-error' : 'btn-primary'} w-full mt-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-[var(--radius-sm)] text-sm font-medium disabled:opacity-50`}
  >
    {busy && <Icon icon={Loader2} size={16} className="animate-spin" />}
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const PasswordDialog: React.FC<{
  busy: boolean;
  onClose: () => void;
  onSubmit: (current: string, next: string) => Promise<void>;
  describeError: (e: unknown) => string;
}> = ({ busy, onClose, onSubmit, describeError }) => {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <Dialog title={t('core.pw.submit')} onClose={onClose}>
      <form
        className="space-y-3 mt-1"
        onSubmit={async (e) => {
          e.preventDefault();
          // Checked locally because it is the one mistake the server cannot catch:
          // a typo'd confirmation would otherwise lock the user out of their own data.
          if (next !== confirm) {
            setLocalError(t('core.pw.mismatch'));
            return;
          }
          setLocalError(null);
          try {
            await onSubmit(current, next);
          } catch (err) {
            setLocalError(describeError(err));
          }
        }}
      >
        <Field label={t('core.pw.current')} type="password" value={current} onChange={setCurrent} autoFocus />
        <Field
          label={t('core.pw.new')}
          type="password"
          value={next}
          onChange={setNext}
          hint={t('core.pw.new_hint')}
        />
        <Field label={t('core.pw.confirm')} type="password" value={confirm} onChange={setConfirm} />
        {localError && <p className="text-xs text-cos-error" role="alert">{localError}</p>}
        <Submit busy={busy} disabled={!current || next.length < 8}>{t('core.pw.submit')}</Submit>
      </form>
    </Dialog>
  );
};

/**
 * Unlink a provider.
 *
 * No credential is asked for: unlinking only removes a way *in*, so it cannot lock
 * anyone out, and the session already proves who is asking. The server still refuses
 * the last way in — which is why the row that opens this is not offered when there is
 * no password to fall back on.
 */
const UnlinkDialog: React.FC<{
  busy: boolean;
  provider: 'x' | 'google';
  handle: string | null;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  describeError: (e: unknown) => string;
}> = ({ busy, provider, handle, onClose, onSubmit, describeError }) => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const name = PROVIDER_NAMES[provider];

  return (
    <Dialog title={t('core.unlink.title').replace('{provider}', name)} onClose={onClose}>
      <p className="text-xs text-[var(--color-m3-on-surface-variant)]  mb-3">
        {handle
          ? t('core.unlink.body').replace('{handle}', `@${handle}`)
          : t('core.unlink.body_generic').replace('{provider}', name)}
      </p>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await onSubmit();
          } catch (err) {
            setError(describeError(err));
          }
        }}
      >
        {error && <p className="text-xs text-cos-error" role="alert">{error}</p>}
        <Submit busy={busy}>{t('core.unlink.submit')}</Submit>
      </form>
    </Dialog>
  );
};

const DeleteDialog: React.FC<{
  busy: boolean;
  summary: AccountSummary | null;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void>;
  describeError: (e: unknown) => string;
}> = ({ busy, summary, onClose, onSubmit, describeError }) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Typing the word is deliberate friction on an irreversible action. It also makes
  // an accidental Enter-through impossible.
  const ready = confirmText.trim().toUpperCase() === 'DELETE' && !!password;

  return (
    <Dialog title={t('core.del.title')} onClose={onClose} danger>
      <div className="callout !text-m3-label-medium mb-3">
        <strong>{t('core.del.warning')}</strong>
        {summary && (
          <> {t('core.del.warning_counts').replace('{doses}', String(summary.doseCount)).replace('{labs}', String(summary.labCount))}</>
        )}
        {' '}{t('core.del.warning_key')}
      </div>

      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setError(null);
          try {
            await onSubmit(password);
          } catch (err) {
            setError(describeError(err));
          }
        }}
      >
        <Field label={t('core.del.password')} type="password" value={password} onChange={setPassword} autoFocus />

        <Field
          label={t('core.del.confirm_label')}
          value={confirmText}
          onChange={setConfirmText}
          placeholder="DELETE"
        />

        {error && <p className="text-xs text-cos-error" role="alert">{error}</p>}

        <Submit busy={busy} disabled={!ready} danger>{t('core.del.submit')}</Submit>
      </form>
    </Dialog>
  );
};

export default CoreAccountSettings;
