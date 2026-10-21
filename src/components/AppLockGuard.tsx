import React, { useEffect, useState } from 'react';
import AppUnlockScreen from './AppUnlockScreen';
import AppClockScreen from './AppClockScreen';
import { initSecureStoreWithKey, isSecureStoreReady } from '../utils/secureStore';
import { isAppLockEnabled, onLockState } from '../utils/appLock';

/**
 * Native background re-lock, drawn over the running app.
 *
 * The App stays mounted — its data, OCR state, scroll positions and unsaved
 * forms all survive — because the key is already in memory for this process
 * (docs/android-app-lock-plan.md §5.1). This only covers the UI until the
 * biometric prompt succeeds; a lockout swaps in the clock, and tapping the
 * clock offers the prompt again.
 *
 * Cold start does not use this component: there the App is mounted only after a
 * successful unlock (index.tsx).
 */
const AppLockGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [phase, setPhase] = useState<'none' | 'unlock' | 'clock'>('none');

    useEffect(() => {
        // Subscribe unconditionally: the switch can be turned on after this guard
        // mounted (Settings → App lock), and a subscription created only when the
        // lock was already enabled would not start working until the next launch.
        return onLockState(() => {
            if (isAppLockEnabled()) setPhase('unlock');
        });
    }, []);

    const unlocked = async (key: string) => {
        // Normally the store is already hydrated; the guard against a WebView that
        // was recreated while the app sat in the background costs one check.
        if (!isSecureStoreReady()) await initSecureStoreWithKey(key);
        setPhase('none');
    };

    return (
        <>
            {children}
            {phase === 'unlock' ? (
                <AppUnlockScreen
                    overlay
                    onUnlocked={key => void unlocked(key)}
                    onLockout={() => setPhase('clock')}
                />
            ) : null}
            {phase === 'clock' ? (
                <AppClockScreen onRetry={() => setPhase('unlock')} />
            ) : null}
        </>
    );
};

export default AppLockGuard;
