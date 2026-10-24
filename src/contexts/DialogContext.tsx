import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { useTranslation } from './LanguageContext';
import { AdaptiveSheet } from '../ui/proto';

type DialogType = 'alert' | 'confirm';

interface DialogContextType {
    showDialog: (type: DialogType, message: string, onConfirm?: () => void) => void;
}

const DialogContext = createContext<DialogContextType | null>(null);

export const useDialog = () => {
    const ctx = useContext(DialogContext);
    if (!ctx) throw new Error("useDialog must be used within DialogProvider");
    return ctx;
};

/**
 * The app's one alert/confirm window.
 *
 * Built on `AdaptiveSheet`, so it is the same surface as every other transient
 * panel: a bottom sheet on a phone, a 460px centred dialog on a wide window, with
 * the prototype's 32px corners, the drag handle, and the `.btn` pair. It used to
 * carry its own `modal-overlay`/`modal-card` shell and its own two button classes,
 * which is why a confirmation opened from an M3E page looked like it came from the
 * previous build.
 *
 * `message` is plain text and keeps its line breaks: the update prompt passes a
 * changelog with `\n\n` between the sentence and the bullet list.
 */
export const DialogProvider = ({ children }: { children: React.ReactNode }) => {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const [type, setType] = useState<DialogType>('alert');
    const [message, setMessage] = useState("");
    const [onConfirm, setOnConfirm] = useState<(() => void) | null>(null);

    const showDialog = useCallback((type: DialogType, message: string, onConfirm?: () => void) => {
        setType(type);
        setMessage(message);
        setOnConfirm(() => onConfirm || null);
        setIsOpen(true);
    }, []);

    // Stable reference so opening/closing the dialog doesn't re-render every
    // consumer of useDialog() across the app (showDialog itself never changes).
    const contextValue = useMemo(() => ({ showDialog }), [showDialog]);

    // System back dismisses the dialog instead of leaving the page beneath it.
    // `AdaptiveSheet` registers that itself from its `open` prop; doing it here
    // too put two handlers on one gesture.

    const handleConfirm = () => {
        // Close first. A callback that opens its own dialog (a confirm whose action
        // reports a failure, say) would otherwise be undone by the `setIsOpen(false)`
        // that followed it: both updates batch, and the new dialog closes with the old
        // one — which is what made "确定" on the update check look like a dead button.
        setIsOpen(false);
        if (onConfirm) onConfirm();
    };

    return (
        <DialogContext.Provider value={contextValue}>
            {children}
            <AdaptiveSheet
                open={isOpen}
                onClose={() => setIsOpen(false)}
                title={type === 'confirm' ? t('dialog.confirm_title') : t('dialog.alert_title')}
                closeLabel={t('btn.cancel')}
                footer={
                    <div className="hrow" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        {type === 'confirm' && (
                            <button type="button" onClick={() => setIsOpen(false)} className="btn x">
                                {t('btn.cancel')}
                            </button>
                        )}
                        <button type="button" onClick={handleConfirm} className="btn" style={{ minWidth: 104 }}>
                            {t('btn.ok')}
                        </button>
                    </div>
                }
            >
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: 'var(--var)', whiteSpace: 'pre-line' }}>
                    {message}
                </p>
            </AdaptiveSheet>
        </DialogContext.Provider>
    );
};
