import React, { useEffect, useState } from 'react';
import BloodVial from './BloodVial';
import { vialLevelForFill, type VialMode } from '../utils/vialLevel';

const TARGET_FILL = 0.98;
/**
 * How long the full tube is held before the splash leaves.
 *
 * The fill itself is driven by the vial's own clock and the hand-off waits for that to
 * *actually* finish (see `onFillDone`), so this is a deliberate beat, not a stand-in for
 * the animation's length. Without it the screen changed the instant the last pixel of
 * liquid landed, which read as the splash being cut off mid-motion.
 */
const HOLD_MS = 500;

interface SplashScreenProps {
    mode: VialMode;
    onDone: () => void;
}

/**
 * Short Android launch screen: the same illustrative vial used by onboarding.
 *
 * An overlay, not a gate — the app mounts underneath while the fill plays (see
 * App.tsx), so the reveal is instant once the fill is done. The splash does **not**
 * fade itself out: the hand-over is the app fading in (App wraps its content in a
 * fade-in keyed on `splashDone`), and a splash that also dimmed would cross-fade two
 * things at once and read as the vial ghosting away. So this stays fully opaque until
 * the hold ends, then unmounts in one frame.
 *
 * The wait is measured from the fill completing, not from mount: on a cold launch the
 * main thread is busy mounting the app underneath, the fill's rAF ticks are starved,
 * and a fixed timer would fire while the liquid was still short of its mark. Letting the
 * animation report its own finish is what makes "wait for it to play" actually true.
 */
const SplashScreen: React.FC<SplashScreenProps> = ({ mode, onDone }) => {
    // BloodVial owns the easing; passing an already eased value would animate twice.
    const level = vialLevelForFill(TARGET_FILL, mode);
    const [fillDone, setFillDone] = useState(false);
    const handleFillDone = React.useCallback(() => setFillDone(true), []);

    useEffect(() => {
        if (!fillDone) return;
        const timer = window.setTimeout(onDone, HOLD_MS);
        return () => window.clearTimeout(timer);
    }, [fillDone, onDone]);

    // The overlay must be the app's own surface, not a fixed dark colour: on a light
    // theme a hardcoded #0D0D12 painted a black panel over the already-light page, so a
    // light-mode launch read as black (native window) -> white (html paint) -> black
    // (this overlay) -> animation. The vial art and the surface both follow the theme
    // class the inline <head> script sets before first paint, so `var(--color-m3-surface)`
    // is correct here and keeps the dark case byte-identical.
    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center"
            style={{ backgroundColor: 'var(--color-m3-surface)' }}
        >
            <BloodVial level={level} mode={mode} size={140} onFillDone={handleFillDone} />
        </div>
    );
};

export default SplashScreen;
