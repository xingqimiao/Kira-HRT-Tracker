import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { Check, Copy, Download, Loader2, ShieldCheck, AlertTriangle } from '../icons';

import TotpSecretDisplay from './TotpSecretDisplay';
import { useTranslation } from '../contexts/LanguageContext';
import type { EnrollmentMaterial } from '../services/coreAuth';

/**
 * Second-factor enrolment for password registration: show the secret, confirm a code,
 * then hand over recovery codes.
 *
 * The ordering is load-bearing, because this is the one path where a user can
 * permanently lose access to their own account:
 *
 *   1. **Scan or type the secret.** (In `TotpSecretDisplay`.)
 *   2. **Confirm a code.** Not skippable, and it is a real server round-trip: the
 *      account is only marked enrolled once a code from the new secret verifies. A
 *      QR render that silently produced a wrong secret would otherwise be discovered
 *      at the first sign-in, with no way in.
 *   3. **Recovery codes, before completing.** Shown after confirmation but before the
 *      caller navigates away, because the server stores only hashes and cannot
 *      re-issue them. Losing this screen loses them.
 *
 * For the X-setup flow — where the server takes the password and the code in a single
 * call — use `TotpSecretDisplay` directly instead. A separate confirm step here would
 * be a promise that flow cannot keep.
 */

interface TotpEnrollmentProps {
  material: EnrollmentMaterial;
  /** Called with the 6-digit code. Throwing keeps the user on this step. */
  onConfirm: (code: string) => Promise<void>;
  /** Shown once confirmed. Omit to leave the caller in control of navigation. */
  onComplete?: () => void;
  heading?: React.ReactNode;
  submitting?: boolean;
  error?: string | null;
}

const TotpEnrollment: React.FC<TotpEnrollmentProps> = ({
  material,
  onConfirm,
  onComplete,
  heading,
  submitting = false,
  error = null,
}) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Auto-submit on the sixth digit. A code is unambiguous once complete, and making
  // someone reach for a button mid-flow is the friction that gets an authenticator
  // abandoned.
  useEffect(() => {
    if (confirmed || submitting) return;
    if (!/^\d{6}$/.test(code)) return;
    void attempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function attempt() {
    if (submitting) return;
    setLocalError(null);
    try {
      await onConfirm(code);
      setConfirmed(true);
    } catch {
      // The caller owns the message; clearing the field is what lets the user retype
      // without first selecting six characters.
      setCode('');
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(material.backupCodes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // See TotpSecretDisplay: a convenience failing, not a blocker.
    }
  }

  function downloadCodes() {
    const body = [
      'Kira Tracker — recovery codes',
      '',
      'Each code works once, in place of your authenticator code.',
      'If you lose your authenticator, one of these gets you back in.',
      '',
      ...material.backupCodes,
      '',
      'Keep these somewhere other than the device holding your authenticator.',
    ].join('\n');
    const blob = new Blob([body], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hrt-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  const shownError = localError ?? error;

  return (
    <div className="space-y-5">
      {heading && (
        <div className="text-sm text-[var(--color-m3-on-surface-variant)] ">
          {heading}
        </div>
      )}

      {/* ── 1. The secret ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <StepLabel index={1} done={confirmed}>{t('core.enroll.step1')}</StepLabel>
        <TotpSecretDisplay otpauthUri={material.otpauthUri} secret={material.secret} />
      </section>

      {/* ── 2. Confirm ────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <StepLabel index={2} done={confirmed}>{t('core.enroll.step2')}</StepLabel>

        {confirmed ? (
          <p className="flex items-center gap-2 text-sm text-[var(--color-m3-primary)] ">
            <Icon icon={ShieldCheck} size={17} />
            {t('core.enroll.confirmed')}
          </p>
        ) : (
          <>
            <input
              className="input-base text-center text-lg tracking-[0.5em] font-mono"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              aria-label={t('core.err.need_code')}
              disabled={submitting}
            />
            {submitting && (
              <p className="text-xs flex items-center gap-1.5 text-[var(--color-m3-on-surface-variant)] ">
                <Icon icon={Loader2} size={13} className="animate-spin" />
                {t('core.loading')}
              </p>
            )}
            {shownError && (
              <p className="text-xs flex items-start gap-1.5 text-[#B3261E]" role="alert">
                <Icon icon={AlertTriangle} size={13} className="mt-0.5 shrink-0" />
                <span>{shownError}</span>
              </p>
            )}
          </>
        )}
      </section>

      {/* ── 3. Recovery codes, only once the factor works ─────────────────── */}
      {confirmed && (
        <section className="space-y-3">
          <StepLabel index={3} done={false}>{t('core.enroll.step3')}</StepLabel>

          <div className="callout !text-[0.75rem]">
            <strong>{t('core.enroll.step3')}</strong> {t('core.enroll.codes_once')}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.8125rem] px-3 py-3 rounded-[var(--radius-sm)] border border-[var(--color-m3-outline-variant)]  bg-[var(--color-m3-surface-container-low)] ">
            {material.backupCodes.map((c) => (
              <span key={c} className="tracking-[0.06em]">{c}</span>
            ))}
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={copyCodes} className="btn-secondary flex-1 !text-xs">
              {copied ? <Icon icon={Check} size={14} /> : <Icon icon={Copy} size={14} />}
              {copied ? t('core.copied') : t('core.copy')}
            </button>
            <button type="button" onClick={downloadCodes} className="btn-secondary flex-1 !text-xs">
              <Icon icon={Download} size={14} />
              {t('core.download')}
            </button>
          </div>

          {onComplete && (
            <button type="button" onClick={onComplete} className="btn-primary w-full">
              {t('core.enroll.have_saved')}
            </button>
          )}
        </section>
      )}
    </div>
  );
};

/** Numbered step header. The number shows where you are; a tick replaces it so
 *  progress is visible without a separate progress bar. */
const StepLabel: React.FC<{ index: number; done: boolean; children: React.ReactNode }> = ({
  index,
  done,
  children,
}) => (
  <div className="flex items-center gap-2">
    <span
      className={`grid place-items-center w-5 h-5 rounded-full text-[0.6875rem] font-semibold shrink-0 transition-colors ${
        done
          ? 'bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)]'
          : 'bg-[var(--color-m3-surface-container-high)] text-[var(--color-m3-on-surface-variant)]  '
      }`}
      style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
      aria-hidden="true"
    >
      {done ? <Icon icon={Check} size={11} strokeWidth={3} /> : index}
    </span>
    <span className="text-sm font-medium">{children}</span>
  </div>
);

export default TotpEnrollment;
