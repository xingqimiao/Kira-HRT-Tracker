import React from 'react';

import CoreAuthForm from './CoreAuthForm';
import type { CoreSession } from '../hooks/useCoreSession';
import { usePresence } from '../hooks/usePresence';

/**
 * The Core sign-in, in a modal.
 *
 * A thin shell around `CoreAuthForm`: this file owns the overlay, the enter/exit
 * presence animation and the dismissal decision, and nothing else. The form itself
 * is shared with the Account page, which renders it inline — see the note there for
 * why the two used to be different forms against different backends.
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
    const { mounted, state } = usePresence(isOpen, 200);

    if (!mounted) return null;

    return (
        <div className="modal-overlay z-[70]" data-state={state} role="dialog" aria-modal="true">
            <div className="modal-shell">
                <div className="modal-card">
                    <CoreAuthForm
                        session={session}
                        onSignedIn={onSignedIn}
                        onDone={onClose}
                        onCancel={onClose}
                        initialUsername={initialUsername}
                        active={isOpen}
                    />
                </div>
            </div>
        </div>
    );
};

export default CoreAuthModal;
