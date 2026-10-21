import React, { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import Icon from '../components/Icon';
import { ChevronDown, Check, PenLine, Trash2 } from '../icons';
import { LabResult, LabItem, labItems, DoseEvent, getMonitoringNotices, getRecheckReminders, visibleRecheckReminders, recheckDueKey, CalibrationMethod, CalibrationResult, CalibrationPoint, getHormoneLevelAdvisory, Ester, RecheckIntervals, OcrModelTier } from '../../logic';
import type { Lang } from '../i18n/types';
import { formatDate, formatTime, LOCALE_MAP } from '../utils/helpers';
import LabResultForm from '../components/LabResultForm';
import LabScan from '../components/LabScan';
import { suggestSelection } from '../utils/ocrParse';
import BloodVial from '../components/BloodVial';
import { useHRTMode } from '../contexts/HRTModeContext';
import { useDialog } from '../contexts/DialogContext';
import { HormoneLevelAdvisoryLine } from '../components/DoseAdvisory';
import MonitoringNoticeLine, { RecheckReminderLine, SpironolactonePrecautions } from '../components/MonitoringNotice';
import { JournalEntry } from '../utils/bodyJournal';
import { TimePage } from '../components/TimePage';
import { useBackHandler } from '../utils/nativeBack';
import { v4 as uuidv4 } from 'uuid';
import { AdaptiveSheet } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import { useScrollParent } from '../hooks/useScrollParent';

/**
 * 体检 (Lab / Checkup) — AGENTS.md §2.3.
 *
 * Two records live here: the bloods (`labResults`) and the private journal of
 * body notes. They are one screen because a note is read beside the lab it
 * describes, but they are not one list: on a phone the journal is an entry row
 * that drills into its own `#examSub` page, while on a wide window it is the
 * left column beside the results. The same `JournalPanel` renders both, so the
 * two readings cannot drift.
 *
 * The add/edit result form sits in an `AdaptiveSheet` (bottom drawer on a phone,
 * centred dialog on desktop) rather than growing inline in the list — the page
 * stays a reading surface, and the row's press opens the editor for that row.
 */

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
    /** Due re-check dates this account has closed, keyed by reminder kind. */
    dismissedRechecks: Record<string, string>;
    onDismissRecheck: (kind: string, due: string) => void;
    /** The user's re-check intervals — see `RecheckIntervals` in logic.ts. */
    recheckIntervals: RecheckIntervals;
    /** Which OCR model tier the scan starts with; a retry may use the other one. */
    ocrModelTier: OcrModelTier;
    /**
     * The checkup FAB's "scan a report" entry. The scanner is its own full-screen
     * page, not a panel inside the manual add form: recognition only prefills the
     * form, and a dead scan button inside it was the thing this replaces.
     */
    isScanOpen: boolean;
    setIsScanOpen: (open: boolean) => void;
}

/** A local ISO string for `datetime-local`, which is what the picker round-trips. */
const localIso = (date: Date): string =>
    new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/**
 * Measured-vs-model comparison for a calibrated lab: the model's estimate is a
 * hollow ring in `--pri`, the measured draw is the solid dot, on one shared
 * scale. The ratio chip is the same number the fit uses, so the glyph and the
 * chip can never disagree.
 */
const CalibrationCompare: React.FC<{ point: CalibrationPoint; t: (key: string) => string }> = ({ point, t }) => {
    const W = 56;
    const H = 22;
    const PAD = 6;
    const max = Math.max(point.obs, point.pred, 1e-9);
    const x = (v: number) => PAD + (W - PAD * 2) * Math.min(1, Math.max(0, v / max));

    return (
        <span
            role="img"
            aria-label={`${t('cal.model')} ${Math.round(point.pred)} · ×${point.ratio.toFixed(2)}`}
            className="inline-flex items-center gap-2"
        >
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="shrink-0">
                <line
                    x1={PAD}
                    y1={H / 2}
                    x2={W - PAD}
                    y2={H / 2}
                    stroke="var(--out)"
                    strokeOpacity="0.45"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                />
                <circle cx={x(point.pred)} cy={H / 2} r="4.5" fill="none" stroke="var(--pri)" strokeWidth="1.8" />
                <circle cx={x(point.obs)} cy={H / 2} r="3.2" fill="var(--pri)" />
            </svg>
            <span className="chip" style={{ background: 'var(--pric)', color: 'var(--onpric)', padding: '5px 10px' }}>×{point.ratio.toFixed(2)}</span>
        </span>
    );
};

/**
 * One measured item in a lab record.
 *
 * A draw is stored as one record and can carry a hormone together with any
 * subset of the monitoring bloods. The list gives each analyte its own row — one
 * number, one unit, one name — instead of a subtitle that runs them all
 * together, which read as a single nonsense value. `labItems` decides the split,
 * so the list and the editor cannot disagree about what a record holds.
 *
 * Pressing a row opens the record it came from: the analytes of one draw are one
 * save, not several, so editing them separately is not a thing the storage can
 * mean.
 */
const LabItemRow: React.FC<{
    res: LabResult;
    item: LabItem;
    point?: CalibrationPoint;
    t: (key: string) => string;
    lang: Lang;
    onOpen: (res: LabResult) => void;
    radius?: string;
}> = ({ res, item, point, t, lang, onOpen, radius }) => {
    const d = new Date(res.timeH * 3600000);
    const analyte = item.kind === 'E2'
        ? t('scan.analyte_e2')
        : item.kind === 'T'
            ? t('scan.analyte_t')
            : t(`monitor.${item.kind.toLowerCase()}`);
    const subtitle = [
        `${formatDate(d, lang)} · ${formatTime(d)}`,
        analyte,
        ...(item.uln !== undefined ? [`${t('monitor.uln')} ${item.uln} ${item.unit}`] : []),
    ].join(' · ');
    const tone = item.kind === 'E2' ? 'p' : item.kind === 'T' ? 'am' : '';

    return (
        <div className="li" role="button" tabIndex={0} style={{ borderRadius: radius }} onClick={() => onOpen(res)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(res); } }}>
            <span className={`ic ${tone}`} aria-hidden="true" style={{ width: 50, height: 50 }}>
                <SpriteIcon id="drop" />
            </span>
            <div className="t">
                <b className="nw">{`${item.value} ${item.unit}`}</b>
                <span className="s">{subtitle}</span>
            </div>
            {point ? <CalibrationCompare point={point} t={t} /> : null}
        </div>
    );
};

/** The prototype's line-art cat, copied verbatim from docs/m3e-prototype.html. */
const CatDoodle: React.FC = () => (
    <svg
        viewBox="0 0 80 60"
        width="78"
        height="58"
        fill="none"
        stroke="var(--out)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M16 20L14 4l14 8M64 20l2-16-14 8" />
        <path d="M16 20c-4 10 0 30 24 30s28-20 24-30c-6-8-42-8-48 0z" />
        <circle cx="30" cy="30" r="2" fill="var(--out)" />
        <circle cx="50" cy="30" r="2" fill="var(--out)" />
        <path d="M38 36q2 3 4 0" />
    </svg>
);

/**
 * The journal contents, shared by the desktop left column and the phone's
 * drilled-in `#examSub` page. Entries edit on press; deletion lives inside the
 * editor, so a row cannot be removed by a stray tap on the list.
 */
const JournalPanel: React.FC<{
    entries: JournalEntry[];
    t: (key: string) => string;
    formatWhen: (timeH: number) => string;
    onAdd: () => void;
    onEdit: (entry: JournalEntry) => void;
}> = ({ entries, t, formatWhen, onAdd, onEdit }) => (
    <div className="d-col" style={{ gap: 10 }}>
        <div>
            <div className="hrow">
                <b style={{ fontSize: 15.5 }}>{t('journal.section')}</b>
                <span className="sub" style={{ margin: 0 }}>{entries.length} {t('journal.count')}</span>
            </div>
            <p className="sub" style={{ margin: '4px 0 0', fontSize: 12 }}>{t('journal.register')}</p>
        </div>

        {entries.length === 0 ? (
            <div className="card" style={{ background: 'var(--sch)' }}>
                <div className="empty">
                    <CatDoodle />
                    <div style={{ marginTop: 8 }}>{t('journal.empty')}</div>
                </div>
            </div>
        ) : (
            /* The list is the container, not a card holding a list. The old
               nesting put a `.card` behind `.list`, so every row's hover state
               layer lit up a panel *inside* another panel — the container-in-
               container the screenshot showed. Rows are the same `.li` blocks
               the lab records below use. */
            <div className="list">
                {entries.map(entry => (
                    <div className="li" key={entry.id} style={{ alignItems: 'flex-start', padding: '14px 16px' }}>
                        <button
                            type="button"
                            onClick={() => onEdit(entry)}
                            style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'none', font: 'inherit', color: 'inherit', padding: 0 }}
                        >
                            <span className="s" style={{ display: 'block', marginTop: 0, fontSize: 12 }}>{formatWhen(entry.timeH)}</span>
                            {/* The note is the reason the row exists; the timestamp is
                                metadata. Setting both at the same size made the eye land
                                on the time first. */}
                            <span style={{ display: 'block', marginTop: 5, fontSize: 20, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.note}</span>
                        </button>
                    </div>
                ))}
            </div>
        )}

        <button type="button" onClick={onAdd} className="btn tonal-add">
            <Icon icon={PenLine} size={17} />
            <span>{t('journal.add')}</span>
        </button>
    </div>
);

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
    dismissedRechecks,
    onDismissRecheck,
    recheckIntervals,
    isScanOpen,
    setIsScanOpen,
}) => {
    const { isTransmasc } = useHRTMode();
    const { showDialog } = useDialog();
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollParent = useScrollParent(rootRef);

    // Which record the sheet is editing (null = the add form). The sheet is open
    // when either this or the App's FAB flag says so.
    const [editingLabId, setEditingLabId] = useState<string | null>(null);
    // Values the scanner read, handed to the manual form as prefill only.
    const [scanValues, setScanValues] = useState<{ E2?: { value: number; unit: 'pg/ml' | 'pmol/l' }; T?: { value: number; unit: 'ng/dl' | 'nmol/l' } } | null>(null);
    // Phone only: the journal entry drilled into `#examSub`.
    const [examSubOpen, setExamSubOpen] = useState(false);

    // Journal editor. Same field set as before: one time and one piece of text.
    const [journalSheetOpen, setJournalSheetOpen] = useState(false);
    const [journalEditing, setJournalEditing] = useState<JournalEntry | null>(null);
    const [journalDate, setJournalDate] = useState(() => localIso(new Date()));
    const [journalNote, setJournalNote] = useState('');
    const [journalPickerOpen, setJournalPickerOpen] = useState(false);

    // System back closes the drilled-in journal page and the containers before it
    // leaves 体检. App already handles `isQuickAddLabOpen`; these cover the rest.
    useBackHandler(editingLabId !== null, () => {
        setEditingLabId(null);
        return true;
    });
    useBackHandler(journalSheetOpen, () => {
        setJournalSheetOpen(false);
        return true;
    });
    useBackHandler(examSubOpen, () => {
        switchExamSub(false);
        return true;
    });
    useBackHandler(isScanOpen, () => {
        setIsScanOpen(false);
        return true;
    });

    const sortedResults = useMemo(() => labResults.slice().sort((a, b) => b.timeH - a.timeH), [labResults]);
    const sortedJournal = useMemo(() => journal.slice().sort((a, b) => b.timeH - a.timeH), [journal]);

    /** The journal drill-in is a route-like swap, so both directions get a real
     *  cross-fade instead of the main pane reappearing on the same frame. */
    const switchExamSub = (next: boolean) => {
        const go = () => flushSync(() => setExamSubOpen(next));
        const isDesktop = typeof document !== 'undefined' && (document.body.classList.contains('desktop') || window.innerWidth >= 760);
        const transition = (document as Document & {
            startViewTransition?: (cb: () => void) => unknown;
        }).startViewTransition;
        if (transition && !isDesktop && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            transition.call(document, go);
        } else {
            go();
        }
    };

    const pointById = useMemo(() => {
        const m = new Map<string, CalibrationPoint>();
        for (const p of calibration.points) m.set(p.id, p);
        return m;
    }, [calibration.points]);

    const editingLab = editingLabId ? (sortedResults.find(r => r.id === editingLabId) ?? null) : null;
    const labSheetOpen = isQuickAddLabOpen || editingLab !== null;

    /**
     * The list is one row per *measured item*, not per record: a draw that carried
     * E2, prolactin and ALT is three rows, each with its own number. See
     * `labItems` for why a record may hold more than one.
     */
    const labRows = useMemo(
        () => sortedResults.flatMap(res => labItems(res).map(item => ({ key: `${res.id}:${item.kind}`, res, item }))),
        [sortedResults],
    );

    /**
     * A calibration point describes the model's estradiol/testosterone estimate
     * against a measured hormone. A prolactin or ALT row has nothing to compare,
     * so it must not borrow the ×ratio chip the hormone row on the same draw shows.
     */
    const pointFor = (row: { res: LabResult; item: LabItem }) =>
        (row.item.kind === 'E2' || row.item.kind === 'T' ? pointById.get(row.res.id) : undefined);

    const hasCal = calibration.points.length > 0;
    const hormoneAdvisory = useMemo(() => getHormoneLevelAdvisory(labResults), [labResults]);
    // Evidence notices for the monitoring bloods and cumulative CPA exposure. Pure
    // thresholds from docs/monitoring-reference.md — see `getMonitoringNotices`.
    const notices = useMemo(() => getMonitoringNotices(labResults, events), [labResults, events]);
    // Re-check reminders are due-date notices, not value notices: they need a start
    // point and no source states one in the app's terms. For estradiol the anchor is
    // the last logged check, falling back to the first LOGGED dose of that compound;
    // a compound with no logged dose gets nothing rather than a guessed schedule. The
    // lab list is passed so the check the user already had silences the reminder. See
    // `getRecheckReminders`.
    const rechecks = useMemo(
        () => getRecheckReminders(events, undefined, recheckIntervals, labResults),
        [events, recheckIntervals, labResults],
    );
    // The precautions belong to one compound and are shown only when that compound
    // is actually recorded — advice for a drug nobody is taking is noise.
    const onSpironolactone = useMemo(() => events.some(e => e.ester === Ester.SPIRO), [events]);

    /**
     * A dismissed reminder is not rendered, and therefore not counted.
     *
     * The count the collapsed summary prints has to match what opening it would
     * reveal, so it is computed from this list rather than from `rechecks`. That
     * is what makes dismissing one of three read "2": the dismissed kind leaves
     * the list, and the summary and the panel are two views of the same array
     * instead of two independent counts that can disagree.
     */
    const visibleRechecks = useMemo(
        () => visibleRecheckReminders(rechecks, dismissedRechecks),
        [rechecks, dismissedRechecks],
    );

    const formatRecheckDate = (h: number) =>
        new Date(h * 3600000).toLocaleDateString(LOCALE_MAP[lang] || 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });

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

    const openLabResult = (res: LabResult) => {
        setIsQuickAddLabOpen(false);
        setScanValues(null);
        setEditingLabId(res.id);
    };

    const closeLabSheet = () => {
        setIsQuickAddLabOpen(false);
        setEditingLabId(null);
        setScanValues(null);
    };

    const formatJournalWhen = (timeH: number) =>
        new Date(timeH * 3600000).toLocaleString(LOCALE_MAP[lang] || 'en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });

    const openJournalNew = () => {
        setJournalEditing(null);
        setJournalDate(localIso(new Date()));
        setJournalNote('');
        setJournalPickerOpen(false);
        setJournalSheetOpen(true);
    };

    const openJournalEdit = (entry: JournalEntry) => {
        setJournalEditing(entry);
        setJournalDate(localIso(new Date(entry.timeH * 3600000)));
        setJournalNote(entry.note);
        setJournalPickerOpen(false);
        setJournalSheetOpen(true);
    };

    const closeJournalSheet = () => {
        setJournalSheetOpen(false);
        setJournalEditing(null);
        setJournalNote('');
        setJournalPickerOpen(false);
    };

    // The one guard on the form: a note with no words is not a record, and storing
    // one would put a blank line in the middle of the log.
    const canSaveJournal = journalNote.trim() !== '';

    const saveJournal = () => {
        if (!canSaveJournal) return;
        const when = new Date(journalDate);
        const timeH = Number.isFinite(when.getTime()) ? when.getTime() / 3600000 : Date.now() / 3600000;
        onSaveJournalEntry({
            ...(journalEditing ?? {}),
            id: journalEditing?.id ?? uuidv4(),
            timeH,
            note: journalNote.trim(),
        });
        closeJournalSheet();
    };

    const journalPanel = (entries: JournalEntry[]) => (
        <JournalPanel
            entries={entries}
            t={t}
            formatWhen={formatJournalWhen}
            onAdd={openJournalNew}
            onEdit={openJournalEdit}
        />
    );

    return (
        <div className="pg on long relative" ref={rootRef}>
            {!examSubOpen && (
                <>
                    <h1 style={{ margin: 0 }}>{t('nav.lab')}</h1>

                    <div className="d-grid exam-grid">
                        <div className="d-col" id="examMain">
                            <div className="list exam-entry lg:hidden">
                                <div className="li" role="button" tabIndex={0} onClick={() => switchExamSub(true)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchExamSub(true); } }}>
                                    <span className="ic p"><SpriteIcon id="note" /></span>
                                    <div className="t">
                                        <b>{t('journal.section')}</b>
                                        <span className="s">{sortedJournal.length} {t('journal.count')}</span>
                                    </div>
                                    <SpriteIcon id="chev" />
                                </div>
                            </div>

                            <div className="exam-text-desktop">
                                {journalPanel(sortedJournal)}
                            </div>
                        </div>

                        <div className="d-col" id="examSide">
                            {hormoneAdvisory && <HormoneLevelAdvisoryLine advisory={hormoneAdvisory} t={t} />}

                            {/*
                              Every monitoring surface is one list: the evidence
                              notices, the due re-checks, and the spironolactone
                              precautions. They were three differently-shaped
                              panels above this list until the M3E rebuild; a row
                              that expands in place is the same language the lab
                              results right below it already speak.
                            */}
                            {(notices.length > 0 || visibleRechecks.length > 0 || onSpironolactone) && (
                                <>
                                    <div className="lab" style={{ marginTop: 0 }}>{t('monitor.section')}</div>
                                    <div className="list">
                                        {notices.map(notice => (
                                            <MonitoringNoticeLine key={notice.kind} notice={notice} t={t} />
                                        ))}
                                        {visibleRechecks.map(reminder => (
                                            <RecheckReminderLine
                                                key={reminder.kind}
                                                reminder={reminder}
                                                t={t}
                                                formatDate={formatRecheckDate}
                                                dismissed={false}
                                                onDismiss={() => onDismissRecheck(reminder.kind, recheckDueKey(reminder))}
                                            />
                                        ))}
                                        {onSpironolactone && <SpironolactonePrecautions t={t} />}
                                    </div>
                                </>
                            )}

                            <div className="lab" style={{ marginTop: 0 }}>{t('lab.title')}</div>
                            {labResults.length === 0 ? (
                                <div className="card">
                                    <div className="empty">
                                        <BloodVial level={0} mode={isTransmasc ? 'transmasc' : 'transfem'} size={64} />
                                        <p style={{ marginTop: 10 }}>{t('lab.empty')}</p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="list bigic">
                                        {scrollParent ? (
                                            <Virtuoso
                                                customScrollParent={scrollParent}
                                                data={labRows}
                                                itemContent={(index, row) => (
                                                    <div style={{ paddingBottom: 3 }}>
                                                        <LabItemRow
                                                            res={row.res}
                                                            item={row.item}
                                                            point={pointFor(row)}
                                                            t={t}
                                                            lang={lang}
                                                            onOpen={openLabResult}
                                                            radius={labRows.length === 1
                                                                ? '26px'
                                                                : index === 0
                                                                    ? '26px 26px 8px 8px'
                                                                    : index === labRows.length - 1
                                                                        ? '8px 8px 26px 26px'
                                                                        : '8px'}
                                                        />
                                                    </div>
                                                )}
                                            />
                                        ) : labRows.map((row, index) => (
                                            <LabItemRow
                                                key={row.key}
                                                res={row.res}
                                                item={row.item}
                                                point={pointFor(row)}
                                                t={t}
                                                lang={lang}
                                                onOpen={openLabResult}
                                                radius={labRows.length === 1
                                                    ? '26px'
                                                    : index === 0
                                                        ? '26px 26px 8px 8px'
                                                        : index === labRows.length - 1
                                                            ? '8px 8px 26px 26px'
                                                            : '8px'}
                                            />
                                        ))}
                                    </div>
                                    <div className="hrow" style={{ justifyContent: 'flex-end' }}>
                                        <button type="button" onClick={onClearLabResults} className="btn x" style={{ color: 'var(--err)' }}>
                                            {t('lab.clear_all')}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </>
            )}

            {examSubOpen && (
                <div id="examSub" className="d-col lg:hidden m3e-rise">
                    <button className="hback" type="button" onClick={() => switchExamSub(false)} aria-label={t('core.back')}>
                        <SpriteIcon id="chev" />
                        <span className="ht">{t('journal.section')}</span>
                    </button>
                    {journalPanel(sortedJournal)}
                </div>
            )}

            <AdaptiveSheet
                open={labSheetOpen}
                onClose={closeLabSheet}
                title={editingLab ? t('lab.edit_title') : t('lab.add_title')}
                closeLabel={t('btn.cancel')}
                wide={!editingLab}
            >
                <LabResultForm
                    key={editingLab ? editingLab.id : 'new'}
                    resultToEdit={editingLab}
                    initialValues={scanValues}
                    onSave={(res) => {
                        onSaveLabResult(res);
                        closeLabSheet();
                    }}
                    onCancel={closeLabSheet}
                    onDelete={(id) => {
                        onDeleteLabResult(id);
                        closeLabSheet();
                    }}
                />
            </AdaptiveSheet>

            {/* Scan and manual entry are siblings in the same bottom sheet: a scan
                only prefills the form, so it never writes a record by itself. */}
            <AdaptiveSheet
                open={isScanOpen}
                onClose={() => setIsScanOpen(false)}
                title={t('scan.title')}
                closeLabel={t('btn.cancel')}
            >
                <LabScan
                    onCancel={() => setIsScanOpen(false)}
                    onDirectSave={(candidates) => {
                        const suggestion = suggestSelection(candidates);
                        const timeH = Date.now() / 3600000;
                        if (suggestion.E2) {
                            onSaveLabResult({
                                id: uuidv4(),
                                timeH,
                                concValue: suggestion.E2.value,
                                unit: suggestion.E2.unit as 'pg/ml' | 'pmol/l',
                            });
                        }
                        if (suggestion.T) {
                            onSaveLabResult({
                                id: uuidv4(),
                                timeH,
                                concValue: suggestion.T.value,
                                unit: suggestion.T.unit as 'ng/dl' | 'nmol/l',
                            });
                        }
                        setIsScanOpen(false);
                    }}
                    onExtracted={(candidates) => {
                        const suggestion = suggestSelection(candidates);
                        setScanValues({
                            ...(suggestion.E2 ? { E2: { value: suggestion.E2.value, unit: suggestion.E2.unit as 'pg/ml' | 'pmol/l' } } : {}),
                            ...(suggestion.T ? { T: { value: suggestion.T.value, unit: suggestion.T.unit as 'ng/dl' | 'nmol/l' } } : {}),
                        });
                        setEditingLabId(null);
                        setIsScanOpen(false);
                        // Let the scan sheet finish sliding out before the form
                        // sheet slides in; opening both on one frame stacks them.
                        window.setTimeout(() => setIsQuickAddLabOpen(true), 360);
                    }}
                />
            </AdaptiveSheet>

            <AdaptiveSheet
                open={journalSheetOpen}
                onClose={closeJournalSheet}
                title={t('journal.section')}
                closeLabel={t('btn.cancel')}
                footer={
                    <div className="hrow" style={{ justifyContent: 'flex-end' }}>
                        {journalEditing ? (
                            <button
                                type="button"
                                onClick={() => {
                                    const entry = journalEditing;
                                    showDialog('confirm', t('journal.delete_confirm'), () => {
                                        onDeleteJournalEntry(entry.id);
                                        closeJournalSheet();
                                    });
                                }}
                                className="ic-btn danger"
                                style={{ marginRight: 'auto' }}
                                aria-label={t('btn.delete')}
                                title={t('btn.delete')}
                            >
                                <Icon icon={Trash2} size={19} />
                            </button>
                        ) : null}
                        <button type="button" onClick={closeJournalSheet} className="btn x">{t('btn.cancel')}</button>
                        <button type="button" onClick={saveJournal} disabled={!canSaveJournal} className="btn" style={{ opacity: canSaveJournal ? 1 : .4 }}>
                            <Icon icon={Check} size={16} />
                            <span>{t('btn.save')}</span>
                        </button>
                    </div>
                }
            >
                <div className="d-col" style={{ gap: 10 }}>
                    <button
                        type="button"
                        onClick={() => setJournalPickerOpen(true)}
                        className="li tap"
                        style={{ width: '100%', border: 0, font: 'inherit', color: 'inherit', textAlign: 'left', borderRadius: 20 }}
                    >
                        <div className="ic p"><SpriteIcon id="clock" /></div>
                        <div className="tx" style={{ minWidth: 0 }}>
                            <div className="t" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {journalDate
                                    ? `${new Date(journalDate).toLocaleDateString(LOCALE_MAP[lang] || 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })} ${new Date(journalDate).toLocaleTimeString(LOCALE_MAP[lang] || 'en-US', { hour: '2-digit', minute: '2-digit' })}`
                                    : t('m3e.time.now')}
                            </div>
                        </div>
                        <SpriteIcon id="chev" />
                    </button>

                    <TimePage
                        open={journalPickerOpen}
                        onClose={() => setJournalPickerOpen(false)}
                        onConfirm={date => {
                            setJournalDate(localIso(date));
                            setJournalPickerOpen(false);
                        }}
                        initialDate={new Date(journalDate)}
                        mode="datetime"
                        title={t('journal.time')}
                    />

                    <label className="sub" htmlFor="lab-journal-note" style={{ margin: 0 }}>{t('journal.note')}</label>
                    <textarea
                        id="lab-journal-note"
                        value={journalNote}
                        onChange={e => setJournalNote(e.target.value)}
                        placeholder={t('journal.note_placeholder')}
                        rows={5}
                        maxLength={2000}
                        className="fld"
                        style={{ height: 'auto', minHeight: 150, padding: 16, resize: 'vertical' }}
                    />
                </div>
            </AdaptiveSheet>
        </div>
    );
};
export default Lab;


