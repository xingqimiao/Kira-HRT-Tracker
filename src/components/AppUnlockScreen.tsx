import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { Fingerprint, Lock, RotateCcw } from '../icons';
import { AdaptiveSheet } from '../ui/proto';
import { lockCopy } from '../utils/lockCopy';
import {
    authenticateLock,
    openBiometricEnrollment,
    resetLockStorage,
    setSecureScreen,
} from '../utils/appLock';
import { suspendBack } from '../utils/nativeBack';
import { removeDataKeyBase64 } from '../utils/secureStore';

interface AppUnlockScreenProps {
    /** A successful biometric prompt handed back the record key. */
    onUnlocked: (key: string) => void;
    /** System lockout (or the local backstop) — the caller shows the clock. */
    onLockout: () => void;
    /**
     * Start the prompt on mount. False for the background re-lock overlay, where
     * the App's own animation is playing and a prompt on top of it would be
     * surprising; the overlay is opened by an explicit tap instead.
     */
    autoStart?: boolean;
    /** The clock is not showing, so a successful unlock only has to hide this. */
    overlay?: boolean;
}

/**
 * The cold-start unlock surface (docs/android-app-lock-plan.md §6).
 *
 * Renders no record data and no navigation: the App is not mounted behind it.
 * The reset path is the last row on the screen, and only opens a sheet — the
 * wipe itself needs a second, explicit press.
 */
const AppUnlockScreen: React.FC<AppUnlockScreenProps> = ({ onUnlocked, onLockout, autoStart = true, overlay = false }) => {
    const copy = lockCopy();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const started = useRef(false);

    const runAuth = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const result = await authenticateLock(copy.title, copy.retry);
        setBusy(false);
        if (result.ok && result.key) {
            setSecureScreen(false);
            onUnlocked(result.key);
            return;
        }
        if (result.error === 'lockout') {
            onLockout();
            return;
        }
        if (result.error === 'invalidated') {
            // The key is gone for good: a new fingerprint invalidated it. Say so, and
            // open the one path that works — reset the lock and sign in again, which
            // restores everything the cloud copy holds.
            setError(copy.invalidated);
            setSheetOpen(true);
            return;
        }
        if (result.error !== 'cancelled') setError(copy.failed);
    };

    useEffect(() => {
        setSecureScreen(true);
        // Back exits while this surface owns the screen — the app is still mounted
        // behind it and must not unwind invisibly. The reset sheet inside is
        // dismissed by its own buttons.
        suspendBack(true);
        return () => suspendBack(false);
    }, []);

    useEffect(() => {
        if (!autoStart || started.current) return;
        started.current = true;
        // A tick after paint: the native prompt is a window of its own, and
        // presenting it before this surface exists leaves a blank frame behind it.
        const timer = window.setTimeout(() => void runAuth(), 220);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const wipe = async () => {
        resetLockStorage();
        try {
            await removeDataKeyBase64();
        } catch {
            // The keystore entry is already gone; the plugin copy is best-effort.
        }
        localStorage.clear();
        // The reload keeps the native window's FLAG_SECURE unless it is cleared
        // here; after a reset there is no locked screen left to protect.
        setSecureScreen(false);
        window.location.reload();
    };

    return (
        <>
            <div
                className="fixed inset-0 z-[200] flex flex-col items-center justify-center px-6"
                style={{
                    backgroundColor: 'var(--color-m3-surface)',
                    color: 'var(--color-m3-on-surface)',
                    paddingTop: 'max(24px, var(--app-safe-top, 0px))',
                    paddingBottom: 'max(24px, var(--app-safe-bottom, 0px))',
                }}
                role="dialog"
                aria-modal="true"
                aria-label={copy.title}
            >
                <div
                    className="flex h-20 w-20 items-center justify-center rounded-full"
                    style={{ backgroundColor: 'var(--color-m3-primary-container)', color: 'var(--color-m3-on-primary-container)' }}
                >
                    {overlay ? <Icon icon={Lock} size={34} /> : <Icon icon={Fingerprint} size={36} />}
                </div>
                <h1 className="mt-6 text-[22px] font-extrabold tracking-[-0.3px]">{copy.title}</h1>
                <p className="mt-2 text-center text-sm" style={{ color: 'var(--color-m3-on-surface-variant)' }}>
                    {copy.hint}
                </p>
                {error ? (
                    <p className="mt-4 text-center text-sm font-semibold" style={{ color: 'var(--color-m3-error)' }} role="alert">
                        {error}
                    </p>
                ) : null}
                <button type="button" className="btn mt-7 min-w-[140px]" onClick={() => void runAuth()} disabled={busy}>
                    <Icon icon={Fingerprint} size={18} />
                    {copy.retry}
                </button>

                <div className="absolute inset-x-0" style={{ bottom: 'max(16px, var(--app-safe-bottom, 0px))' }}>
                    <div className="mx-auto w-full max-w-md px-4">
                        <button type="button" className="btn danger-wide" aria-label={copy.reset} onClick={() => setSheetOpen(true)}>
                            <Icon icon={RotateCcw} size={22} />
                            {copy.reset}
                        </button>
                    </div>
                </div>
            </div>

            <AdaptiveSheet open={sheetOpen} onClose={() => { setSheetOpen(false); setConfirming(false); }} title={copy.resetTitle} closeLabel={copy.retry} zIndex={240}>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--color-m3-on-surface-variant)' }}>
                    {copy.resetDesc}
                </p>
                <button
                    type="button"
                    className="btn t mt-4 w-full"
                    onClick={() => {
                        openBiometricEnrollment();
                        setSheetOpen(false);
                    }}
                >
                    {copy.reEnroll}
                </button>
                <button
                    type="button"
                    className="btn danger-wide mt-3"
                    onClick={() => {
                        if (!confirming) {
                            setConfirming(true);
                            return;
                        }
                        void wipe();
                    }}
                >
                    <Icon icon={RotateCcw} size={22} />
                    {confirming ? copy.confirm : copy.wipe}
                </button>
                {confirming ? (
                    <p className="mt-3 text-sm font-semibold" style={{ color: 'var(--color-m3-error)' }}>
                        {copy.confirmDesc}
                    </p>
                ) : null}
            </AdaptiveSheet>
        </>
    );
};

export default AppUnlockScreen;
