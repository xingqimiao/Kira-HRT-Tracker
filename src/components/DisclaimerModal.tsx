import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';

const DisclaimerModal = ({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) => {
    const { t } = useTranslation();

    useEscape(onClose, isOpen);

    const { mounted, state } = usePresence(isOpen, 200);

    if (!mounted) return null;

    return (
        <div className="modal-overlay z-[60]" data-state={state}>
            <div className="modal-shell">
                <div className="modal-card">
                    <h3 className="modal-title">{t('disclaimer.title')}</h3>

                    <div className="text-sm text-muted space-y-2 mb-5 leading-relaxed">
                        <p>{t('disclaimer.text.intro')}</p>
                        <ul className="list-disc pl-5 space-y-2">
                            <li>{t('disclaimer.text.point1')}</li>
                            <li>{t('disclaimer.text.point2')}</li>
                            <li>{t('disclaimer.text.point3')}</li>
                        </ul>
                    </div>

                    <button onClick={onClose} className="btn-primary w-full">
                        {t('btn.ok')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DisclaimerModal;
