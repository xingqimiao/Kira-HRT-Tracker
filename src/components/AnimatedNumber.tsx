import React from 'react';
import { VALUE_EASE_MS, useEasedValue } from '../utils/motion';

interface AnimatedNumberProps {
    value: number;
    decimals?: number;
    duration?: number;
}

/**
 * A number that glides to its value.
 *
 * The motion lives in `utils/motion.ts` rather than here, shared with anything else
 * showing the same reading. That is not tidiness: the blood vial beside this number
 * animated on its own terms — a jump after its own delay — so on first load the number
 * counted up while the vial was already full, and on every change they arrived at
 * different moments. One value, visibly disagreeing with itself. Counting up from zero on
 * mount is part of the shared behaviour now.
 */
const AnimatedNumber: React.FC<AnimatedNumberProps> = ({ value, decimals = 1, duration = VALUE_EASE_MS }) => {
    const display = useEasedValue(value, { duration });
    return <>{display.toFixed(decimals)}</>;
};

export default AnimatedNumber;
