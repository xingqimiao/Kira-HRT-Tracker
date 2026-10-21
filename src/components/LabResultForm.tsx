import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { useTranslation } from '../contexts/LanguageContext';
import { LabResult, MONITORING_UNIT, isT_LabUnit } from '../../logic';
import { Check, Trash2 } from '../icons';
import { v4 as uuidv4 } from 'uuid';
import { TimePage } from './TimePage';
import { LOCALE_MAP } from '../utils/helpers';
import { Icon as SpriteIcon } from '../ui/SvgDefs';

interface LabResultFormProps {
    resultToEdit?: LabResult | null;
    onSave: (result: LabResult) => void;
    onCancel: () => void;
    onDelete?: (id: string) => void;
    /**
     * Values to start the add-form with, from a scanned report.
     *
     * Prefills only. The user still edits and presses save — see `LabScan` for why
     * nothing reaches a record from recognition alone.
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

const E2_UNITS: LabUnit[] = [DEFAULT_E2_UNIT, 'pmol/l'];
const T_UNITS: LabUnit[] = [DEFAULT_T_UNIT, 'nmol/l'];
const UNIT_LABELS: Record<LabUnit, string> = {
    'pmol/l': 'pmol/L',
    'pg/ml': 'pg/mL',
    'ng/dl': 'ng/dL',
    'nmol/l': 'nmol/L',
};

/** One hormone reading: a large number on the primary container, unit toggle under it. */
const HormoneHero: React.FC<{
    label: string;
    units: LabUnit[];
    unit: LabUnit;
    onUnitChange: (u: LabUnit) => void;
    value: string;
    onValueChange: (v: string) => void;
}> = ({ label, units, unit, onUnitChange, value, onValueChange }) => (
    <div className="lf-hero">
        <span className="l">{label}</span>
        <input
            type="number"
            inputMode="decimal"
            placeholder="0.0"
            value={value}
            onChange={e => onValueChange(e.target.value)}
            className="lf-num"
            aria-label={label}
        />
        <div className="cg" role="group" aria-label={label}>
            {units.map(u => (
                <button key={u} type="button" className={unit === u ? 'on' : ''} onClick={() => onUnitChange(u)}>
                    {UNIT_LABELS[u]}
                </button>
            ))}
        </div>
    </div>
);

const LabResultForm: React.FC<LabResultFormProps> = ({ resultToEdit, onSave, onCancel, onDelete, initialValues }) => {
    const { t, lang } = useTranslation();
    const [dateStr, setDateStr] = useState('');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isTimePageOpen, setIsTimePageOpen] = useState(false);

    // Editing an existing record: single value tied to that record's hormone.
    const [editUnit, setEditUnit] = useState<LabUnit>(DEFAULT_E2_UNIT);
    const [editValue, setEditValue] = useState('');

    // Adding new: estradiol and testosterone are independent fields, so one
    // blood draw covering both markers can be logged as a single entry at a
    // single timestamp instead of two separate saves.
    const [e2Unit, setE2Unit] = useState<LabUnit>(DEFAULT_E2_UNIT);
    const [e2Value, setE2Value] = useState('');
    const [tUnit, setTUnit] = useState<LabUnit>(DEFAULT_T_UNIT);
    const [tValue, setTValue] = useState('');

    // Monitoring bloods. Optional and independent of the two hormones above: a
    // single draw may carry any subset, and an empty field saves nothing.
    const [prlValue, setPrlValue] = useState('');
    const [prlUln, setPrlUln] = useState('');
    const [altValue, setAltValue] = useState('');
    const [altUln, setAltUln] = useState('');
    const [astValue, setAstValue] = useState('');
    const [kValue, setKValue] = useState('');

    // Monitoring bloods default collapsed, unless editing a record that has monitoring bloods.
    const [isMonitoringOpen, setIsMonitoringOpen] = useState(
        Boolean(resultToEdit?.monitoringOnly || resultToEdit?.prolactin || resultToEdit?.alt || resultToEdit?.ast || resultToEdit?.potassium),
    );

    useEffect(() => {
        if (resultToEdit) {
            const d = new Date(resultToEdit.timeH * 3600000);
            const iso = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
            setDateStr(iso);
            setEditValue(resultToEdit.concValue.toString());
            setEditUnit(resultToEdit.unit);
            // Prefill the monitoring fields so editing a record cannot silently drop
            // the bloods that were saved with it.
            const str = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
            setPrlValue(str(resultToEdit.prolactin));
            setPrlUln(str(resultToEdit.prolactinUln));
            setAltValue(str(resultToEdit.alt));
            setAltUln(str(resultToEdit.altUln));
            setAstValue(str(resultToEdit.ast));
            setKValue(str(resultToEdit.potassium));
            setIsMonitoringOpen(Boolean(resultToEdit.monitoringOnly || resultToEdit.prolactin || resultToEdit.alt || resultToEdit.ast || resultToEdit.potassium));
        } else {
            const now = new Date();
            const iso = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
            setDateStr(iso);
            // A scanned report prefills the two fields; anything it did not read is
            // left empty rather than defaulted.
            setE2Value(initialValues?.E2 ? String(initialValues.E2.value) : '');
            setTValue(initialValues?.T ? String(initialValues.T.value) : '');
            setE2Unit(initialValues?.E2?.unit ?? DEFAULT_E2_UNIT);
            setTUnit(initialValues?.T?.unit ?? DEFAULT_T_UNIT);
            setPrlValue(''); setPrlUln('');
            setAltValue(''); setAltUln('');
            setAstValue(''); setKValue('');
            setIsMonitoringOpen(false);
        }
    }, [resultToEdit, initialValues]);

    const filledMonitoringCount = [prlValue, altValue, astValue, kValue].filter(v => v.trim() !== '').length;

    /**
     * The monitoring bloods, one record each.
     *
     * A draw carries any subset of PRL/ALT/AST/K, and keeping them on one record
     * made the 体检 list print four analytes as a single run-on line *and* made
     * deleting one of them delete the rest. Each is stored as its own
     * `monitoringOnly` record at the same timestamp instead, so every measured
     * item is a row of its own and edits only touch what they name.
     *
     * `concValue`/`unit` stay required by `LabResult` (the frozen chart and
     * `OnboardingCurve` read them unconditionally), so the neutral zero plus an E2
     * unit placeholder rides along — every hormone reader skips these records via
     * `isMonitoringOnlyLab`.
     */
    const monitoringRecords = (timeH: number): LabResult[] => {
        const num = (raw: string) => {
            const n = parseFloat(raw);
            return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
        };
        const rows: LabResult[] = [];
        const push = (fields: Partial<LabResult>) => rows.push({
            id: uuidv4(), timeH, concValue: 0, unit: DEFAULT_E2_UNIT, monitoringOnly: true, ...fields,
        });
        const prolactin = num(prlValue);
        const prolactinUln = num(prlUln);
        if (prolactin !== undefined) {
            push({ prolactin, ...(prolactinUln !== undefined && prolactinUln > 0 ? { prolactinUln } : {}) });
        }
        const alt = num(altValue);
        const altUlnValue = num(altUln);
        if (alt !== undefined) {
            push({ alt, ...(altUlnValue !== undefined && altUlnValue > 0 ? { altUln: altUlnValue } : {}) });
        }
        const ast = num(astValue);
        if (ast !== undefined) push({ ast });
        const potassium = num(kValue);
        if (potassium !== undefined) push({ potassium });
        return rows;
    };

    /** Clear the add-form's fields (it stays mounted across saves). */
    const resetFields = () => {
        setE2Value(''); setTValue('');
        setPrlValue(''); setPrlUln('');
        setAltValue(''); setAltUln('');
        setAstValue(''); setKValue('');
    };

    const handleSave = () => {
        if (!dateStr) return;
        const timeH = new Date(dateStr).getTime() / 3600000;
        if (isNaN(timeH)) return;

        if (resultToEdit) {
            const bloods = monitoringRecords(timeH);
            if (resultToEdit.monitoringOnly) {
                if (bloods.length === 0) return;
                // The edited record keeps its id for the first blood, so an edit
                // rewrites that one row instead of leaving it behind; the rest of
                // the draw becomes records of their own.
                onSave({ ...bloods[0], id: resultToEdit.id });
                bloods.slice(1).forEach(onSave);
                return;
            }
            const numValue = parseFloat(editValue);
            if (!editValue || isNaN(numValue) || numValue < 0) return;
            onSave({ id: resultToEdit.id, timeH, concValue: numValue, unit: editUnit });
            bloods.forEach(onSave);
            return;
        }

        const e2Num = parseFloat(e2Value);
        const tNum = parseFloat(tValue);
        const hasE2 = e2Value.trim() !== '' && Number.isFinite(e2Num) && e2Num >= 0;
        const hasT = tValue.trim() !== '' && Number.isFinite(tNum) && tNum >= 0;
        const bloods = monitoringRecords(timeH);

        if (!hasE2 && !hasT && bloods.length === 0) return;

        // One draw can carry E2, T and monitoring bloods — as separate records at
        // one timestamp, never merged into a single row.
        if (hasE2) onSave({ id: uuidv4(), timeH, concValue: e2Num, unit: e2Unit });
        if (hasT) onSave({ id: uuidv4(), timeH, concValue: tNum, unit: tUnit });
        bloods.forEach(onSave);

        // The form stays mounted on save, so without this a second open would still
        // hold the previous draw's numbers.
        resetFields();
    };

    const canSave = resultToEdit
        ? (resultToEdit.monitoringOnly
            ? (!!prlValue || !!altValue || !!astValue || !!kValue)
            : !!editValue)
        : (!!e2Value || !!tValue || !!prlValue || !!altValue || !!astValue || !!kValue);
    const editIsT = isT_LabUnit(editUnit);

    const dateLabel = dateStr
        ? new Date(dateStr).toLocaleDateString(LOCALE_MAP[lang] || 'en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';
    const timeLabel = dateStr
        ? new Date(dateStr).toLocaleTimeString(LOCALE_MAP[lang] || 'en-US', { hour: '2-digit', minute: '2-digit' })
        : '';

    const timeRow = (
        <button
            type="button"
            onClick={() => setIsTimePageOpen(true)}
            className="li tap"
            style={{ width: '100%', border: 0, font: 'inherit', color: 'inherit', textAlign: 'left', borderRadius: 20 }}
            aria-expanded={isTimePageOpen}
        >
            <div className="ic p"><SpriteIcon id="clock" /></div>
            <div className="tx" style={{ minWidth: 0 }}>
                <div className="t" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {dateStr ? `${dateLabel} ${timeLabel}` : t('m3e.time.now')}
                </div>
            </div>
            <SpriteIcon id="chev" />
        </button>
    );

    const monitoringBlock = (
        <>
            <div className="lf-sec">{t('monitor.section')}</div>
            <button
                type="button"
                onClick={() => setIsMonitoringOpen(v => !v)}
                className="li"
                style={{
                    width: '100%',
                    border: 0,
                    font: 'inherit',
                    color: 'inherit',
                    textAlign: 'left',
                    alignItems: 'flex-start',
                    padding: '14px 16px',
                    borderRadius: isMonitoringOpen ? '20px 20px 6px 6px' : 20,
                    transition: 'border-radius .2s, background .18s',
                }}
                aria-expanded={isMonitoringOpen}
            >
                <span className="ic am"><SpriteIcon id="drop" /></span>
                <div className="t" style={{ minWidth: 0 }}>
                    <b>{t('monitor.section')}</b>
                    <span className="s" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{t('monitor.hint')}</span>
                </div>
                {filledMonitoringCount > 0 && !isMonitoringOpen ? <span className="chip">{filledMonitoringCount}</span> : null}
                <SpriteIcon id={isMonitoringOpen ? 'down' : 'chev'} style={{ transform: isMonitoringOpen ? 'none' : 'rotate(90deg)' }} />
            </button>

            {isMonitoringOpen && (
                <div className="list" style={{ marginTop: 3, gap: 3 }}>
                    {[
                        { key: 'prl', label: t('monitor.prl'), unit: MONITORING_UNIT.PRL, value: prlValue, set: setPrlValue },
                        { key: 'prl_uln', label: t('monitor.prl_uln'), unit: MONITORING_UNIT.PRL, value: prlUln, set: setPrlUln },
                        { key: 'alt', label: t('monitor.alt'), unit: MONITORING_UNIT.ALT, value: altValue, set: setAltValue },
                        { key: 'alt_uln', label: t('monitor.alt_uln'), unit: MONITORING_UNIT.ALT, value: altUln, set: setAltUln },
                        { key: 'ast', label: t('monitor.ast'), unit: MONITORING_UNIT.AST, value: astValue, set: setAstValue },
                        { key: 'k', label: t('monitor.k'), unit: MONITORING_UNIT.K, value: kValue, set: setKValue },
                    ].map((field, idx, arr) => {
                        const isLast = idx === arr.length - 1;
                        const radius = isLast ? '6px 6px 20px 20px' : '6px';
                        return (
                            <label key={field.key} className="li" style={{ cursor: 'default', borderRadius: radius }}>
                                <div className="t">
                                    <b>{field.label}</b>
                                    <span className="s">{field.unit}</span>
                                </div>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    placeholder="0.0"
                                    value={field.value}
                                    onChange={e => field.set(e.target.value)}
                                    className="lab-num tabular-nums"
                                    aria-label={field.label}
                                />
                            </label>
                        );
                    })}
                </div>
            )}
            {isMonitoringOpen && <p className="sub" style={{ margin: '0 6px', fontSize: 12 }}>{t('monitor.uln_hint')}</p>}
        </>
    );

    return (
        <div className="d-col" style={{ gap: 10 }}>
            {resultToEdit ? (
                <div className="d-col" style={{ gap: 10 }}>
                    {timeRow}
                    {resultToEdit.monitoringOnly ? (
                        monitoringBlock
                    ) : (
                        <HormoneHero
                            label={editIsT ? t('lab.value_t') : t('lab.value')}
                            units={editIsT ? T_UNITS : E2_UNITS}
                            unit={editUnit}
                            onUnitChange={setEditUnit}
                            value={editValue}
                            onValueChange={setEditValue}
                        />
                    )}
                </div>
            ) : (
                <div className="lab-form-grid">
                    <div className="d-col" style={{ gap: 10 }}>
                        <HormoneHero
                            label={t('lab.value')}
                            units={E2_UNITS}
                            unit={e2Unit}
                            onUnitChange={setE2Unit}
                            value={e2Value}
                            onValueChange={setE2Value}
                        />
                        <HormoneHero
                            label={t('lab.value_t')}
                            units={T_UNITS}
                            unit={tUnit}
                            onUnitChange={setTUnit}
                            value={tValue}
                            onValueChange={setTValue}
                        />
                        <p className="sub" style={{ margin: '0 6px' }}>{t('lab.dual_hint')}</p>
                    </div>
                    <div className="d-col" style={{ gap: 10 }}>
                        {timeRow}
                        {monitoringBlock}
                    </div>
                </div>
            )}

            <TimePage
                open={isTimePageOpen}
                initialDate={dateStr ? new Date(dateStr) : new Date()}
                onClose={() => setIsTimePageOpen(false)}
                onConfirm={(date) => {
                    const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                    setDateStr(iso);
                    setIsTimePageOpen(false);
                }}
            />

            <div className="hrow" style={{ gap: 8, position: 'sticky', bottom: -12, background: 'var(--sc)', paddingTop: 12, paddingBottom: 4, zIndex: 6, marginTop: 4, borderTop: '1px solid rgba(154,141,149,0.14)' }}>
                {showDeleteConfirm ? (
                    <>
                        <span className="sub" style={{ margin: 0, flex: 1 }}>{t('lab.delete_confirm')}</span>
                        <button type="button" className="btn x" onClick={() => setShowDeleteConfirm(false)}>{t('btn.cancel')}</button>
                        <button
                            type="button"
                            className="btn"
                            style={{ background: 'var(--errc)', color: 'var(--err)' }}
                            onClick={() => { if (resultToEdit && onDelete) { onDelete(resultToEdit.id); onCancel(); } }}
                        >
                            <Icon icon={Check} size={16} />{t('btn.delete')}
                        </button>
                    </>
                ) : (
                    <>
                        {resultToEdit && onDelete && (
                            <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(true)}
                                className="ic-btn danger"
                                style={{ marginRight: 'auto' }}
                                aria-label={t('btn.delete')}
                                title={t('btn.delete')}
                            >
                                <Icon icon={Trash2} size={19} />
                            </button>
                        )}
                        <button type="button" onClick={onCancel} className="btn x">{t('btn.cancel')}</button>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={!canSave || !dateStr}
                            className="btn"
                            style={{ flex: resultToEdit ? undefined : 1, opacity: canSave && dateStr ? 1 : .4 }}
                        >
                            <Icon icon={Check} size={17} />
                            {t('btn.save')}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default LabResultForm;
