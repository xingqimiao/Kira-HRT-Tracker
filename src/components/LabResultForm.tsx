import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { LabResult, isT_LabUnit } from '../../logic';
import { Check, Trash2, X, ChevronDown } from '../icons';
import { v4 as uuidv4 } from 'uuid';
import DateTimePicker from './DateTimePicker';
import { LOCALE_MAP } from '../utils/helpers';

interface LabResultFormProps {
    resultToEdit?: LabResult | null;
    onSave: (result: LabResult) => void;
    onCancel: () => void;
    onDelete?: (id: string) => void;
    /**
     * Values to start the add-form with, from a scanned report.
     *
     * Prefills only. The user still edits and presses save — see `LabScan` for why
     * nothing reaches a record from recognition alone. Applied when the form opens,
     * so a scan that arrives while the form is already open still lands.
     */
    initialValues?: { E2?: { value: number; unit: LabUnit }; T?: { value: number; unit: LabUnit } } | null;
}

type LabUnit = 'pg/ml' | 'pmol/l' | 'ng/dl' | 'nmol/l';

// pg/mL is the app's canonical estradiol unit (convertToPgMl treats it as the
// identity; Home and the chart are drawn in it) and ng/dL the canonical
// testosterone unit, so a fresh reading must default to those to agree with
// every other view before the user toggles the unit.
const DEFAULT_E2_UNIT: LabUnit = 'pg/ml';
const DEFAULT_T_UNIT: LabUnit = 'ng/dl';

const divider = "border-b border-[var(--color-m3-outline-variant)] ";

const E2_UNITS: LabUnit[] = [DEFAULT_E2_UNIT, 'pmol/l'];
const T_UNITS: LabUnit[] = [DEFAULT_T_UNIT, 'nmol/l'];
const UNIT_LABELS: Record<LabUnit, string> = {
    'pmol/l': 'pmol/L',
    'pg/ml': 'pg/mL',
    'ng/dl': 'ng/dL',
    'nmol/l': 'nmol/L',
};

// One hormone's value + unit toggle. Reused for the estradiol row, the
// testosterone row, and (in edit mode) the single row matching whichever
// hormone the record being edited already belongs to.
const HormoneValueField: React.FC<{
    label: string;
    units: LabUnit[];
    unit: LabUnit;
    onUnitChange: (u: LabUnit) => void;
    value: string;
    onValueChange: (v: string) => void;
}> = ({ label, units, unit, onUnitChange, value, onValueChange }) => (
    <div>
        <div className="flex items-center justify-between mb-3">
            <span className="text-[0.9375rem] text-[var(--color-m3-on-surface)] ">
                {label}
            </span>
            <div className="flex gap-4">
                {units.map(u => (
                    <button
                        key={u}
                        onClick={() => onUnitChange(u)}
                        className={`text-sm pb-0.5 border-b-2 ${unit === u
                            ? 'font-semibold text-[var(--color-m3-on-surface)]  border-[var(--color-m3-primary)]'
                            : 'text-[var(--color-m3-on-surface-variant)]  border-transparent'
                        }`}
                    >
                        {UNIT_LABELS[u]}
                    </button>
                ))}
            </div>
        </div>
        <input
            type="number"
            inputMode="decimal"
            placeholder="0.0"
            value={value}
            onChange={e => onValueChange(e.target.value)}
            className="w-full bg-[var(--color-m3-surface-container-lowest)]  border border-[var(--color-m3-outline-variant)]  rounded-md px-3 py-2 outline-none focus:border-[var(--color-m3-primary)] text-[var(--color-m3-on-surface)]  placeholder:text-[var(--color-m3-on-surface-variant)] tabular-nums"
            style={{ fontSize: '16px' }}
        />
    </div>
);

const LabResultForm: React.FC<LabResultFormProps> = ({ resultToEdit, onSave, onCancel, onDelete, initialValues }) => {
    const { t, lang } = useTranslation();
    const [dateStr, setDateStr] = useState("");
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);

    // Editing an existing record: single value tied to that record's hormone.
    const [editUnit, setEditUnit] = useState<LabUnit>(DEFAULT_E2_UNIT);
    const [editValue, setEditValue] = useState("");

    // Adding new: estradiol and testosterone are independent fields, so one
    // blood draw covering both markers can be logged as a single entry at a
    // single timestamp instead of two separate saves.
    const [e2Unit, setE2Unit] = useState<LabUnit>(DEFAULT_E2_UNIT);
    const [e2Value, setE2Value] = useState("");
    const [tUnit, setTUnit] = useState<LabUnit>(DEFAULT_T_UNIT);
    const [tValue, setTValue] = useState("");

    useEffect(() => {
        if (resultToEdit) {
            const d = new Date(resultToEdit.timeH * 3600000);
            const iso = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
            setDateStr(iso);
            setEditValue(resultToEdit.concValue.toString());
            setEditUnit(resultToEdit.unit);
        } else {
            const now = new Date();
            const iso = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
            setDateStr(iso);
            // A scanned report prefills the two fields; anything it did not read is
            // left empty rather than defaulted, so the user can see at a glance what
            // the scan actually produced.
            setE2Value(initialValues?.E2 ? String(initialValues.E2.value) : "");
            setTValue(initialValues?.T ? String(initialValues.T.value) : "");
            setE2Unit(initialValues?.E2?.unit ?? DEFAULT_E2_UNIT);
            setTUnit(initialValues?.T?.unit ?? DEFAULT_T_UNIT);
        }
        // `initialValues` is in the dependency list so a scan handed to an already-open
        // form applies, rather than being silently dropped until the next reopen.
    }, [resultToEdit, initialValues]);

    const handleSave = () => {
        if (!dateStr) return;
        const timeH = new Date(dateStr).getTime() / 3600000;
        if (isNaN(timeH)) return;

        if (resultToEdit) {
            const numValue = parseFloat(editValue);
            if (!editValue || isNaN(numValue) || numValue < 0) return;
            onSave({ id: resultToEdit.id, timeH, concValue: numValue, unit: editUnit });
            return;
        }

        const e2Num = parseFloat(e2Value);
        const tNum = parseFloat(tValue);
        const hasE2 = e2Value.trim() !== '' && Number.isFinite(e2Num) && e2Num >= 0;
        const hasT = tValue.trim() !== '' && Number.isFinite(tNum) && tNum >= 0;
        if (!hasE2 && !hasT) return;
        if (hasE2) onSave({ id: uuidv4(), timeH, concValue: e2Num, unit: e2Unit });
        if (hasT) onSave({ id: uuidv4(), timeH, concValue: tNum, unit: tUnit });
    };

    const canSave = resultToEdit ? !!editValue : (!!e2Value || !!tValue);
    const editIsT = isT_LabUnit(editUnit);

    return (
        <div className="flex flex-col h-full">
            <div className="overflow-y-auto flex-1">
                {/* Date row */}
                <button
                    type="button"
                    onClick={() => setIsDatePickerOpen(v => !v)}
                    className={`w-full flex items-center justify-between py-[18px] ${divider} text-start`}
                >
                    <span className="text-[0.9375rem] text-[var(--color-m3-on-surface)] ">
                        {t('lab.date')}
                    </span>
                    <div className="flex items-center gap-1.5 text-[var(--color-m3-on-surface-variant)] ">
                        <span className="text-sm tabular-nums">
                            {dateStr ? new Date(dateStr).toLocaleString(LOCALE_MAP[lang] || 'en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </span>
                        <Icon icon={ChevronDown} size={14} className={`chev ${isDatePickerOpen ? 'rotate-180' : ''}`} />
                    </div>
                </button>
                <DateTimePicker
                    isOpen={isDatePickerOpen}
                    inline
                    onClose={() => setIsDatePickerOpen(false)}
                    onConfirm={(date) => {
                        const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                        setDateStr(iso);
                    }}
                    initialDate={dateStr ? new Date(dateStr) : new Date()}
                    mode="datetime"
                    title={t('lab.date')}
                />

                {resultToEdit ? (
                    <div className={`py-[18px] ${divider}`}>
                        <HormoneValueField
                            label={editIsT ? t('lab.value_t') : t('lab.value')}
                            units={editIsT ? T_UNITS : E2_UNITS}
                            unit={editUnit}
                            onUnitChange={setEditUnit}
                            value={editValue}
                            onValueChange={setEditValue}
                        />
                    </div>
                ) : (
                    <>
                        <div className={`py-[18px] ${divider}`}>
                            <HormoneValueField
                                label={t('lab.value')}
                                units={E2_UNITS}
                                unit={e2Unit}
                                onUnitChange={setE2Unit}
                                value={e2Value}
                                onValueChange={setE2Value}
                            />
                        </div>
                        <div className={`py-[18px] ${divider}`}>
                            <HormoneValueField
                                label={t('lab.value_t')}
                                units={T_UNITS}
                                unit={tUnit}
                                onUnitChange={setTUnit}
                                value={tValue}
                                onValueChange={setTValue}
                            />
                        </div>
                        <p className="text-xs text-[var(--color-m3-on-surface-variant)]  pt-2">
                            {t('lab.dual_hint')}
                        </p>
                    </>
                )}
            </div>

            {/* Footer */}
            <div className="pt-4 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                    {resultToEdit && onDelete && (
                        <>
                            {showDeleteConfirm ? (
                                <div className="flex items-center gap-1 bg-cos-error-container  border border-red-100  rounded px-2 py-1">
                                    <span className="text-xs text-cos-error  font-medium whitespace-nowrap">{t('dialog.confirm_title')}?</span>
                                    <button
                                        onClick={() => { onDelete(resultToEdit.id); onCancel(); }}
                                        className="p-1 text-cos-error  hover:bg-cos-error-container  rounded"
                                    >
                                        <Icon icon={Check} size={14} />
                                    </button>
                                    <button
                                        onClick={() => setShowDeleteConfirm(false)}
                                        className="p-1 text-[var(--color-m3-on-surface-variant)] hover:bg-cos-error-container  rounded"
                                    >
                                        <Icon icon={X} size={14} />
                                    </button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => setShowDeleteConfirm(true)}
                                    className="p-2 text-[var(--color-m3-on-surface-variant)] hover:text-cos-error rounded"
                                >
                                    <Icon icon={Trash2} size={16} />
                                </button>
                            )}
                        </>
                    )}
                </div>

                <div className="flex gap-2 ml-auto">
                    <button
                        onClick={onCancel}
                        className="min-w-[88px] px-4 py-2 text-sm text-[var(--color-m3-on-surface-variant)]  hover:bg-[var(--color-m3-surface-container)]  rounded-md flex items-center justify-center"
                    >
                        {t('btn.cancel')}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!canSave || !dateStr}
                        className="min-w-[88px] px-4 py-2 text-sm font-medium bg-[var(--color-m3-primary)] text-cos-on-primary rounded-md disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                        <Icon icon={Check} size={14} />
                        {t('btn.save')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default LabResultForm;
