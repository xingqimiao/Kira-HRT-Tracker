import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unlink,
} from 'lucide-react';

import { coreAuth, CoreAuthError, type AccountSummary, type XLink } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';

/**
 * Account security for an Application Core session.
 *
 * A separate screen from the legacy `Account.tsx`, which manages the Worker-backed
 * session (cloud backup, passkeys, sessions, profile). Merging the two would produce a
 * page where some rows talk to one backend and some to the other, with no way for a
 * reader — or a debugger — to tell which.
 *
 * Everything here is destructive-or-sensitive, so each action re-proves identity
 * rather than trusting the session alone: unlink and recovery-code rotation want a
 * second-factor code, deletion wants the password and a code. A stolen session should
 * not be enough to change how an account is reached.
 */

const on = 'text-[var(--color-m3-on-surface)] dark:text-[var(--color-m3-dark-on-surface)]';
const muted = 'text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)]';
const divider = 'border-b border-[var(--color-m3-outline-variant)] dark:border-[var(--color-m3-dark-outline-variant)]';

interface CoreAccountSettingsProps {
  session: CoreSession;
  onBack: () => void;
  /** Called after deletion, so the app can return to a signed-out state. */
  onDeleted: () => void;
}

type Dialog = null | 'password' | 'recovery' | 'unlink' | 'delete';

const CoreAccountSettings: React.FC<CoreAccountSettingsProps> = ({ session, onBack, onDeleted }) => {
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [links, setLinks] = useState<XLink[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { t } = useTranslation();
  const token = session.token;

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
      <div className="w-full max-w-[36rem] px-4">
        <button
          onClick={onBack}
          className={`text-sm mb-4 inline-flex items-center gap-1.5 ${muted} hover:underline`}
        >
          ← Back
        </button>

        <h1 className="text-xl font-semibold mb-1">{t('core.acct.title')}</h1>
        <p className={`text-xs mb-6 ${muted}`}>
          {t('core.acct.signed_in_as')} <span className="font-medium">{session.user?.username}</span>
          {summary?.createdAt ? ` · ${t('core.acct.created')} ${new Date(summary.createdAt).toLocaleDateString()}` : ''}
        </p>

        {notice && (
          <p className="callout !text-[0.75rem] mb-4" role="status">{notice}</p>
        )}
        {error && (
          <p
            className="text-xs flex items-start gap-1.5 text-[#B3261E] mb-4"
            role="alert"
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {/* ── What this account holds ──────────────────────────────────────── */}
        {summary && (
          <section className="mb-6">
            <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.acct.your_records')}</span>
            <div className={`mt-2 rounded-[var(--radius-md)] border ${divider.replace('border-b ', '')} border-[var(--color-m3-outline-variant)] dark:border-[var(--color-m3-dark-outline-variant)] px-4`}>
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
              icon={<ShieldCheck size={17} />}
              title={t('core.acct.pw_and_totp')}
              subtitle={t('core.acct.pw_and_totp_sub')}
              right={<span className={`text-xs ${muted}`}>{t('core.acct.active')}</span>}
            />

            <Row
              icon={<RefreshCw size={17} />}
              title={t('core.acct.change_pw')}
              subtitle={t('core.acct.change_pw_sub')}
              onClick={() => setDialog('password')}
            />

            <Row
              icon={<Copy size={17} />}
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
                    icon={<span className="text-[15px] font-semibold">𝕏</span>}
                    title={l.handle ? `@${l.handle}` : t('core.acct.x_section')}
                    subtitle={
                      l.lastLoginAt
                        ? t('core.acct.x_linked_used')
                            .replace('{date}', new Date(l.linkedAt).toLocaleDateString())
                            .replace('{last}', new Date(l.lastLoginAt).toLocaleDateString())
                        : t('core.acct.x_linked').replace('{date}', new Date(l.linkedAt).toLocaleDateString())
                    }
                    right={<Unlink size={15} className={muted} />}
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

        {/* ── Delete ───────────────────────────────────────────────────────── */}
        <section>
          <span className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('core.acct.delete_section')}</span>
          <div className="mt-2 flex flex-col">
            <Row
              icon={<Trash2 size={17} />}
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
          className={`mt-6 w-full flex items-center justify-center gap-2 py-3 rounded-[var(--radius-sm)] border ${divider.replace('border-b ', '')} border-[var(--color-m3-outline-variant)] dark:border-[var(--color-m3-dark-outline-variant)] text-sm hover:bg-[var(--color-m3-surface-container)] dark:hover:bg-[var(--color-m3-dark-surface-container)] transition-colors`}
          style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
        >
          <LogOut size={16} />
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

      {dialog === 'unlink' && (
        <UnlinkDialog
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
        onClick ? 'hover:bg-[var(--color-m3-surface-container)] dark:hover:bg-[var(--color-m3-dark-surface-container)] -mx-2 px-2 rounded transition-colors disabled:opacity-50' : ''
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
          className="mt-3 w-full text-xs py-2 text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)] hover:underline"
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
      <p className="text-xs text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)]">
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
    className={`${danger ? 'bg-[#B3261E] text-white' : 'btn-primary'} w-full mt-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-[var(--radius-sm)] text-sm font-medium disabled:opacity-50`}
  >
    {busy && <Loader2 size={16} className="animate-spin" />}
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

const RecoveryDialog: React.FC<{
  busy: boolean;
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
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.8125rem] px-3 py-3 rounded-[var(--radius-sm)] border border-[var(--color-m3-outline-variant)] dark:border-[var(--color-m3-dark-outline-variant)] bg-[var(--color-m3-surface-container-low)] dark:bg-[var(--color-m3-dark-surface-container)]">
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
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? t('core.copied') : t('core.regen.copy_all')}
        </button>
      </Dialog>
    );
  }

  return (
    <Dialog title={t('core.acct.regen')} onClose={onClose}>
      <p className="text-xs text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)] mb-3">
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
      <p className="text-xs text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)] mb-3">
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
          className="text-xs text-[var(--color-m3-primary)] dark:text-[var(--color-m3-primary-light)] hover:underline"
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
