import React, { useEffect } from 'react';
import BloodVial from './BloodVial';
import { vialLevelForFill, type VialMode } from '../utils/vialLevel';
import { VALUE_EASE_MS } from '../utils/motion';

const TARGET_FILL = 0.98;
const HOLD_MS = 600;

interface SplashScreenProps {
    mode: VialMode;
    onDone: () => void;
}

/** Short Android launch screen: the same illustrative vial used by onboarding. */
const SplashScreen: React.FC<SplashScreenProps> = ({ mode, onDone }) => {
    // BloodVial owns the easing; passing an already eased value would animate twice.
    const level = vialLevelForFill(TARGET_FILL, mode);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            document.body.style.removeProperty('background');
            document.body.style.removeProperty('color');
            document.getElementById('root')?.style.removeProperty('background');
            document.getElementById('root')?.style.removeProperty('color');
            onDone();
        }, VALUE_EASE_MS + HOLD_MS);
        return () => window.clearTimeout(timer);
    }, [onDone]);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0D0D12]">
            <BloodVial level={level} mode={mode} size={140} force />
        </div>
    );
};

export default SplashScreen;
