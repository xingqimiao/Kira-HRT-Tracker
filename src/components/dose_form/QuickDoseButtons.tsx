import React from 'react';
import Icon from '../Icon';
import { Plus, X } from '../../icons';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../../contexts/LanguageContext';
import { useDialog } from '../../contexts/DialogContext';
import { Route, Ester } from '../../../logic';

export interface QuickDose {
    id: string;
    route: Route;
    ester: Ester;
    value: number;
    createdAt: number;
}

interface QuickDoseButtonsProps {
    route: Route;
    ester: Ester;
    quickDoses: QuickDose[];
    currentDose: string;
    onSelectDose: (value: number) => void;
    onAddQuickDose: (dose: QuickDose) => void;
    onDeleteQuickDose: (id: string) => void;
    unit?: string;
}

const QuickDoseButtons: React.FC<QuickDoseButtonsProps> = ({
    route,
    ester,
    quickDoses,
    currentDose,
    onSelectDose,
    onAddQuickDose,
    onDeleteQuickDose,
    unit = 'mg'
}) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();

    // Filter quick doses for current route + ester combination
    const filteredDoses = quickDoses
        .filter(d => d.route === route && d.ester === ester)
        .sort((a, b) => a.value - b.value);

    const handleAdd = () => {
        const val = parseFloat(currentDose);
        if (!Number.isFinite(val) || val <= 0) {
            showDialog('alert', t('quickdose.empty_input'));
            return;
        }

        // Check for duplicate
        const exists = filteredDoses.some(d => Math.abs(d.value - val) < 0.0001);
        if (exists) return;

        const newDose: QuickDose = {
            id: uuidv4(),
            route,
            ester,
            value: val,
            createdAt: Date.now()
        };
        onAddQuickDose(newDose);
    };

    const handleDelete = (id: string) => {
        showDialog('confirm', t('quickdose.delete_confirm'), () => {
            onDeleteQuickDose(id);
        });
    };

    const formatValue = (val: number): string => {
        if (Number.isInteger(val)) return val.toString();
        // Remove trailing zeros
        const str = val.toFixed(3);
        return str.replace(/\.?0+$/, '');
    };

    return (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {filteredDoses.map(dose => (
                <div key={dose.id} className="relative">
                    <button
                        type="button"
                        onClick={() => onSelectDose(dose.value)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border
                            border-[var(--color-m3-outline-variant)] 
                            text-body
                            hover:bg-[var(--color-m3-surface-container)] "
                    >
                        {formatValue(dose.value)} {unit}
                    </button>
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleDelete(dose.id); }}
                        aria-label={t('btn.delete')}
                        title={t('btn.delete')}
                        // Always visible: `opacity-0 group-hover:opacity-100` meant this
                        // chip's only delete affordance did not exist on a touch device,
                        // where there is no hover to reveal it. Kept at the chip's own
                        // corner rather than grown to an M3 48px target — it sits on a
                        // 24px-tall chip, and a target larger than the thing it deletes
                        // would swallow taps meant for the value beside it.
                        className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center
                            bg-[var(--color-m3-surface-container)] 
                            text-muted border border-[var(--color-m3-outline-variant)] 
                            hover:text-cos-error"
                    >
                        <Icon icon={X} size={11} strokeWidth={3} />
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={handleAdd}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-dashed
                    border-[var(--color-m3-outline-variant)] 
                    text-muted
                    hover:border-[var(--color-m3-outline)] 
                    hover:text-body"
                title={t('quickdose.add')}
            >
                <Icon icon={Plus} size={14} strokeWidth={2.5} />
            </button>
        </div>
    );
};

export default QuickDoseButtons;
