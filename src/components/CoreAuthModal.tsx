import React from 'react';

import CoreAuthForm from './CoreAuthForm';
import type { CoreSession } from '../hooks/useCoreSession';
import { usePresence } from '../hooks/usePresence';
import { AdaptiveSheet, useMediaQuery } from '../ui/proto';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * The Core sign-in, in a container.
 *
 * A thin shell around `CoreAuthForm`: this file owns the surface and the
 * dismissal decision, and nothing else. On a phone it is a bottom sheet — the
 * share flow opens it from a thumb-reachable primary action, and the form can
 * request more height as the provider block and Turnstile arrive. Wide windows
 * keep the centred dialog.
 */
interface CoreAuthModalProps {
    isOpen: boolean;
    onClose: () => void;
    session: CoreSession;
    /** Called once a session exists, so the app can load records. */
    onSignedIn?: () => void;
    /** Pre-fill the username — used when X identified the account but cannot unlock it. */
    initialUsername?: string;
}

const CoreAuthModal: React.FC<CoreAuthModalProps> = ({
    isOpen,
    onClose,
    session,
    onSignedIn,
    initialUsername = '',
}) => {
    const desktop = useMediaQuery('(min-width: 760px)');
    const { t } = useTranslation();
    const { mounted, state } = usePresence(isOpen, 200);

    const form = (
        <CoreAuthForm
            session={session}
            onSignedIn={onSignedIn}
            onDone={onClose}
            onCancel={onClose}
            initialUsername={initialUsername}
            active={isOpen}
        />
    );

    if (!desktop) {
        return (
            <AdaptiveSheet
                open={isOpen}
                onClose={onClose}
                bare
                closeLabel={t('core.close')}
            >
                {form}
            </AdaptiveSheet>
        );
    }

    if (!mounted) return null;

    return (
        <div className="modal-overlay z-[70]" data-state={state} role="dialog" aria-modal="true">
            <div className="modal-shell">
                <div className="modal-card">
                    {form}
                </div>
            </div>
        </div>
    );
};

export default CoreAuthModal;
