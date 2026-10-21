import { createPortal } from 'react-dom';
import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';
import { AdaptiveSheet, useMediaQuery } from '../ui/proto';

/**
 * A one-paragraph notice with an OK button.
 *
 * On a phone this is a bottom sheet, not a centred dialog: the notice is a short
 * acknowledgement, and the thumb already lives at the bottom of the screen. The
 * desktop card is unchanged.
 */
const NoticeModal = ({ isOpen, onClose, titleKey, bodyKey, icon }: {
    isOpen: boolean;
    onClose: () => void;
    titleKey: string;
    bodyKey: string;
    /** Sits above the title when the notice reads as an aside, not a declaration. */
    icon?: React.ReactNode;
}) => {
    const { t } = useTranslation();
    const desktop = useMediaQuery('(min-width: 760px)');

    useEscape(onClose, isOpen);
    const { mounted, state } = usePresence(isOpen, 200);

    const body = (
        <div className="d-col" style={{ gap: 14 }}>
            {icon && <div style={{ display: 'flex', justifyContent: 'center' }}>{icon}</div>}
            <b style={{ fontSize: 20, fontWeight: 800 }}>{t(titleKey)}</b>
            <p className="sub" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>{t(bodyKey)}</p>
            <button type="button" onClick={onClose} className="btn" style={{ width: '100%', height: 50 }}>
                {t('btn.ok')}
            </button>
        </div>
    );

    if (!desktop) {
        return (
            <AdaptiveSheet
                open={isOpen}
                onClose={onClose}
                bare
                closeLabel={t('btn.ok')}
            >
                {body}
            </AdaptiveSheet>
        );
    }

    if (!mounted) return null;

    return createPortal(
        <div className="modal-overlay z-[60]" data-state={state}>
            <div className="modal-shell">
                <div className="modal-card">
                    {icon && <div className="flex justify-center mb-3">{icon}</div>}
                    <h3 className="modal-title">{t(titleKey)}</h3>
                    <div className="text-sm text-muted space-y-3 mb-5 leading-relaxed">
                        <p>{t(bodyKey)}</p>
                    </div>
                    <button onClick={onClose} className="btn-primary w-full">
                        {t('btn.ok')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default NoticeModal;
