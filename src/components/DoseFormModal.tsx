import React from 'react';
import DoseForm, { DoseTemplate } from './DoseForm';
import { QuickDose } from './dose_form/QuickDoseButtons';
import { useEscape } from '../hooks/useEscape';
import { ContainerTransform } from '../ui/ContainerTransform';
import { DoseEvent, type PkEngineId } from '../../logic';
import { useTranslation } from '../contexts/LanguageContext';

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

/**
 * The shell-level dose editor. It is the same container transform as the History
 * FAB: `#fab` is recorded as the source by `PrototypeShell`, and a chart point
 * falls back to the centred scale because no button was pressed.
 */
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
    const { t } = useTranslation();
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

    return (
        <ContainerTransform
            open={isOpen}
            onClose={handleClose}
            title={eventToEdit ? t('modal.dose.edit_title') : t('timeline.add_title')}
            bare
            ghostIcon="plus"
        >
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
                events={events}
                activeEngine={activeEngine}
            />
        </ContainerTransform>
    );
};

export default DoseFormModal;
