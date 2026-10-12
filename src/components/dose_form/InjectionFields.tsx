import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Route, Ester, isTestosteroneEster, isAntiandrogen } from '../../../logic';
import { FieldRow } from './FormControls';
import { FieldIcon } from '../compoundIcons';
import DoseAmountInput, { type AmountField } from './DoseAmountInput';

interface InjectionFieldsProps {
    ester: Ester;
    rawDose: string;
    e2Dose: string;
    onRawChange: (val: string) => void;
    onE2Change: (val: string) => void;
    route: Route;
}

/**
 * The injection route's dose rows.
 *
 * An EV injection has a fixed 1:1 relationship the form shows as a single raw box
 * plus a read-out (its E2-equivalent is derived, not typed); the other esters get both
 * boxes. An injected anti-androgen has no equivalent at all, so it is raw-only.
 */
const InjectionFields: React.FC<InjectionFieldsProps> = ({ ester, rawDose, e2Dose, onRawChange, onE2Change, route }) => {
    const { t } = useTranslation();
    const isT = isTestosteroneEster(ester);
    const antiandrogen = isAntiandrogen(ester);
    const equivLabel = isT ? t('field.dose_t') : t('field.dose_e2');

    const fields: AmountField[] = [];
    if (ester !== Ester.E2) {
        fields.push({
            key: 'raw',
            label: t('field.dose_raw'),
            value: rawDose,
            onChange: onRawChange,
        });
    }
    const evInjection = ester === Ester.EV && route === Route.injection;
    if (evInjection) {
        // The equivalent is derived; show it as a read-out under the single box.
        fields[0].hint = `${equivLabel}: ${e2Dose ? `${e2Dose} mg` : '--'}`;
    } else if (!antiandrogen) {
        fields.push({
            key: 'e2',
            label: equivLabel,
            value: e2Dose,
            onChange: onE2Change,
        });
    }

    return (
        <div className="space-y-2.5">
            {fields.map((fld, i) => (
                <FieldRow
                    key={fld.key}
                    icon={fld.key === 'e2' ? FieldIcon.drop : FieldIcon.weight}
                    label={fld.label}
                    delay={i}
                >
                    <DoseAmountInput field={fld} />
                </FieldRow>
            ))}
        </div>
    );
};

export default InjectionFields;
