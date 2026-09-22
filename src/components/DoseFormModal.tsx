import React from 'react';
import DoseForm, { DoseTemplate } from './DoseForm';
import { QuickDose } from './dose_form/QuickDoseButtons';
import { useEscape } from '../hooks/useEscape';
import { usePresence } from '../hooks/usePresence';
import { DoseEvent, type PkEngineId } from '../../logic';

export type { DoseTemplate, QuickDose };

interface DoseFormModalProps {
    isOpen: boolean;
    onClose: () => void;
    eventToEdit?: any;
    onSave?: any;
    onDelete?: any;
    templates?: DoseTemplate[];
    onSaveTemplate?: any;
    onDeleteTemplate?: any;
    quickDoses?: QuickDose[];
    onAddQuickDose?: (dose: QuickDose) => void;
    onDeleteQuickDose?: (id: string) => void;
    events?: DoseEvent[];
    /** The engine in use, so `DoseForm` can hide the fields it does not read. */
    activeEngine?: PkEngineId;
}

const DoseFormModal: React.FC<DoseFormModalProps> = ({
    isOpen,
    onClose,
    eventToEdit,
    onSave,
    onDelete,
    templates = [],
    onSaveTemplate,
    onDeleteTemplate,
    quickDoses = [],
    onAddQuickDose,
    onDeleteQuickDose,
    events = [],
    activeEngine
}) => {
    // Held mounted through the close so the dialog has an exit to play — the
    // `if (!isOpen) return null` this replaced unmounted it on the same frame the
    // state flipped, which is what made closing it disappear rather than leave.
    const { mounted, state } = usePresence(isOpen, 200);

    const handleClose = () => {
        onClose();
    };

    useEscape(() => {
        if (!document.querySelector('.z-\\[70\\]')) {
            handleClose();
        }
    }, isOpen);

    const handleSave = (event: any) => {
        if (onSave) {
            onSave(event);
        }
        handleClose();
    };

    if (!mounted) return null;

    return (
        <div className="modal-overlay" data-state={state}>
            <div className="modal-shell modal-shell-wide" data-state={state}>
            <div className="modal-card overflow-hidden p-0 w-full max-w-lg md:max-w-xl h-[92vh] md:max-h-[85vh] flex flex-col">

                <DoseForm
                    eventToEdit={eventToEdit}
                    onSave={handleSave}
                    onDelete={onDelete}
                    onCancel={handleClose}
                    templates={templates}
                    onSaveTemplate={onSaveTemplate}
                    onDeleteTemplate={onDeleteTemplate}
                    quickDoses={quickDoses}
                    onAddQuickDose={onAddQuickDose}
                    onDeleteQuickDose={onDeleteQuickDose}
                    isInline={false}
                    events={events}
                    activeEngine={activeEngine}
                />
            </div>
            </div>
        </div>
    );
};

export default DoseFormModal;
