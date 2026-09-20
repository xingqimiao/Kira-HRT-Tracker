import React, { useEffect, useRef } from 'react';

/**
 * Cloudflare Turnstile, rendered explicitly.
 *
 * Explicit (`turnstile.render()`) rather than the implicit `.cf-turnstile` scan,
 * because this form is React-controlled and re-mounts on every screen change: the
 * implicit scan runs once on script load and would leave the second and later
 * renders with an empty box.
 *
 * Two states the server also knows about, kept deliberately symmetric:
 *
 *   - **No site key** → nothing renders and `onToken('')` fires once, so a local
 *     instance without Turnstile still submits. The server skips verification when
 *     it has no secret, so both ends opt out together rather than one blocking the
 *     other.
 *   - **Configured** → the widget reports a token on solve and an empty string on
 *     expiry, and a submitted form without a token is refused by the server.
 *
 * The site key is public by design (it ships in the page), so it is a default here
 * and only overridable for a different Cloudflare account.
 */

const SITE_KEY =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_TURNSTILE_SITE_KEY) ?? '0x4AAAAAAE7AY8cxIQH4Q71c';

/**
 * Whether this deployment asks for human verification at all.
 *
 * The form needs this to tell "no challenge to solve" apart from "a challenge was
 * shown and is not solved yet": both report an empty token, and gating on the token
 * alone would disable every submit button on a self-hosted instance that has no
 * widget. Exported rather than passed down because it is a build-time constant, not
 * state.
 */
export const TURNSTILE_CONFIGURED = Boolean(SITE_KEY);

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
      theme?: 'auto' | 'light' | 'dark';
      callback?: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
    },
  ) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * The height the widget takes once Cloudflare has rendered it.
 *
 * Measured through Playwright against a `vite preview` build, from 320px to 1280px
 * wide: the managed widget's box is a fixed 300x71 in every case, before and after the
 * token solves. Reserved on the container so the form is already its final height
 * before the third-party script arrives, instead of growing by 71px when it does.
 * `min-height` rather than `height` so a future widget taller than this is not clipped.
 */
const WIDGET_BOX_HEIGHT = 71;

interface Props {
    /** The action the token is minted for; the server checks it matches. */
    action: 'register' | 'oauth';
    /** Called with the token, or '' when it expires or the widget fails. */
    onToken: (token: string) => void;
    /**
     * Change this to force a fresh challenge. A solved token is single use, so after
     * a rejected submit the widget must be reset or every retry fails.
     */
    resetSignal?: number;
}

const TurnstileWidget: React.FC<Props> = ({ action, onToken, resetSignal = 0 }) => {
    const box = useRef<HTMLDivElement>(null);
    const widgetId = useRef<string | null>(null);
    const onTokenRef = useRef(onToken);
    onTokenRef.current = onToken;

    useEffect(() => {
        if (!SITE_KEY) {
            // Unconfigured: report "no token required" once and render nothing.
            onTokenRef.current('');
            return;
        }

        let cancelled = false;
        let poll: number | undefined;

        const mount = () => {
            if (cancelled || !box.current || widgetId.current) return;
            const api = window.turnstile;
            if (!api) {
                // The script is `async defer`, so it may not be ready on first paint.
                poll = window.setTimeout(mount, 150);
                return;
            }
            box.current.innerHTML = '';
            widgetId.current = api.render(box.current, {
                sitekey: SITE_KEY,
                action,
                theme: 'auto',
                callback: (token: string) => onTokenRef.current(token),
                'error-callback': () => onTokenRef.current(''),
                'expired-callback': () => onTokenRef.current(''),
            });
        };

        mount();
        return () => {
            cancelled = true;
            if (poll) window.clearTimeout(poll);
            if (widgetId.current && window.turnstile) {
                try {
                    window.turnstile.remove(widgetId.current);
                } catch {
                    // Already gone; nothing to clean up.
                }
                widgetId.current = null;
            }
        };
    }, [action]);

    // Reset on demand — a spent token cannot be resubmitted.
    useEffect(() => {
        if (resetSignal > 0 && widgetId.current && window.turnstile) {
            try {
                window.turnstile.reset(widgetId.current);
            } catch {
                // Widget not rendered yet; the next mount will produce a fresh token.
            }
            onTokenRef.current('');
        }
    }, [resetSignal]);

    if (!SITE_KEY) return null;
    return (
        <div
            ref={box}
            className="flex justify-center"
            style={{ minHeight: WIDGET_BOX_HEIGHT }}
        />
    );
};

export default TurnstileWidget;
