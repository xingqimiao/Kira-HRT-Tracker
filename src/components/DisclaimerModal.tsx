import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';
import { AdaptiveSheet, useMediaQuery } from '../ui/proto';

/**
 * One-paragraph legal notice with a single acknowledgement.
 *
 * A phone gets a bottom sheet: a centred desktop dialog for one sentence plus OK
 * is more chrome than content, and it is harder to reach. Wide windows keep the
 * centred card because there is no bottom edge to slide from.
 */
const DisclaimerModal = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
    const { t } = useTranslation();
    const desktop = useMediaQuery('(min-width: 760px)');

    useEscape(onClose, isOpen);
    const { mounted, state } = usePresence(isOpen, 200);

    const body = (
        <div className="d-col" style={{ gap: 14 }}>
            <b style={{ fontSize: 20, fontWeight: 800 }}>{t('disclaimer.title')}</b>
            <div className="sub" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
                <p>{t('disclaimer.text.intro')}</p>
                <ul style={{ margin: '10px 0 0', paddingLeft: 20, display: 'grid', gap: 8 }}>
                    <li>{t('disclaimer.text.point1')}</li>
                    <li>{t('disclaimer.text.point2')}</li>
                    <li>{t('disclaimer.text.point3')}</li>
                </ul>
            </div>
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
