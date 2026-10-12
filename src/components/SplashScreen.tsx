import React, { useEffect, useState } from 'react';
import BloodVial from './BloodVial';
import { vialLevelForFill, type VialMode } from '../utils/vialLevel';
import { VALUE_EASE_MS } from '../utils/motion';

const TARGET_FILL = 0.98;
/** How long the splash fades into the live UI before it unmounts. */
const FADE_MS = 320;

interface SplashScreenProps {
    mode: VialMode;
    onDone: () => void;
}

/**
 * Short Android launch screen: the same illustrative vial used by onboarding.
 *
 * An overlay, not a gate — the app mounts underneath while the fill plays (see
 * App.tsx), so the fill reaching its mark is the moment to hand over. No hold after
 * the animation: the hold existed when the splash gated the app, and a pause on an
 * already-live screen reads as lag.
 *
 * The hand-over is a cross-fade, not a cut: the fill finishes and the splash fades
 * out over `FADE_MS`, revealing the UI that has been laying itself out underneath.
 * Unmounting the instant the fill completed was an abrupt cut from a full-screen
 * black panel to the app — the two shared no frame, so it read as a flash. Pointer
 * events are dropped the moment the fade starts, so the app is interactive
 * immediately and a tap during the fade reaches it, not the vanishing overlay.
 */
const SplashScreen: React.FC<SplashScreenProps> = ({ mode, onDone }) => {
    const [leaving, setLeaving] = useState(false);
    // BloodVial owns the easing; passing an already eased value would animate twice.
    const level = vialLevelForFill(TARGET_FILL, mode);

    useEffect(() => {
        const fillTimer = window.setTimeout(() => {
            document.body.style.removeProperty('background');
            document.body.style.removeProperty('color');
            document.getElementById('root')?.style.removeProperty('background');
            document.getElementById('root')?.style.removeProperty('color');
            setLeaving(true);
        }, VALUE_EASE_MS);
        return () => window.clearTimeout(fillTimer);
    }, []);

    useEffect(() => {
        if (!leaving) return;
        const fadeTimer = window.setTimeout(onDone, FADE_MS);
        return () => window.clearTimeout(fadeTimer);
    }, [leaving, onDone]);

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0D0D12]"
            style={{
                opacity: leaving ? 0 : 1,
                pointerEvents: leaving ? 'none' : undefined,
                transition: `opacity ${FADE_MS}ms var(--md-sys-motion-easing-emphasized-decelerate, cubic-bezier(0.2,0,0,1))`,
            }}
        >
            <BloodVial level={level} mode={mode} size={140} force />
        </div>
    );
};

export default SplashScreen;
