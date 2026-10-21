import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { AlertTriangle, Check, LogOut, RefreshCw, Trash2, Unlink, DevicePhone, DeviceTablet, DeviceDesktop, DeviceBrowser, DeviceAgent, UserCircle, X } from '../icons';
import { Progress } from '../components/ui';
import { HeaderBack } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import { GoogleBrand, XBrand } from '../icons/brand';

import { coreAuth, CoreAuthError, PROVIDER_NAMES, type AccountSummary, type LoginMethods, type OAuthLink, type SessionInfo } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import { openExternalUrl } from '../utils/externalLinks';
import { isNativeApp } from '../utils/platform';

interface CoreAccountSettingsProps {
  session: CoreSession;
  onBack: () => void;
  /** Called after deletion, so the app can return to a signed-out state. */
  onDeleted: () => void;
}

type Dialog = null | 'password' | 'unlink' | 'delete';

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

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

type DeviceKind = 'app-phone' | 'app-tablet' | 'app-desktop' | 'browser' | 'browser-mobile' | 'agent' | 'unknown';

function androidModel(userAgent: string): string {
  const m = /Android[^;]*;\s*([^;)]+?)(?:\s+Build[/)]|\s*\))/.exec(userAgent)
    || /Android[^;]*;\s*([^;)]+?)\)/.exec(userAgent);
  const token = (m?.[1] ?? '').trim();
  if (!token || /^(mobile|tablet|build|wv|k)$/i.test(token)) return '';
  return token;
}

function parseDevice(
  userAgent: string | null,
  fallback: string,
  appLabel: string,
): { label: string; kind: DeviceKind } {
  if (!userAgent) return { label: fallback, kind: 'unknown' };
  const native = /^KiraHRT\/[^\s]+ \(([^)]+)\)$/.exec(userAgent);
  if (native) {
    const raw = native[1];
    const isTablet = /tablet|ipad/i.test(raw);
    const isDesktop = /windows|macintosh|linux x86/i.test(raw);
    const kind: DeviceKind = isTablet ? 'app-tablet' : isDesktop ? 'app-desktop' : 'app-phone';
    return { label: `${appLabel} · ${raw}`, kind };
  }
  const isAgent = /claude|chatgpt|openai|cursor|windsurf|mcp/i.test(userAgent);
  if (isAgent) {
    const agent = /claude/i.test(userAgent) ? 'Claude'
      : /chatgpt|openai/i.test(userAgent) ? 'ChatGPT'
      : /cursor/i.test(userAgent) ? 'Cursor'
      : /windsurf/i.test(userAgent) ? 'Windsurf'
      : 'AI Agent';
    return { label: agent, kind: 'agent' };
  }
  const isMobile = /mobile|iphone|ipod|android/i.test(userAgent);
  const isTablet = /ipad|tablet/i.test(userAgent);
  const browser = /edg\//i.test(userAgent) ? 'Edge'
    : /chrome\//i.test(userAgent) ? 'Chrome'
    : /safari\//i.test(userAgent) && !/chrome/i.test(userAgent) ? 'Safari'
    : /firefox\//i.test(userAgent) ? 'Firefox'
    : '';
  const os = /iphone|ipad|ipod/i.test(userAgent) ? 'iOS'
    : /android/i.test(userAgent) ? 'Android'
    : /windows/i.test(userAgent) ? 'Windows'
    : /macintosh/i.test(userAgent) ? 'macOS'
    : /linux/i.test(userAgent) ? 'Linux'
    : '';
  const model = os === 'Android' ? androidModel(userAgent) : '';
  const osWithModel = model ? `Android · ${model}` : os;
  const kind: DeviceKind = isTablet ? 'app-tablet' : isMobile ? 'browser-mobile' : 'browser';
  const label = [osWithModel, browser].filter(Boolean).join(' · ') || fallback;
  return { label, kind };
}

function deviceIcon(kind: DeviceKind): typeof DevicePhone {
  switch (kind) {
    case 'app-phone':
    case 'browser-mobile':
      return DevicePhone;
    case 'app-tablet':
      return DeviceTablet;
    case 'app-desktop':
      return DeviceDesktop;
    case 'agent':
      return DeviceAgent;
    case 'browser':
    case 'unknown':
    default:
      return DeviceBrowser;
  }
}

const CoreAccountSettings: React.FC<CoreAccountSettingsProps> = ({ session, onBack, onDeleted }) => {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [methods, setMethods] = useState<LoginMethods | null>(null);
  const [links, setLinks] = useState<OAuthLink[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<'x' | 'google' | null>(null);
  const [busy, setBusy] = useState(false);

  const token = session.token;

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [sum, m, l, s, providers] = await Promise.all([
        coreAuth.summary(token),
        coreAuth.loginMethods(token).catch(() => null),
        coreAuth.listXLinks(token).catch(() => []),
        coreAuth.listSessions(token).catch(() => []),
        coreAuth.loginProviders().catch(() => ({ x: true, google: false })),
      ]);
      setSummary(sum);
      setMethods(m);
      setLinks(l);
      setSessions(s);
      setGoogleAvailable(providers.google);
      setError(null);
    } catch (err) {
      setError(describe(err));
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createdDate = formatDate(summary?.createdAt);

  function describe(err: unknown): string {
    if (err instanceof CoreAuthError) {
      switch (err.kind) {
        // The `core.err.*` keys, not `core.error.*`: the latter never existed, so
        // `t()` returned the key itself and the screen showed a variable name. The
        // `||` fallbacks could not save it — a missing key is a truthy string.
        case 'invalid_credentials':
          return t('core.err.bad_credentials');
        case 'locked':
          return t('core.err.locked');
        case 'not_configured':
          return '此服务器未配置该第三方登录。';
        case 'network':
          return t('core.err.network');
        default:
          return err.message;
      }
    }
    return '操作失败，请重试。';
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

  async function handleLink(provider: 'x' | 'google') {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await coreAuth.startOAuth(provider, 'link', {
        token: token ?? undefined,
        returnUri: isNativeApp() ? 'kira-hrt://oauth/callback' : undefined,
      });
      await openExternalUrl(authorizeUrl);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  const canDetach = (provider: 'x' | 'google') =>
    methods === null || methods.hasPassword || methods.providers.some((p) => p !== provider);

  if (!loaded) return <AccountSkeleton />;

  return (
    <div className="pg on long m3e-rise" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }}>
      <HeaderBack title={t('settings.security')} onBack={onBack} backLabel={t('core.back')} />

      <div className="d-col" style={{ gap: 14 }}>
        {notice && (
          <div className="card" style={{ background: 'var(--okc)', color: 'var(--ok)', padding: '12px 16px', borderRadius: 20 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{notice}</span>
          </div>
        )}
        {error && (
          <div className="card" style={{ background: 'var(--errc)', color: 'var(--err)', padding: '12px 16px', borderRadius: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon icon={AlertTriangle} size={16} />
            <span style={{ fontSize: 13.5 }}>{error}</span>
          </div>
        )}

        {/* ── Sign-in methods ─────────────────────────────────────────────── */}
        <div className="lab">{t('core.acct.signin_methods')}</div>
        <div className="list">
          <div className="li" role="button" tabIndex={0} onClick={() => setDialog('password')} style={{ cursor: 'pointer' }}>
            <span className="ic p"><Icon icon={RefreshCw} size={18} /></span>
            <div className="t">
              <b>{t('core.acct.change_pw')}</b>
              <span className="s">{t('core.acct.change_pw_sub')}</span>
            </div>
            <SpriteIcon id="chev" />
          </div>
        </div>

        {/* ── X ────────────────────────────────────────────────────────────── */}
        {summary?.xLoginAvailable !== false && (
          <>
            <div className="lab">{t('core.acct.x_section')}</div>
            <div className="list">
              {links.length === 0 ? (
                <div className="li" role="button" tabIndex={0} onClick={() => handleLink('x')} style={{ cursor: 'pointer' }}>
                  <span className="ic"><span style={{ fontWeight: 700, fontSize: 16 }}>𝕏</span></span>
                  <div className="t">
                    <b>{t('core.acct.connect').replace('{provider}', 'X')}</b>
                    <span className="s">{t('core.acct.connect_sub')}</span>
                  </div>
                  <SpriteIcon id="chev" />
                </div>
              ) : (
                links.map((l) => (
                  <div key={l.handle ?? l.linkedAt} className="li no-hover">
                    {l.avatarUrl ? (
                      <img
                        src={l.avatarUrl}
                        alt=""
                        style={{ width: 42, height: 42, borderRadius: '50%', objectFit: 'cover', flex: 'none' }}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <span style={{ width: 42, height: 42, display: 'grid', placeItems: 'center', flex: 'none' }}>
                        <XBrand size={42} />
                      </span>
                    )}
                    <div className="t">
                      <b>{l.handle ? `@${l.handle}` : t('core.acct.x_section')}</b>
                      <span className="s">{linkSubtitle(t, l, t('core.acct.x_section'))}</span>
                    </div>
                    {canDetach('x') && (
                      <button
                        type="button"
                        onClick={() => { setUnlinkTarget('x'); setDialog('unlink'); }}
                        className="btn x"
                        style={{ color: 'var(--err)', minWidth: 64 }}
                      >
                        <Icon icon={Unlink} size={15} />
                        <span>{t('core.acct.unlink') || '解绑'}</span>
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            {!canDetach('x') && (
              <p className="sub" style={{ margin: '0 6px' }}>{t('core.bind.banner')}</p>
            )}
          </>
        )}

        {/* ── Google ───────────────────────────────────────────────────────── */}
        {(googleAvailable || methods?.providers.includes('google')) && (
          <>
            <div className="lab">{t('core.acct.google_section')}</div>
            <div className="list">
              {methods?.providers.includes('google') ? (
                <div className="li no-hover">
                  <span style={{ width: 42, height: 42, display: 'grid', placeItems: 'center', flex: 'none' }}>
                    <GoogleBrand size={42} />
                  </span>
                  <div className="t">
                    <b>{t('core.acct.google_section')}</b>
                    <span className="s">{linkSubtitle(t, methods.links.find((l) => l.provider === 'google'), t('core.acct.google_section'))}</span>
                  </div>
                  {canDetach('google') && (
                    <button
                      type="button"
                      onClick={() => { setUnlinkTarget('google'); setDialog('unlink'); }}
                      className="btn x"
                      style={{ color: 'var(--err)', minWidth: 64 }}
                    >
                      <Icon icon={Unlink} size={15} />
                      <span>{t('core.acct.unlink') || '解绑'}</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="li" role="button" tabIndex={0} onClick={() => handleLink('google')} style={{ cursor: 'pointer' }}>
                  <span style={{ width: 42, height: 42, display: 'grid', placeItems: 'center', flex: 'none' }}>
                    <GoogleBrand size={42} />
                  </span>
                  <div className="t">
                    <b>{t('core.acct.connect').replace('{provider}', 'Google')}</b>
                    <span className="s">{t('core.acct.connect_sub')}</span>
                  </div>
                  <SpriteIcon id="chev" />
                </div>
              )}
            </div>
            {!canDetach('google') && (
              <p className="sub" style={{ margin: '0 6px' }}>{t('core.bind.banner')}</p>
            )}
          </>
        )}

        {/* ── Signed-in devices ────────────────────────────────────────────── */}
        {sessions.length > 0 && (
          <>
            <div className="lab">{t('core.sessions.section')}</div>
            <div className="list">
              {sessions.map((s) => {
                const dev = parseDevice(s.userAgent, t('core.sessions.unknown_device'), t('core.sessions.app'));
                return (
                  <div key={s.id} className="li">
                    <span className="ic">
                      <Icon icon={deviceIcon(dev.kind)} size={18} />
                    </span>
                    <div className="t">
                      <b>
                        {dev.label}
                        {s.sessions > 1 ? ` · ${t('core.sessions.count').replace('{n}', String(s.sessions))}` : ''}
                      </b>
                      <span className="s">
                        {t('core.sessions.last_seen').replace('{when}', formatDate(s.lastSeenAt) ?? '—')}
                      </span>
                    </div>
                    {s.current ? (
                      <span className="chip ok">{t('core.sessions.current')}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          void run(async () => {
                            await coreAuth.revokeSessions(token!, s.ids);
                            await refresh();
                          }, t('core.sessions.notice_revoked'));
                        }}
                        className="icon-del"
                        aria-label={t('btn.delete')}
                        title={t('btn.delete')}
                      >
                        <Icon icon={Trash2} size={16} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {sessions.some((s) => !s.current) && (
              <button
                type="button"
                onClick={() => {
                  void run(async () => {
                    await coreAuth.revokeOtherSessions(token!);
                    await refresh();
                  }, t('core.sessions.notice_revoked_others'));
                }}
                className="btn danger-wide"
                style={{ marginTop: 4 }}
                disabled={busy}
              >
                <Icon icon={LogOut} size={17} />
                <span>{t('core.sessions.revoke_others')}</span>
              </button>
            )}
            <p className="sub" style={{ margin: '4px 6px 0', fontSize: 12 }}>{t('core.sessions.note')}</p>
          </>
        )}

        {/* ── Delete Account ───────────────────────────────────────────────── */}
        <div className="lab" style={{ marginTop: 8, color: 'var(--err)' }}>{t('core.acct.delete_section')}</div>
        <div className="list">
          <div
            className="li danger"
            role="button"
            tabIndex={0}
            onClick={() => setDialog('delete')}
            style={{ cursor: 'pointer' }}
          >
            <span className="ic err"><Icon icon={Trash2} size={18} /></span>
            <div className="t">
              <b>{t('core.acct.delete')}</b>
              <span className="s" style={{ whiteSpace: 'normal' }}>
                {summary
                  ? t('core.acct.delete_sub')
                      .replace('{doses}', String(summary.doseCount))
                      .replace('{labs}', String(summary.labCount))
                  : t('core.acct.delete_sub_basic')}
              </span>
            </div>
            <SpriteIcon id="chev" />
          </div>
        </div>
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
        <DeleteAccountScreen
          busy={busy}
          summary={summary}
          onClose={() => { setDialog(null); setError(null); }}
          onSubmit={async (pw) => {
            await run(async () => {
              await coreAuth.deleteAccount(token!, pw);
            });
            await session.signOut().catch(() => undefined);
            onDeleted();
          }}
          describeError={describe}
        />
      )}
    </div>
  );
};

const AccountSkeleton: React.FC = () => (
  <div className="pg on long m3e-rise" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }} aria-busy="true">
    <div className="d-col" style={{ gap: 12 }}>
      {[0, 1, 2].map((row) => (
        <div key={row} className="card" style={{ height: 80, opacity: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spin" />
        </div>
      ))}
    </div>
  </div>
);

const Dialog: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  danger?: boolean;
}> = ({ title, onClose, children, danger }) => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      zIndex: 80,
      background: 'rgba(0,0,0,0.55)',
      display: 'grid',
      placeItems: 'center',
      padding: 'max(16px, env(safe-area-inset-top, 0px), var(--app-safe-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px), var(--app-safe-bottom, 0px))',
      animation: 'fadeIn .2s ease-out',
    }}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
  >
    <div
      className="card anim-in"
      style={{
        width: '100%',
        maxWidth: 440,
        background: 'var(--sc)',
        borderRadius: 28,
        padding: '24px 22px 20px',
        boxShadow: '0 12px 32px rgba(0,0,0,.35)',
      }}
    >
      <div className="hrow" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 18, color: danger ? 'var(--err)' : 'var(--on)' }}>{title}</b>
        <button
          type="button"
          onClick={onClose}
          className="btn x"
          aria-label="关闭"
          style={{ width: 36, height: 36, padding: 0, borderRadius: '50%', minWidth: 0 }}
        >
          <Icon icon={X} size={18} />
        </button>
      </div>
      {children}
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
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
    <label className="sub" style={{ margin: 0, fontSize: 12.5, fontWeight: 600 }}>{label}</label>
    <div className="fld" style={{ height: 48, borderRadius: 16, marginTop: 2 }}>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={type === 'password' ? 'off' : 'one-time-code'}
        style={{ fontSize: 15 }}
      />
    </div>
    {hint && (
      <span className="sub" style={{ margin: 0, fontSize: 11.5 }}>{hint}</span>
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
    className="btn"
    style={{
      width: '100%',
      height: 48,
      borderRadius: 24,
      background: danger ? 'var(--errc)' : undefined,
      color: danger ? 'var(--err)' : undefined,
      marginTop: 8,
      opacity: busy || disabled ? 0.45 : 1,
    }}
  >
    {busy && <Progress size={16} />}
    <span>{children}</span>
  </button>
);

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
        style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}
        onSubmit={async (e) => {
          e.preventDefault();
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
        {localError && <p className="sub" style={{ color: 'var(--err)', margin: '4px 0' }} role="alert">{localError}</p>}
        <Submit busy={busy} disabled={!current || next.length < 8}>{t('core.pw.submit')}</Submit>
      </form>
    </Dialog>
  );
};

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
      <p className="sub" style={{ margin: '0 0 14px', lineHeight: 1.5 }}>
        {handle
          ? t('core.unlink.body').replace('{handle}', `@${handle}`)
          : t('core.unlink.body_generic').replace('{provider}', name)}
      </p>
      <form
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
        {error && <p className="sub" style={{ color: 'var(--err)', margin: '4px 0' }} role="alert">{error}</p>}
        <Submit busy={busy}>{t('core.unlink.submit')}</Submit>
      </form>
    </Dialog>
  );
};

const DeleteAccountScreen: React.FC<{
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

  const ready = confirmText.trim().toUpperCase() === 'DELETE' && !!password;

  return createPortal(
    <div
      className="del-sign fixed inset-0 z-[80] overflow-y-auto bg-white text-black"
      style={{
        paddingTop: 'max(env(safe-area-inset-top, 0px), var(--app-safe-top, 0px))',
        paddingBottom: 'max(env(safe-area-inset-bottom, 0px), var(--app-safe-bottom, 0px))',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('core.del.title')}
    >
      <div className="bg-[#FFB01C] px-5 py-6 sm:px-8 sm:py-8">
        <p className="text-[clamp(1.6rem,7vw,3.25rem)] font-black uppercase leading-[0.95] tracking-[-0.02em]">
          Last chance to keep or delete
        </p>
        <p className="mt-2 text-[clamp(1rem,3.6vw,1.6rem)] font-bold leading-snug">
          保留或删除，这是您的最后机会。
        </p>
      </div>

      <div className="border-b border-black/10 px-5 py-4 sm:px-8">
        <p className="text-sm leading-relaxed sm:text-base">
          You are about to delete your cloud account.{' '}
          <span className="text-black/60">您即将删除云端账号。</span>
        </p>
      </div>

      <div className="mx-auto w-full max-w-xl px-5 py-6 sm:px-8">
        <div className="rounded-[var(--radius-sm)] border border-[#b3261e]/30 bg-[#b3261e]/5 p-3.5 text-xs leading-relaxed text-black">
          <strong>{t('core.del.warning')}</strong>
          {summary && (
            <> {t('core.del.warning_counts').replace('{doses}', String(summary.doseCount)).replace('{labs}', String(summary.labCount))}</>
          )}{' '}
          {t('core.del.warning_key')}
        </div>

        <form
          className="mt-5 space-y-4"
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
          <div>
            <label className="text-xs font-semibold uppercase text-black/70">
              {t('core.del.enter_password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded border border-black/30 bg-transparent px-3 py-2 text-sm text-black"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-semibold uppercase text-black/70">
              {t('core.del.type_delete')}
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              className="mt-1 w-full rounded border border-black/30 bg-transparent px-3 py-2 font-mono text-sm uppercase text-black placeholder:text-black/30"
            />
          </div>

          {error && <p className="text-xs text-[#b3261e]" role="alert">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded border border-black/20 py-2.5 text-sm font-medium hover:bg-black/5"
            >
              {t('btn.cancel')}
            </button>
            <button
              type="submit"
              disabled={!ready || busy}
              className="flex-1 rounded bg-[#b3261e] py-2.5 text-sm font-bold text-white hover:bg-[#8f1d17] disabled:opacity-40"
            >
              {busy ? <Progress size={16} /> : t('core.del.action')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
};

export default CoreAccountSettings;
