import React, { useState, useMemo } from 'react';
import Icon from '../components/Icon';
import { Plus, ChevronRight, Scan } from '../icons';
import { LabResult, DoseEvent, MONITORING_UNIT, getMonitoringNotices, getRecheckReminders, isMonitoringOnlyLab, monitoringValues, CalibrationMethod, CalibrationResult, CalibrationPoint, getHormoneLevelAdvisory, Ester } from '../../logic';
import { Lang } from '../i18n/translations';
import { formatDate, formatTime, LOCALE_MAP } from '../utils/helpers';
import LabResultForm from '../components/LabResultForm';
import LabScan from '../components/LabScan';
import { suggestSelection, type HormoneCandidate, type LabUnit } from '../utils/ocrParse';
import BloodVial from '../components/BloodVial';
import { useHRTMode } from '../contexts/HRTModeContext';
import { HormoneLevelAdvisoryLine } from '../components/DoseAdvisory';
import MonitoringNoticeLine, { RecheckReminderLine, SpironolactonePrecautions } from '../components/MonitoringNotice';
import JournalCheckIn from '../components/JournalCheckIn';
import { JournalEntry } from '../utils/bodyJournal';

interface LabProps {
    t: (key: string) => string;
    isQuickAddLabOpen: boolean;
    setIsQuickAddLabOpen: (isOpen: boolean) => void;
    labResults: LabResult[];
    /** Every dose record, for the cumulative-CPA notice. */
    events: DoseEvent[];
    onSaveLabResult: (res: LabResult) => void;
    onDeleteLabResult: (id: string) => void;
    onClearLabResults: () => void;
    calibrationMethod: CalibrationMethod;
    calibration: CalibrationResult;
    onOpenCalibrationSettings: () => void;
    lang: Lang;
    /** The private journal, kept on this section rather than in 记录. */
    journal: JournalEntry[];
    onSaveJournalEntry: (entry: JournalEntry) => void;
    onDeleteJournalEntry: (id: string) => void;
}

const Lab: React.FC<LabProps> = ({
    t,
    isQuickAddLabOpen,
    setIsQuickAddLabOpen,
    labResults,
    events,
    onSaveLabResult,
    onDeleteLabResult,
    onClearLabResults,
    calibrationMethod,
    calibration,
    onOpenCalibrationSettings,
    lang,
    journal,
    onSaveJournalEntry,
    onDeleteJournalEntry,
}) => {
    const { isTransmasc } = useHRTMode();
    const [editingLabId, setEditingLabId] = useState<string | null>(null);
    // Whether the scan panel is open, and what it read. Both live here rather than in
    // the scanner so the panel can close and leave the prefilled form behind.
    const [isScanOpen, setIsScanOpen] = useState(false);
    const [scanned, setScanned] = useState<HormoneCandidate[] | null>(null);

    /**
     * Turn scan candidates into the form's prefill shape.
     *
     * `suggestSelection` decides what is unambiguous; anything it declines to pick is
     * left for the user rather than guessed at. That asymmetry is the point — see the
     * note on it in `ocrParse`.
     */
    const scannedInitialValues = useMemo(() => {
        if (!scanned || scanned.length === 0) return null;
        const suggestion = suggestSelection(scanned);
        const out: { E2?: { value: number; unit: LabUnit }; T?: { value: number; unit: LabUnit } } = {};
        if (suggestion.E2) out.E2 = { value: suggestion.E2.value, unit: suggestion.E2.unit };
        if (suggestion.T) out.T = { value: suggestion.T.value, unit: suggestion.T.unit };
        return Object.keys(out).length > 0 ? out : null;
    }, [scanned]);

    const muted = 'text-[var(--color-m3-on-surface-variant)] ';
    const on = 'text-[var(--color-m3-on-surface)] ';

    const pointById = useMemo(() => {
        const m = new Map<string, CalibrationPoint>();
        for (const p of calibration.points) m.set(p.id, p);
        return m;
    }, [calibration.points]);

    const hasCal = calibration.points.length > 0;
    const hormoneAdvisory = useMemo(() => getHormoneLevelAdvisory(labResults), [labResults]);
    // Evidence notices for the monitoring bloods and cumulative CPA exposure. Pure
    // thresholds from docs/monitoring-reference.md — see `getMonitoringNotices`.
    const notices = useMemo(() => getMonitoringNotices(labResults, events), [labResults, events]);
    // Re-check reminders are due-date notices, not value notices: they need a start
    // point and no source states one in the app's terms, so the anchor is the first
    // LOGGED dose of that compound and a compound with no logged dose gets nothing
    // rather than a guessed schedule. See `getRecheckReminders`.
    const rechecks = useMemo(() => getRecheckReminders(events), [events]);
    // The precautions belong to one compound and are shown only when that compound
    // is actually recorded — advice for a drug nobody is taking is noise.
    const onSpironolactone = useMemo(() => events.some(e => e.ester === Ester.SPIRO), [events]);

    // One-line summary of the active calibration for the settings entry row.
    // Before any usable labs exist there's no fit to show, so we fall back to
    // just the method name (a bare "×1.00" would be misleading).
    const calSummary = calibrationMethod === 'off'
        ? t('cal.off')
        : !hasCal
            ? t(`cal.${calibrationMethod}`)
            : [
                t(`cal.${calibrationMethod}`),
                `×${calibration.scale.toFixed(2)}`,
                calibration.fitErrPct !== null ? `±${calibration.fitErrPct.toFixed(0)}%` : null,
            ].filter(Boolean).join(' · ');

    return (
        <div className="relative pb-32">
            {/* Header */}
            <div className="mx-auto w-full sticky top-0 z-20 bg-[var(--color-m3-surface-dim)]  px-6 md:px-8 pt-8 pb-4 flex items-center justify-between max-w-2xl">
                <h1 className={`text-m3-title-xl ${on}`}>
                    {t('lab.title')}
                </h1>
                <div className="flex items-center gap-1">
                    {/* Scan sits beside Add rather than inside it: it is a different
                        way in, and burying it in the form would hide it from anyone
                        who does not already know it exists. */}
                    <button
                        onClick={() => setIsScanOpen(!isScanOpen)}
                        aria-pressed={isScanOpen}
                        className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-m3-on-surface-variant)]  px-2 py-1 rounded-md hover:bg-[var(--color-m3-surface-container)] "
                    >
                        <Icon icon={Scan} size={15} />
                        <span>{t('scan.title')}</span>
                    </button>
                    <button
                        onClick={() => setIsQuickAddLabOpen(!isQuickAddLabOpen)}
                        className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-m3-primary)]  px-2 py-1 -mr-2 rounded-md hover:bg-[var(--color-m3-surface-container)] "
                    >
                        <Icon icon={Plus} size={15} className={`transition-transform ${isQuickAddLabOpen ? 'rotate-45' : ''}`} />
                        <span>{isQuickAddLabOpen ? t('btn.cancel') : t('lab.add_title')}</span>
                    </button>
                </div>
            </div>

            {/* Scan panel. Collapsed by default — it is a 22 MB download the first
                time it runs, so it must never be on the path of a user who just wants
                to type a number in. */}
            <div className={`grid ${isScanOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                    <div className="mx-auto w-full px-6 md:px-8 mb-6 max-w-2xl">
                        {isScanOpen && (
                            <LabScan
                                onCancel={() => setIsScanOpen(false)}
                                onExtracted={(candidates) => {
                                    setScanned(candidates);
                                    setIsScanOpen(false);
                                    // Open the form so the user lands on the prefilled
                                    // values — the confirmation IS the form.
                                    setIsQuickAddLabOpen(true);
                                }}
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* Expandable add form */}
            <div className={`grid ${isQuickAddLabOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                    <div className="mx-auto w-full px-6 md:px-8 mb-6 max-w-2xl">
                        <LabResultForm
                            resultToEdit={null}
                            initialValues={scannedInitialValues}
                            onSave={(res) => {
                                onSaveLabResult(res);
                                setIsQuickAddLabOpen(false);
                                // Clear the scan so the next open starts fresh rather
                                // than silently refilling from the previous report.
                                setScanned(null);
                            }}
                            onCancel={() => {
                                setIsQuickAddLabOpen(false);
                                setScanned(null);
                            }}
                            onDelete={() => {}}
                        />
                    </div>
                </div>
            </div>

            <div className="mx-auto w-full px-6 md:px-8 max-w-2xl">
                {hormoneAdvisory && (
                    <div className="pb-4">
                        <HormoneLevelAdvisoryLine advisory={hormoneAdvisory} t={t} />
                    </div>
                )}

                {notices.length > 0 && (
                    <div className="pb-4 space-y-1.5">
                        {notices.map(notice => (
                            <MonitoringNoticeLine key={notice.kind} notice={notice} t={t} />
                        ))}
                    </div>
                )}

                {(rechecks.length > 0 || onSpironolactone) && (
                    <div className="pb-4 space-y-2.5">
                        {rechecks.map(reminder => (
                            <RecheckReminderLine
                                key={reminder.kind}
                                reminder={reminder}
                                t={t}
                                formatDate={(h) => new Date(h * 3600000).toLocaleDateString(LOCALE_MAP[lang] || 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                            />
                        ))}
                        {onSpironolactone && <SpironolactonePrecautions t={t} />}
                    </div>
                )}

                {/* Calibration settings entry — always available; how labs feed the estimate */}
                <button
                    onClick={onOpenCalibrationSettings}
                    className="w-full flex items-center justify-between gap-3 py-4 text-start outline-none focus:outline-none focus-visible:outline-none hover:bg-[var(--color-m3-surface-container)]  border-b border-[var(--color-m3-outline-variant)] "
                >
                    <div className="min-w-0">
                        <p className={`text-m3-body-medium ${on}`}>{t('cal.settings')}</p>
                        <p className={`text-xs ${muted} mt-0.5 tabular-nums`}>{calSummary}</p>
                    </div>
                    <Icon icon={ChevronRight} size={16} className={`${muted} shrink-0`} />
                </button>

                {/* Lab results list */}
                {labResults.length === 0 ? (
                    <div className={`flex flex-col items-center py-20 text-center ${muted}`}>
                        {/* Empty on purpose: this is the screen that fills it, and a
                            partly full tube here would be inventing a reading. */}
                        <BloodVial level={0} mode={isTransmasc ? 'transmasc' : 'transfem'} size={64} className="mb-4" />
                        <p className="text-sm">{t('lab.empty')}</p>
                    </div>
                ) : (
                    <div>
                        {labResults
                            .slice()
                            .sort((a, b) => b.timeH - a.timeH)
                            .map(res => {
                                const d = new Date(res.timeH * 3600000);
                                const isEditing = editingLabId === res.id;
                                const pt = pointById.get(res.id);
                                return (
                                    <div key={res.id} className="border-b border-[var(--color-m3-outline-variant)]  last:border-b-0">
                                        <div
                                            className={`py-3.5 flex items-start gap-3 cursor-pointer -mx-2 px-2 rounded-md hover:bg-[var(--color-m3-surface-container)]  ${isEditing ? 'bg-[var(--color-m3-surface-container)] ' : ''}`}
                                            onClick={() => setEditingLabId(isEditing ? null : res.id)}
                                        >
                                            <div className="mt-[7px] w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--color-m3-primary)]" />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between mb-1">
                                                    <span className={`font-medium ${on} text-sm`}>
                                                        {isMonitoringOnlyLab(res)
                                                            ? t('monitor.section')
                                                            : `${res.concValue} ${res.unit}`}
                                                    </span>
                                                    <span className={`text-xs tabular-nums ${muted} shrink-0`}>
                                                        {formatTime(d)}
                                                    </span>
                                                </div>
                                                {monitoringValues(res).length > 0 && (
                                                    // Monitoring bloods travel on the lab result, so they
                                                    // are listed here rather than in a parallel section.
                                                    <p className={`text-xs ${muted} tabular-nums mt-0.5`}>
                                                        {monitoringValues(res)
                                                            .map(mv => `${t(`monitor.${mv.analyte.toLowerCase()}`)} ${mv.value} ${MONITORING_UNIT[mv.analyte]}${mv.uln !== undefined ? ` (${t('monitor.uln')} ${mv.uln})` : ''}`)
                                                            .join(' · ')}
                                                    </p>
                                                )}
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className={`text-xs ${muted}`}>{formatDate(d, lang)}</span>
                                                    {pt && (
                                                        <span className="flex items-center gap-1.5 text-xs tabular-nums shrink-0">
                                                            <span className={muted}>{t('cal.model')} {Math.round(pt.pred)}</span>
                                                            <span
                                                                className="px-1.5 py-0.5 rounded font-medium"
                                                                style={{
                                                                    color: 'var(--color-m3-primary)',
                                                                    background: 'var(--color-m3-primary-container)',
                                                                }}
                                                            >
                                                                ×{pt.ratio.toFixed(2)}
                                                            </span>
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                        <div className={`grid ${isEditing ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                                            <div className="overflow-hidden">
                                                <div className="pb-4 pt-1">
                                                    <LabResultForm
                                                        resultToEdit={res}
                                                        onSave={(updated) => {
                                                            onSaveLabResult(updated);
                                                            setEditingLabId(null);
                                                        }}
                                                        onCancel={() => setEditingLabId(null)}
                                                        onDelete={(id) => {
                                                            onDeleteLabResult(id);
                                                            setEditingLabId(null);
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}

                        {/* Clear all — the last result row's border-b is the divider above this */}
                        <div className="flex items-center justify-end py-4">
                            <button
                                onClick={onClearLabResults}
                                className="text-sm font-medium text-cos-error hover:text-cos-error  "
                            >
                                {t('lab.clear_all')}
                            </button>
                        </div>
                    </div>
                )}

            </div>

            {/* The private journal lives on this section (体检), not in 记录: it is a
                record of the body, filed beside the bloods it is read with. It keeps
                its own heading and count, so it reads as its own record either way. */}
            <JournalCheckIn
                entries={journal}
                onSave={onSaveJournalEntry}
                onDelete={onDeleteJournalEntry}
            />
        </div>
    );
};

export default Lab;
