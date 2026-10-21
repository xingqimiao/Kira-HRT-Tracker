import React, { useEffect, useState } from 'react';
import { clockLocale } from '../utils/lockCopy';
import { setSecureScreen } from '../utils/appLock';

interface AppClockScreenProps {
    /** Try the biometric prompt again (a tap anywhere on the clock). */
    onRetry: () => void;
}

/**
 * The disguise shown after a lockout (docs/android-app-lock-plan.md §6.1).
 *
 * Deliberately indistinguishable from a clock: no logo, no app name, no buttons,
 * no records. It reuses the app's own type and colour tokens so it belongs to the
 * same design language without identifying the app. It is not a security boundary
 * — the record key is; without a successful prompt there is nothing to show.
 *
 * Reopening the app re-runs the biometric prompt. The clock stays up until one
 * succeeds, and back exits the activity (the native back callback is disabled).
 */
const AppClockScreen: React.FC<AppClockScreenProps> = ({ onRetry }) => {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        // Read the system clock on every tick instead of owning an offset, so a
        // time-zone or manual change is reflected immediately.
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        setSecureScreen(true);
        (window as unknown as { HrtBack?: { setCanPop: (v: boolean) => void } }).HrtBack?.setCanPop(false);
    }, []);

    const locale = clockLocale();
    const parts = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(now);
    const time = parts({ hour: '2-digit', minute: '2-digit' });
    const seconds = parts({ second: '2-digit' });
    const date = parts({ month: 'long', day: 'numeric', weekday: 'long' });

    return (
        <div
            className="fixed inset-0 z-[200] flex flex-col items-center justify-center select-none"
            style={{
                backgroundColor: 'var(--color-m3-surface)',
                color: 'var(--color-m3-on-surface)',
                paddingTop: 'max(24px, var(--app-safe-top, 0px))',
                paddingBottom: 'max(24px, var(--app-safe-bottom, 0px))',
                // A soft tonal wash so the field does not read as a flat sheet.
                backgroundImage:
                    'radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--color-m3-surface-container) 45%, transparent), transparent 62%)',
            }}
            onClick={onRetry}
        >
            <div className="flex items-baseline" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <span
                    style={{
                        fontFamily: 'var(--font-display, var(--font-sans))',
                        fontSize: 'clamp(76px, 24vw, 104px)',
                        fontWeight: 800,
                        letterSpacing: '-3px',
                        lineHeight: 0.95,
                    }}
                >
                    {time}
                </span>
                <span
                    className="ml-2"
                    style={{
                        fontSize: 24,
                        fontWeight: 700,
                        color: 'var(--color-m3-on-surface-variant)',
                        fontVariantNumeric: 'tabular-nums',
                        transition: 'opacity 120ms linear',
                    }}
                >
                    {seconds}
                </span>
            </div>

            <div
                className="my-6"
                style={{
                    width: 56,
                    height: 1,
                    borderRadius: 1,
                    backgroundColor: 'color-mix(in srgb, var(--color-m3-outline) 25%, transparent)',
                }}
                aria-hidden="true"
            />

            <p
                style={{
                    fontSize: 15,
                    fontWeight: 600,
                    letterSpacing: '0.5px',
                    color: 'var(--color-m3-on-surface-variant)',
                }}
            >
                {date}
            </p>
        </div>
    );
};

export default AppClockScreen;
