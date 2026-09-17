import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAppSettingsApplied } from '../utils/appSettings';

/**
 * Whether the blood vial is drawn.
 *
 * One preference, one key. The vial is decorative — it says nothing the readings
 * above it do not already say in numbers — so "off" has to be a first-class choice
 * rather than something you turn off by hiding the element in CSS.
 *
 * The class, the storage key and the file name are all about the vial now; the
 * cat this replaced is gone. An older `app-pixel-cats` value is deliberately not
 * read: it controlled a different drawing, and honouring it would show the vial to
 * someone who had turned the cat off.
 */
interface VialContextValue {
    showVial: boolean;
    setShowVial: (v: boolean) => void;
}

const VialContext = createContext<VialContextValue | null>(null);

export const useVial = (): VialContextValue => {
    const ctx = useContext(VialContext);
    if (!ctx) throw new Error('useVial must be used within VialProvider');
    return ctx;
};

const SHOW_KEY = 'app-blood-vial';

export const VialProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // On by default — opting out is the deliberate act.
    const [showVial, setShowVial] = useState<boolean>(
        () => localStorage.getItem(SHOW_KEY) !== 'false',
    );

    // A sync can adopt this preference from the account. Without this the key
    // would be updated under us and the toggle stay on screen as it was.
    useEffect(() => onAppSettingsApplied(() => {
        setShowVial(localStorage.getItem(SHOW_KEY) !== 'false');
    }), []);

    useEffect(() => {
        localStorage.setItem(SHOW_KEY, String(showVial));
    }, [showVial]);

    return (
        <VialContext.Provider value={{ showVial, setShowVial }}>
            {children}
        </VialContext.Provider>
    );
};
