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

interface Props {
    /** The action the token is minted for; the server checks it matches. */
    action: 'register' | 'x_setup';
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
    return <div ref={box} className="flex justify-center" />;
};

export default TurnstileWidget;
