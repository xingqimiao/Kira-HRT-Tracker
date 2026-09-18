import React, { useCallback, useEffect, useState } from 'react';
import Icon from '../components/Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { AlertTriangle, Check, Copy, KeyRound, Loader2, LogOut, Lock, RefreshCw, ShieldCheck, Trash2, Unlink } from '../icons';

import { coreAuth, CoreAuthError, type AccountSummary, type PrivacyMode, type XLink } from '../services/coreAuth';
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
 * rather than trusting the session alone: unlink and recovery-code rotation want a
 * second-factor code, deletion wants the password and a code. A stolen session should
 * not be enough to change how an account is reached.
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

type Dialog = null | 'password' | 'recovery' | 'unlink' | 'delete' | 'privacy' | 'recoveryKey';

/** What each mode actually does, in the words the spec asked for. */
function privacyCopy(t: (k: string) => string, mode: PrivacyMode) {
  return mode === 'advanced'
    ? { name: t('core.privacy.advanced_name'), blurb: t('core.privacy.advanced_desc') }
    : { name: t('core.privacy.standard_name'), blurb: t('core.privacy.standard_desc') };
}

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
 * What an X row says under the handle.
 *
 * The linked date is normally known, but the string is chosen rather than assembled:
 * `x_linked_used` carries two placeholders and the template has to be picked before
 * either is filled, which is what makes a missing one fall back cleanly instead of
 * leaving a stray `{last}` on screen.
 */
function xLinkSubtitle(
  t: (key: string) => string,
  link: { linkedAt: string | null; lastLoginAt: string | null },
): string {
  const linked = formatDate(link.linkedAt);
  const last = formatDate(link.lastLoginAt);
  if (!linked) return t('core.acct.x_section');
  if (!last) return t('core.acct.x_linked').replace('{date}', linked);
  return t('core.acct.x_linked_used').replace('{date}', linked).replace('{last}', last);
}

const CoreAccountSettings: React.FC<CoreAccountSettingsProps> = ({ session, onBack, onDeleted }) => {
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [links, setLinks] = useState<XLink[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { t } = useTranslation();
  const token = session.token;
  const createdDate = formatDate(summary?.createdAt);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [s, l] = await Promise.all([coreAuth.summary(token), coreAuth.listXLinks(token)]);
      setSummary(s);
      setLinks(l);
    } catch {
      // Leave the previous values rather than blanking the page on a transient
      // failure; the next refresh will correct them.
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function describe(error: unknown): string {
    if (error instanceof CoreAuthError) {
      switch (error.kind) {
        case 'invalid_credentials':
          return 'Incorrect password or code.';
        case 'two_factor_required':
          return 'Enter a code from your authenticator.';
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

  async function handleLinkX() {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await coreAuth.startX('link', token ?? undefined);
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  return (
    <div className="pt-4 pb-32 min-h-full flex justify-start md:justify-center">
      <div className="mx-auto w-full max-w-[36rem] px-4">
        <button
          onClick={onBack}
          className={`text-sm mb-4 inline-flex items-center gap-1.5 ${muted} hover:underline`}
        >
          ← Back
        </button>

        <h1 className="text-xl font-semibold mb-1">{t('core.acct.title')}</h1>
        <p className={`text-xs mb-6 ${muted}`}>
          {t('core.acct.signed_in_as')} <span className="font-medium">{session.user?.username}</span>
          {createdDate ? ` · ${t('core.acct.created').replace('{date}', createdDate)}` : ''}
        </p>

        {notice && (
          <p className="callout !text-[0.75rem] mb-4" role="status">{notice}</p>
        )}
        {error && (
          <p
            className="text-xs flex items-start gap-1.5 text-[#B3261E] mb-4"
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
              <Stat label={t('core.acct.codes_left')} value={summary.recoveryCodesRemaining} warn={summary.recoveryCodesRemaining <= 2} />
            </div>
            {summary.recoveryCodesRemaining <= 2 && (
              <p className={`text-xs mt-2 ${muted}`}>
                {/* Surfaced early because the alternative is finding out when they run
                    out, which is the moment someone has already lost their phone. */}
                {t('core.acct.codes_low')}
              </p>
            )}
          </section>
        )}

        {/* ── Sign-in methods ─────────────────────────────────────────────── */}
        <section className="mb-6">
          <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.acct.signin_methods')}</span>

          <div className="mt-2 flex flex-col">
            <Row
              icon={<Icon icon={ShieldCheck} size={17} />}
              title={t('core.acct.pw_and_totp')}
              subtitle={t('core.acct.pw_and_totp_sub')}
              right={<span className={`text-xs ${muted}`}>{t('core.acct.active')}</span>}
            />

            <Row
              icon={<Icon icon={RefreshCw} size={17} />}
              title={t('core.acct.change_pw')}
              subtitle={t('core.acct.change_pw_sub')}
              onClick={() => setDialog('password')}
            />

            <Row
              icon={<Icon icon={Copy} size={17} />}
              title={t('core.acct.regen')}
              subtitle={
                summary
                  ? t('core.acct.regen_sub').replace('{n}', String(summary.recoveryCodesRemaining))
                  : t('core.acct.regen_sub_none')
              }
              onClick={() => setDialog('recovery')}
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
                  icon={<span className="text-[15px] font-semibold">𝕏</span>}
                  title={t('core.acct.x_connect')}
                  subtitle={t('core.acct.x_connect_sub')}
                  onClick={handleLinkX}
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
                      <span className="text-[15px] font-semibold">𝕏</span>
                    )}
                    title={l.handle ? `@${l.handle}` : t('core.acct.x_section')}
                    subtitle={xLinkSubtitle(t, l)}
                    right={<Icon icon={Unlink} size={15} className={muted} />}
                    onClick={() => setDialog('unlink')}
                  />
                ))
              )}
            </div>

            <p className={`text-xs mt-2 ${muted}`}>
              {t('core.acct.x_unlink_note')}
            </p>
          </section>
        )}

        {/* ── Privacy mode ─────────────────────────────────────────────────── */}
        <section className="mb-6">
          <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.privacy.section')}</span>

          <div className="mt-2 flex flex-col">
            <Row
              icon={<Icon icon={Lock} size={17} />}
              title={summary ? privacyCopy(t, summary.privacyMode).name : t('core.privacy.section')}
              subtitle={summary ? privacyCopy(t, summary.privacyMode).blurb : undefined}
              right={summary ? <span className={`text-xs ${muted}`}>{t('core.privacy.manage')}</span> : undefined}
              onClick={summary ? () => setDialog('privacy') : undefined}
              disabled={busy}
            />

            {/* Only offered in advanced mode, because only advanced has no server key
                to fall back on. Shown as "replace" once one exists. */}
            {summary?.privacyMode === 'advanced' && (
              <Row
                icon={<Icon icon={KeyRound} size={17} />}
                title={summary.hasRecoveryKey ? t('core.privacy.replace_recovery') : t('core.privacy.create_recovery')}
                subtitle={
                  summary.hasRecoveryKey
                    ? t('core.privacy.recovery_exists')
                    : t('core.privacy.recovery_recommend')
                }
                onClick={() => setDialog('recoveryKey')}
                disabled={busy}
              />
            )}
          </div>

          <p className={`text-xs mt-2 ${muted}`}>
            {summary?.privacyMode === 'advanced'
              ? t('core.privacy.advanced_warning')
              : t('core.privacy.standard_note')}
          </p>
        </section>

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
              const res = await coreAuth.changePassword(token!, current, next);
              if (res.recoveryCodes) {
                setNotice(t('core.acct.notice_pw_set'));
              } else {
                setNotice(t('core.acct.notice_pw_changed'));
              }
            });
            setDialog(null);
          }}
          describeError={describe}
        />
      )}

      {dialog === 'recovery' && (
        <RecoveryDialog
          busy={busy}
          onClose={() => { setDialog(null); setError(null); }}
          onSubmit={async (code) => {
            let codes: string[] = [];
            await run(async () => {
              codes = await coreAuth.regenerateRecoveryCodes(token!, code);
            });
            return codes;
          }}
          describeError={describe}
        />
      )}

      {dialog === 'privacy' && summary && (
        <PrivacyDialog
          busy={busy}
          current={summary.privacyMode}
          serverRecoveryAvailable={summary.serverRecoveryAvailable}
          onClose={() => { setDialog(null); setError(null); }}
          onSubmit={async (mode, currentPassword) => {
            await run(async () => {
              const next = await coreAuth.switchPrivacyMode(token!, mode, currentPassword);
              await refresh();
              if (next === 'advanced') setNotice(t('core.privacy.notice_advanced'));
              else setNotice(t('core.privacy.notice_standard'));
            });
            setDialog(null);
          }}
          describeError={describe}
        />
      )}

      {dialog === 'recoveryKey' && (
        <RecoveryKeyDialog
          busy={busy}
          onClose={() => { setDialog(null); setError(null); }}
          onSubmit={async (currentPassword) => {
            let key = '';
            await run(async () => {
              key = await coreAuth.createRecoveryKey(token!, currentPassword);
              await refresh();
            });
            return key;
          }}
          describeError={describe}
        />
      )}

      {dialog === 'unlink' && (        <UnlinkDialog
          busy={busy}
          handle={links[0]?.handle ?? null}
          onClose={() => { setDialog(null); setError(null); }}
          onSubmit={async (code) => {
            await run(async () => {
              await coreAuth.unlinkX(token!, code);
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
          onSubmit={async (password, code, useBackup, backupCode) => {
            await run(async () => {
              await coreAuth.deleteAccount(token!, password, {
                ...(useBackup ? { backupCode } : { code }),
              });
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

const Stat: React.FC<{ label: string; value: number; warn?: boolean }> = ({ label, value, warn }) => (
  <div className={`flex items-center justify-between py-3 ${divider} last:border-b-0`}>
    <span className={`text-sm ${muted}`}>{label}</span>
    <span className={`text-sm font-medium tabular-nums ${warn ? 'text-[#B3261E]' : on}`}>{value}</span>
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
      <span className={`mt-0.5 shrink-0 ${danger ? 'text-[#B3261E]' : muted}`}>{icon}</span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm ${danger ? 'text-[#B3261E]' : on}`}>{title}</span>
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
        <h3 className={`modal-title ${danger ? 'text-[#B3261E]' : ''}`}>{title}</h3>
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
  mono?: boolean;
  hint?: string;
}> = ({ label, type = 'text', value, onChange, placeholder, autoFocus, mono, hint }) => (
  <div className="space-y-1.5">
    <label className="text-sm">{label}</label>
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      autoComplete={type === 'password' ? 'off' : 'one-time-code'}
      className={`input-base ${mono ? 'font-mono text-center tracking-[0.3em]' : ''}`}
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
    className={`${danger ? 'bg-[#B3261E] text-cos-on-primary' : 'btn-primary'} w-full mt-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-[var(--radius-sm)] text-sm font-medium disabled:opacity-50`}
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
        {localError && <p className="text-xs text-[#B3261E]" role="alert">{localError}</p>}
        <Submit busy={busy} disabled={!current || next.length < 8}>{t('core.pw.submit')}</Submit>
      </form>
    </Dialog>
  );
};

/**
 * Switch privacy mode.
 *
 * Given as a consequence-first screen rather than a toggle: both directions change
 * what the server can do with an account, and the advanced direction in particular can
 * make data unrecoverable. The credential asked for is the *current password*, because
 * this changes how the data key is protected — not a TOTP code, which is about
 * identity.
 */
const PrivacyDialog: React.FC<{
  busy: boolean;
  current: PrivacyMode;
  serverRecoveryAvailable: boolean;
  onClose: () => void;
  onSubmit: (mode: PrivacyMode, currentPassword: string) => Promise<void>;
  describeError: (e: unknown) => string;
}> = ({ busy, current, serverRecoveryAvailable, onClose, onSubmit, describeError }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PrivacyMode>(current === 'standard' ? 'advanced' : 'standard');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <Dialog title={t('core.privacy.dialog_title')} onClose={onClose}>
      <form
        className="space-y-3 mt-1"
        onSubmit={async (e) => {
          e.preventDefault();
          setLocalError(null);
          try {
            await onSubmit(mode, password);
          } catch (err) {
            setLocalError(describeError(err));
          }
        }}
      >
        <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
          {t('core.privacy.dialog_intro').replace('{mode}', privacyCopy(t, current).name)}
        </p>

        {(['standard', 'advanced'] as PrivacyMode[]).map((m) => {
          const selected = mode === m;
          const disabled = m === 'standard' && !serverRecoveryAvailable;
          return (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => setMode(m)}
              aria-pressed={selected}
              className={`w-full rounded-xl border p-3 text-left  transition-colors disabled:opacity-50 ${
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
                  {m === 'standard' ? t('core.privacy.standard_name') : t('core.privacy.advanced_name')}
                </span>
              </span>
              <span className="mt-1 block pl-6 text-xs text-[var(--color-m3-on-surface-variant)]">
                {m === 'standard' ? t('core.privacy.standard_desc') : t('core.privacy.advanced_desc')}
              </span>
            </button>
          );
        })}

        {/* The consequence, stated before the action rather than after it. */}
        {mode === 'advanced' && (
          <p className="callout !text-[0.75rem]">{t('core.privacy.advanced_warning')}</p>
        )}
        {mode === 'standard' && (
          <p className="callout !text-[0.75rem]">{t('core.privacy.downgrade_warning')}</p>
        )}

        <Field label={t('core.pw.current')} type="password" value={password} onChange={setPassword} autoFocus />
        {localError && <p className="text-xs text-[#B3261E]" role="alert">{localError}</p>}
        <Submit busy={busy} disabled={!password}>{t('core.privacy.switch_submit')}</Submit>
      </form>
    </Dialog>
  );
};

/**
 * Create a recovery key.
 *
 * The plaintext is shown exactly once and the only way out is an explicit "I have
 * saved it", because a recovery key the user never wrote down is a recovery key that
 * does not exist — and in advanced mode this is the last line of defence.
 */
const RecoveryKeyDialog: React.FC<{
  busy: boolean;
  onClose: () => void;
  onSubmit: (currentPassword: string) => Promise<string>;
  describeError: (e: unknown) => string;
}> = ({ busy, onClose, onSubmit, describeError }) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <Dialog title={t('core.privacy.recovery_dialog_title')} onClose={onClose}>
      {key === null ? (
        <form
          className="space-y-3 mt-1"
          onSubmit={async (e) => {
            e.preventDefault();
            setLocalError(null);
            try {
              setKey(await onSubmit(password));
            } catch (err) {
              setLocalError(describeError(err));
            }
          }}
        >
          <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
            {t('core.privacy.recovery_intro')}
          </p>
          <Field label={t('core.pw.current')} type="password" value={password} onChange={setPassword} autoFocus />
          {localError && <p className="text-xs text-[#B3261E]" role="alert">{localError}</p>}
          <Submit busy={busy} disabled={!password}>{t('core.privacy.recovery_generate')}</Submit>
        </form>
      ) : (
        <div className="space-y-3 mt-1">
          <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
            {t('core.privacy.recovery_once')}
          </p>
          <div className="rounded-xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container)] p-3">
            <code className="block break-all font-mono text-sm tracking-wide">{key}</code>
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(key);
              setCopied(true);
            }}
            className="btn-secondary w-full inline-flex items-center justify-center gap-2"
          >
            <Icon icon={copied ? Check : Copy} size={15} />
            {copied ? t('core.copied') : t('core.copy')}
          </button>

          {/* The explicit acknowledgement the spec asks for, and the only way to close. */}
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            <span>{t('core.privacy.recovery_ack')}</span>
          </label>

          <button
            type="button"
            disabled={!acknowledged}
            onClick={onClose}
            className="btn-primary w-full disabled:opacity-50"
          >
            {t('core.privacy.recovery_done')}
          </button>
        </div>
      )}
    </Dialog>
  );
};

const RecoveryDialog: React.FC<{  busy: boolean;
  onClose: () => void;
  onSubmit: (code: string) => Promise<string[]>;
  describeError: (e: unknown) => string;
}> = ({ busy, onClose, onSubmit, describeError }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  if (codes) {
    return (
      <Dialog title={t('core.regen.done_title')} onClose={onClose}>
        <div className="callout !text-[0.75rem] mt-1 mb-3">
          <strong>{t('core.regen.done_note').split('.')[0]}.</strong>{t('core.regen.done_note').split('.').slice(1).join('.')}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.8125rem] px-3 py-3 rounded-[var(--radius-sm)] border border-[var(--color-m3-outline-variant)]  bg-[var(--color-m3-surface-container-low)] ">
          {codes.map((c) => <span key={c}>{c}</span>)}
        </div>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(codes.join('\n'));
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch { /* clipboard unavailable; the codes are on screen */ }
          }}
          className="btn-secondary w-full mt-3 !text-xs"
        >
          {copied ? <Icon icon={Check} size={14} /> : <Icon icon={Copy} size={14} />}
          {copied ? t('core.copied') : t('core.regen.copy_all')}
        </button>
      </Dialog>
    );
  }

  return (
    <Dialog title={t('core.acct.regen')} onClose={onClose}>
      <p className="text-xs text-[var(--color-m3-on-surface-variant)]  mb-3">
        {t('core.regen.intro')}
      </p>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            setCodes(await onSubmit(code));
          } catch (err) {
            setError(describeError(err));
            setCode('');
          }
        }}
      >
        <Field label={t('core.regen.code')} value={code} onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} placeholder="000000" mono autoFocus />
        {error && <p className="text-xs text-[#B3261E]" role="alert">{error}</p>}
        <Submit busy={busy} disabled={code.length !== 6}>{t('core.regen.submit')}</Submit>
      </form>
    </Dialog>
  );
};

const UnlinkDialog: React.FC<{
  busy: boolean;
  handle: string | null;
  onClose: () => void;
  onSubmit: (code: string) => Promise<void>;
  describeError: (e: unknown) => string;
}> = ({ busy, handle, onClose, onSubmit, describeError }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog title={t('core.unlink.title')} onClose={onClose}>
      <p className="text-xs text-[var(--color-m3-on-surface-variant)]  mb-3">
        {handle
          ? t('core.unlink.body').replace('{handle}', `@${handle}`)
          : t('core.unlink.body_generic')}
      </p>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await onSubmit(code);
          } catch (err) {
            setError(describeError(err));
            setCode('');
          }
        }}
      >
        <Field
          label={t('core.unlink.code')}
          value={code}
          onChange={(v) => setCode(v.toUpperCase().trim())}
          placeholder="000000 or XXXXX-XXXXX"
          mono
          autoFocus
          hint={t('core.unlink.code_hint')}
        />
        {error && <p className="text-xs text-[#B3261E]" role="alert">{error}</p>}
        <Submit busy={busy} disabled={code.length < 6}>{t('core.unlink.submit')}</Submit>
      </form>
    </Dialog>
  );
};

const DeleteDialog: React.FC<{
  busy: boolean;
  summary: AccountSummary | null;
  onClose: () => void;
  onSubmit: (password: string, code: string, useBackup: boolean, backupCode: string) => Promise<void>;
  describeError: (e: unknown) => string;
}> = ({ busy, summary, onClose, onSubmit, describeError }) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Typing the word is deliberate friction on an irreversible action. It also makes
  // an accidental Enter-through impossible.
  const ready = confirmText.trim().toUpperCase() === 'DELETE' && !!password
    && (useBackup ? backupCode.trim().length >= 10 : code.length === 6);

  return (
    <Dialog title={t('core.del.title')} onClose={onClose} danger>
      <div className="callout !text-[0.75rem] mb-3">
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
            await onSubmit(password, code, useBackup, backupCode);
          } catch (err) {
            setError(describeError(err));
            setCode('');
          }
        }}
      >
        <Field label={t('core.del.password')} type="password" value={password} onChange={setPassword} autoFocus />

        {useBackup ? (
          <Field
            label={t('core.del.backup')}
            value={backupCode}
            onChange={(v) => setBackupCode(v.toUpperCase())}
            placeholder="XXXXX-XXXXX"
            mono
          />
        ) : (
          <Field
            label={t('core.del.totp')}
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            mono
          />
        )}

        <button
          type="button"
          onClick={() => { setUseBackup(v => !v); setError(null); }}
          className="text-xs text-[var(--color-m3-primary)]  hover:underline"
        >
          {useBackup ? t('core.del.use_totp') : t('core.del.use_backup')}
        </button>

        <Field
          label={t('core.del.confirm_label')}
          value={confirmText}
          onChange={setConfirmText}
          placeholder="DELETE"
        />

        {error && <p className="text-xs text-[#B3261E]" role="alert">{error}</p>}

        <Submit busy={busy} disabled={!ready} danger>{t('core.del.submit')}</Submit>
      </form>
    </Dialog>
  );
};

export default CoreAccountSettings;
