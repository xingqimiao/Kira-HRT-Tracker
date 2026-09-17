import React, { useMemo, useState } from 'react';
import Icon from './Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Eye, EyeOff } from '../icons';

/**
 * The secret half of authenticator enrolment: a QR code plus the key in text.
 *
 * Extracted so the two enrolment flows can share it while differing where they must:
 *
 *   - **Password registration** — the server has issued an enrolment token and can
 *     verify a code immediately, so a code field goes below this and confirming is
 *     its own step.
 *   - **X setup** — the server takes the password *and* the code in one call, so the
 *     code field belongs to a combined form, and a separate "confirm" step would be a
 *     promise the flow cannot keep.
 *
 * Both need the same thing at the top, and the details here are the ones that
 * actually decide whether someone succeeds:
 *
 *   - The QR must be on a **white plate in both themes**. A dark-mode inverted QR is
 *     unscannable by a number of authenticator apps, and this is not a place to
 *     discover that.
 *   - The key must be readable as text. "Scan the code" assumes the authenticator is
 *     on a different device than the screen; when someone is on a laptop with the app
 *     on that same phone, typing the key is the only route.
 *   - The key is **grouped in fours** and copyable, because it is read aloud and
 *     typed by hand.
 */

interface TotpSecretDisplayProps {
  /** The `otpauth://` URI, for the QR. */
  otpauthUri: string;
  /** The base32 secret, for the text fallback and the copy button. */
  secret: string;
  /** Start with the key hidden, so a shoulder-surfer cannot read it off the screen. */
  hiddenByDefault?: boolean;
}

/** Group base32 in fours. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

const TotpSecretDisplay: React.FC<TotpSecretDisplayProps> = ({
  otpauthUri,
  secret,
  hiddenByDefault = true,
}) => {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(!hiddenByDefault);
  const [copied, setCopied] = useState(false);
  const grouped = useMemo(() => groupSecret(secret), [secret]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable over plain http and in some webviews. The key is
      // visible on screen, so this failing is an inconvenience, not a blocker.
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col items-center gap-2">
        {/*
          A literal white plate, not a theme surface. The quiet zone is now carried by
          the code itself (see `marginSize`), so scanning does not depend on this
          element — but the plate must still be white for the same reason, since an
          inverted or dark-backed QR is unscannable by a number of authenticator apps.

          This previously used `bg-cos-surface-container`, a token that was never
          defined anywhere in the stylesheet, so the plate was **transparent**: in dark
          mode the black modules sat directly on near-black and the code could not be
          located at all, while light mode worked by luck because the page behind
          happened to be near-white.
        */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-m3-outline-variant)] bg-white p-3 shadow-[var(--shadow-m3-1)]">
          <QRCodeSVG
            value={otpauthUri}
            size={190}
            level="M"
            /*
              The spec's four-module quiet zone, drawn in the QR's own background
              colour. Set here rather than left to the plate's padding, because a quiet
              zone that is merely "whatever is behind the code" is exactly what failed:
              on a dark surface the finder patterns had nothing light to stand against.
              Four modules of white now travel with the code in every theme, whatever
              the plate is changed to later.
            */
            marginSize={4}
            bgColor="#FFFFFF"
            fgColor="#000000"
          />
        </div>
        <p className="text-xs text-center text-[var(--color-m3-on-surface-variant)] ">
          {t('core.secret.scan')}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
          {t('core.secret.or_manual')}
        </p>
        <div className="flex items-stretch gap-2">
          <div className="flex-1 min-w-0 font-mono text-[0.8125rem] tracking-[0.08em] px-3 py-2.5 rounded-[var(--radius-sm)] border border-[var(--color-m3-outline-variant)]  bg-[var(--color-m3-surface-container-low)]  break-all">
            {revealed ? grouped : '•••• •••• •••• •••• •••• •••• ••••'}
          </div>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 px-3 rounded-[var(--radius-sm)] border border-[var(--color-m3-outline-variant)]  hover:bg-[var(--color-m3-surface-container)]  transition-colors"
            style={{ transitionDuration: 'var(--md-sys-motion-duration-short3)' }}
            aria-label={t('core.secret.copy_aria')}
          >
            {copied ? <Icon icon={Check} size={16} /> : <Icon icon={Copy} size={16} />}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setRevealed(v => !v)}
          className="text-xs inline-flex items-center gap-1 text-[var(--color-m3-on-surface-variant)]  hover:underline"
          aria-pressed={revealed}
        >
          {revealed ? <Icon icon={EyeOff} size={13} /> : <Icon icon={Eye} size={13} />}
          {revealed ? t('core.secret.hide') : t('core.secret.show')}
        </button>
      </div>
    </div>
  );
};

export default TotpSecretDisplay;
