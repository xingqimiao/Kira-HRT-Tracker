import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';
import { AdaptiveSheet, useMediaQuery } from '../ui/proto';

/**
 * The one-time explanation for the 2.0 sublingual peak.
 *
 * Users who updated into the 2.0 model saw sublingual peaks far above what the
 * literature supports, and the fix changes those numbers again. Leaving that
 * unexplained would read as the app being unable to make up its mind, so the
 * release that carries the fix says what changed and why the curve is sharp.
 *
 * Shown once per install (see the flag in Home), and only on accounts whose
 * history contains a sublingual dose — gel, patch, injection and oral users were
 * never affected and have nothing to read here.
 */
const ModelFixNotice = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
    const { t } = useTranslation();
    const desktop = useMediaQuery('(min-width: 760px)');

    useEscape(onClose, isOpen);
    const { mounted, state } = usePresence(isOpen, 200);

    const heading = (key: string) => (
        <p style={{ margin: '16px 0 0', color: 'var(--on)', fontWeight: 600 }}>{t(key)}</p>
    );

    const body = (
        <div className="d-col" style={{ gap: 14 }}>
            <b style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.35 }}>{t('model_fix.title')}</b>
            <div className="sub" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
                <p style={{ margin: 0 }}>{t('model_fix.p1')}</p>
                {heading('model_fix.h1')}
                <p style={{ margin: '8px 0 0' }}>{t('model_fix.p2')}</p>
                <p style={{ margin: '8px 0 0' }}>{t('model_fix.p3')}</p>
                <p style={{ margin: '10px 0 0', fontSize: 12 }}>{t('model_fix.p4')}</p>
                {heading('model_fix.h2')}
                <p style={{ margin: '8px 0 0' }}>{t('model_fix.p5')}</p>
                <p style={{ margin: '8px 0 0' }}>{t('model_fix.p6')}</p>
                <p style={{ margin: '8px 0 0' }}>{t('model_fix.p7')}</p>
                <p style={{ margin: '14px 0 0' }}>{t('model_fix.p8')}</p>
            </div>
            <button type="button" onClick={onClose} className="btn" style={{ width: '100%', height: 50 }}>
                {t('model_fix.ack')}
            </button>
        </div>
    );

    if (!desktop) {
        return (
            <AdaptiveSheet open={isOpen} onClose={onClose} bare closeLabel={t('model_fix.ack')}>
                {body}
            </AdaptiveSheet>
        );
    }

    if (!mounted) return null;

    return createPortal(
        <div className="modal-overlay z-[60]" data-state={state}>
            <div className="modal-shell">
                <div className="modal-card" style={{ maxHeight: '82vh', overflowY: 'auto' }}>
                    <h3 className="modal-title">{t('model_fix.title')}</h3>

                    <div className="text-sm text-muted space-y-3 mb-5 leading-relaxed">
                        <p>{t('model_fix.p1')}</p>
                        <p className="text-body font-medium">{t('model_fix.h1')}</p>
                        <p>{t('model_fix.p2')}</p>
                        <p>{t('model_fix.p3')}</p>
                        <p className="text-xs">{t('model_fix.p4')}</p>
                        <p className="text-body font-medium">{t('model_fix.h2')}</p>
                        <p>{t('model_fix.p5')}</p>
                        <p>{t('model_fix.p6')}</p>
                        <p>{t('model_fix.p7')}</p>
                        <p>{t('model_fix.p8')}</p>
                    </div>

                    <button onClick={onClose} className="btn-primary w-full">
                        {t('model_fix.ack')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default ModelFixNotice;
