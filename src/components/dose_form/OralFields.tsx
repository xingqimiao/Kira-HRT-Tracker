import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Route, Ester, isAntiandrogen } from '../../../logic';
import { FieldRow } from './FormControls';
import { FieldIcon } from '../compoundIcons';
import DoseAmountInput, { type AmountField } from './DoseAmountInput';

interface OralFieldsProps {
    ester: Ester;
    rawDose: string;
    e2Dose: string;
    onRawChange: (val: string) => void;
    onE2Change: (val: string) => void;
    route: Route;
}

/**
 * The oral route's dose rows.
 *
 * An anti-androgen has no estradiol content, so it gets the raw box only;
 * `getToE2Factor` returning 0 means a computed "0.000 mg E2" would be a number with no
 * referent. An oral EV has a fixed equivalent shown as a read-out; everything else
 * gets both boxes.
 */
const OralFields: React.FC<OralFieldsProps> = ({ ester, rawDose, e2Dose, onRawChange, onE2Change, route }) => {
    const { t } = useTranslation();
    const antiandrogen = isAntiandrogen(ester);

    const fields: AmountField[] = [];
    if (ester !== Ester.E2) {
        fields.push({ key: 'raw', label: t('field.dose_raw'), value: rawDose, onChange: onRawChange });
    }
    if (ester === Ester.EV && route === Route.oral) {
        fields[0].hint = `${t('field.dose_e2')}: ${e2Dose ? `${e2Dose} mg` : '--'}`;
    } else if (!antiandrogen) {
        fields.push({ key: 'e2', label: t('field.dose_e2'), value: e2Dose, onChange: onE2Change });
    }

    return (
        <div className="space-y-2.5">
            {fields.map((fld, i) => (
                <FieldRow key={fld.key} icon={fld.key === 'e2' ? FieldIcon.drop : FieldIcon.weight} label={fld.label} delay={i}>
                    <DoseAmountInput field={fld} />
                </FieldRow>
            ))}
        </div>
    );
};

export default OralFields;
