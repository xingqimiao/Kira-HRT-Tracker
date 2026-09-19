import { createPortal } from 'react-dom';
import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';

const EstimateInfoModal = ({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) => {
    const { t } = useTranslation();

    useEscape(onClose, isOpen);

    const { mounted, state } = usePresence(isOpen, 200);

    if (!mounted) return null;

    return createPortal(
        <div className="modal-overlay z-[60]" data-state={state}>
            <div className="modal-shell">
                <div className="modal-card">
                    <h3 className="modal-title">{t('modal.estimate.title')}</h3>

                    <div className="text-sm text-muted space-y-3 mb-5 leading-relaxed">
                        <p>{t('modal.estimate.p1')}</p>
                        <p className="callout text-body font-medium">
                            {t('modal.estimate.p2')}
                        </p>
                        <p>{t('modal.estimate.p3')}</p>
                        <p className="text-xs pt-1">
                            {t('modal.estimate.source')}{' '}
                            <a
                                href="https://transfemscience.org"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--color-m3-primary)]  underline underline-offset-2"
                            >
                                transfemscience.org
                            </a>
                        </p>
                    </div>

                    <button onClick={onClose} className="btn-primary w-full">
                        {t('btn.ok')}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};

export default EstimateInfoModal;
