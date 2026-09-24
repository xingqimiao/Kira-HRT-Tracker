import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { LabResult, MONITORING_UNIT, isT_LabUnit } from '../../logic';
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
            <span className="text-m3-body-medium text-[var(--color-m3-on-surface)] ">
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
            className="input-base tabular-nums"
            style={{ fontSize: '16px' }}
        />
    </div>
);

// One monitoring analyte, at the unit the sources quote it in. The unit is a
// label, not a toggle: unlike E2/T these have no second unit the app converts.
const MonitorField: React.FC<{
    label: string;
    unit: string;
    value: string;
    onChange: (v: string) => void;
}> = ({ label, unit, value, onChange }) => (
    <div>
        <label className="block text-xs font-semibold text-cos-on-surface-variant pl-1 mb-1.5">
            {label} <span className="font-normal opacity-70">{unit}</span>
        </label>
        <input
            type="number"
            inputMode="decimal"
            placeholder="0.0"
            value={value}
            onChange={e => onChange(e.target.value)}
            className="input-base tabular-nums"
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

    // Monitoring bloods. Optional and independent of the two hormones above: a
    // single draw may carry any subset, and an empty field saves nothing.
    const [prlValue, setPrlValue] = useState("");
    const [prlUln, setPrlUln] = useState("");
    const [altValue, setAltValue] = useState("");
    const [altUln, setAltUln] = useState("");
    const [astValue, setAstValue] = useState("");
    const [kValue, setKValue] = useState("");

    useEffect(() => {
        if (resultToEdit) {
            const d = new Date(resultToEdit.timeH * 3600000);
            const iso = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
            setDateStr(iso);
            setEditValue(resultToEdit.concValue.toString());
            setEditUnit(resultToEdit.unit);
            // Prefill the monitoring fields so editing a record cannot silently drop
            // the bloods that were saved with it. A monitoring-only record has no
            // hormone field to show (see below); its placeholder value round-trips.
            const str = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : "");
            setPrlValue(str(resultToEdit.prolactin));
            setPrlUln(str(resultToEdit.prolactinUln));
            setAltValue(str(resultToEdit.alt));
            setAltUln(str(resultToEdit.altUln));
            setAstValue(str(resultToEdit.ast));
            setKValue(str(resultToEdit.potassium));
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
            setPrlValue(""); setPrlUln("");
            setAltValue(""); setAltUln("");
            setAstValue(""); setKValue("");
        }
        // `initialValues` is in the dependency list so a scan handed to an already-open
        // form applies, rather than being silently dropped until the next reopen.
    }, [resultToEdit, initialValues]);

    // Monitoring bloods are optional fields of the lab result being saved. The ULN
    // is carried only when the report printed one; without it the ratio rule cannot
    // be evaluated, and the sources warn that reference values differ by lab,
    // reagent and method — so a guessed range is exactly the number not to invent.
    const monitorFields = () => {
        const num = (raw: string) => {
            const n = parseFloat(raw);
            return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
        };
        const prolactin = num(prlValue);
        const alt = num(altValue);
        const ast = num(astValue);
        const potassium = num(kValue);
        const prolactinUln = num(prlUln);
        const altUlnValue = num(altUln);
        return {
            ...(prolactin !== undefined ? { prolactin } : {}),
            ...(prolactin !== undefined && prolactinUln !== undefined && prolactinUln > 0 ? { prolactinUln } : {}),
            ...(alt !== undefined ? { alt } : {}),
            ...(alt !== undefined && altUlnValue !== undefined && altUlnValue > 0 ? { altUln: altUlnValue } : {}),
            ...(ast !== undefined ? { ast } : {}),
            ...(potassium !== undefined ? { potassium } : {}),
        };
    };

    const handleSave = () => {
        if (!dateStr) return;
        const timeH = new Date(dateStr).getTime() / 3600000;
        if (isNaN(timeH)) return;

        const monitoring = monitorFields();
        const hasMonitoring = Object.keys(monitoring).length > 0;

        if (resultToEdit) {
            // A monitoring-only record keeps its neutral placeholder and just gets its
            // analytes rewritten.
            if (resultToEdit.monitoringOnly) {
                if (!hasMonitoring) return;
                onSave({ id: resultToEdit.id, timeH, concValue: 0, unit: resultToEdit.unit, monitoringOnly: true, ...monitoring });
                return;
            }
            const numValue = parseFloat(editValue);
            if (!editValue || isNaN(numValue) || numValue < 0) return;
            onSave({ id: resultToEdit.id, timeH, concValue: numValue, unit: editUnit, ...monitoring });
            return;
        }

        const e2Num = parseFloat(e2Value);
        const tNum = parseFloat(tValue);
        const hasE2 = e2Value.trim() !== '' && Number.isFinite(e2Num) && e2Num >= 0;
        const hasT = tValue.trim() !== '' && Number.isFinite(tNum) && tNum >= 0;

        if (!hasE2 && !hasT && !hasMonitoring) return;

        // One draw can carry E2, T and monitoring bloods. The monitoring values ride
        // on the estradiol record when there is one, otherwise on the testosterone
        // record, so one draw stays one row with its analytes attached. Only a draw
        // with no hormone reading gets a record of its own.
        if (hasE2) onSave({ id: uuidv4(), timeH, concValue: e2Num, unit: e2Unit, ...monitoring });
        if (hasT) onSave({ id: uuidv4(), timeH, concValue: tNum, unit: tUnit, ...(hasE2 ? {} : monitoring) });
        if (!hasE2 && !hasT && hasMonitoring) {
            onSave({ id: uuidv4(), timeH, concValue: 0, unit: DEFAULT_E2_UNIT, monitoringOnly: true, ...monitoring });
        }

        // Everything saved, so clear the boxes. The form only collapses on save (it
        // stays mounted), so without this a second open would still hold the previous
        // draw's numbers and a second save would silently duplicate the record —
        // which is worse for a lab result than an empty field.
        setE2Value(""); setTValue("");
        setPrlValue(""); setPrlUln("");
        setAltValue(""); setAltUln("");
        setAstValue(""); setKValue("");
    };

    const canSave = resultToEdit
        ? (resultToEdit.monitoringOnly
            ? (!!prlValue || !!altValue || !!astValue || !!kValue)
            : !!editValue)
        : (!!e2Value || !!tValue || !!prlValue || !!altValue || !!astValue || !!kValue);
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
                    <span className="text-m3-body-medium text-[var(--color-m3-on-surface)] ">
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
                    // A monitoring-only record has no hormone reading; showing the
                    // E2/T field would invite writing its 0 placeholder back.
                    resultToEdit.monitoringOnly ? null : (
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
                    )
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

                {/* Monitoring bloods. Part of the lab result being saved, not a
                    parallel store: only the parameters with a sourced threshold are
                    offered (prolactin, ALT, AST, potassium), and everything the
                    sources leave "not stated" stays off the form rather than being
                    guessed at. */}
                <div className={`py-[18px] ${divider}`}>
                    <span className="text-m3-body-medium text-[var(--color-m3-on-surface)] ">
                        {t('monitor.section')}
                    </span>
                    <p className="text-xs text-[var(--color-m3-on-surface-variant)]  mt-1">
                        {t('monitor.hint')}
                    </p>
                    <p className="text-xs text-[var(--color-m3-on-surface-variant)]  mt-1">
                        {t('monitor.uln_hint')}
                    </p>
                    <div className="grid grid-cols-2 gap-4 mt-3">
                        <MonitorField label={t('monitor.prl')} unit={MONITORING_UNIT.PRL} value={prlValue} onChange={setPrlValue} />
                        <MonitorField label={t('monitor.prl_uln')} unit={MONITORING_UNIT.PRL} value={prlUln} onChange={setPrlUln} />
                        <MonitorField label={t('monitor.alt')} unit={MONITORING_UNIT.ALT} value={altValue} onChange={setAltValue} />
                        <MonitorField label={t('monitor.alt_uln')} unit={MONITORING_UNIT.ALT} value={altUln} onChange={setAltUln} />
                        <MonitorField label={t('monitor.ast')} unit={MONITORING_UNIT.AST} value={astValue} onChange={setAstValue} />
                        <MonitorField label={t('monitor.k')} unit={MONITORING_UNIT.K} value={kValue} onChange={setKValue} />
                    </div>
                </div>
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
