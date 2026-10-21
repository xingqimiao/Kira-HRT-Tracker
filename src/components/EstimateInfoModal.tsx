import { createPortal } from 'react-dom';
import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';
import { AdaptiveSheet, useMediaQuery } from '../ui/proto';

/**
 * "重要提示" — the estimate disclaimer.
 *
 * Phone: a bottom sheet that sizes to the copy, so a short notice is not a
 * half-screen empty dialog. Desktop keeps the centred document, where the extra
 * width makes the paragraphs easier to read.
 */
const EstimateInfoModal = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
    const { t } = useTranslation();
    const desktop = useMediaQuery('(min-width: 760px)');

    useEscape(onClose, isOpen);
    const { mounted, state } = usePresence(isOpen, 200);

    const body = (
        <div className="d-col" style={{ gap: 14 }}>
            <b style={{ fontSize: 20, fontWeight: 800 }}>{t('modal.estimate.title')}</b>
            <div className="sub" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
                <p style={{ margin: 0 }}>{t('modal.estimate.p1')}</p>
                <p style={{ margin: '12px 0 0', color: 'var(--on)', fontWeight: 600 }}>{t('modal.estimate.p2')}</p>
                <p style={{ margin: '12px 0 0' }}>{t('modal.estimate.p3')}</p>
                <p style={{ margin: '12px 0 0', fontSize: 12 }}>
                    {t('modal.estimate.source')}{' '}
                    <a
                        href="https://transfemscience.org"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--pri)', textDecoration: 'underline', textUnderlineOffset: 2 }}
                    >
                        transfemscience.org
                    </a>
                </p>
            </div>
            <button type="button" onClick={onClose} className="btn" style={{ width: '100%', height: 50 }}>
                {t('btn.ok')}
            </button>
        </div>
    );

    if (!desktop) {
        return (
            <AdaptiveSheet open={isOpen} onClose={onClose} bare closeLabel={t('btn.ok')}>
                {body}
            </AdaptiveSheet>
        );
    }

    if (!mounted) return null;

    return createPortal(
        <div className="modal-overlay z-[60]" data-state={state}>
            <div className="modal-shell">
                <div className="modal-card">
                    <h3 className="modal-title">{t('modal.estimate.title')}</h3>

                    <div className="text-sm text-muted space-y-3 mb-5 leading-relaxed">
                        <p>{t('modal.estimate.p1')}</p>
                        <p className="callout text-body font-medium">{t('modal.estimate.p2')}</p>
                        <p>{t('modal.estimate.p3')}</p>
                        <p className="text-xs pt-1">
                            {t('modal.estimate.source')}{' '}
                            <a
                                href="https://transfemscience.org"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--color-m3-primary)] underline underline-offset-2"
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
        document.body,
    );
};

export default EstimateInfoModal;
