import { createPortal } from 'react-dom';
import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';

/**
 * A one-paragraph notice with an OK button — the shape most of this app's modals
 * want, so the portal/escape/presence wiring lives here instead of being copied
 * into each one.
 *
 * Nothing about it is specific to a kind of notice: the caller supplies the
 * translation keys, and `icon` is for the ones whose subject is a reaction rather
 * than a fact. `EstimateInfoModal` stays separate because it is a signed document —
 * several paragraphs and a source link — rather than a notice.
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

    useEscape(onClose, isOpen);
    const { mounted, state } = usePresence(isOpen, 200);

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
