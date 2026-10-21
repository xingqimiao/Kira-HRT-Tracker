import React, { useId, useState } from 'react';
import { MonitoringNotice, RecheckReminder } from '../../logic';
import { Icon as SpriteIcon } from '../ui/SvgDefs';

/**
 * The monitoring surfaces of the 体检 page: the evidence notices, the due
 * re-check reminders, and the spironolactone precautions.
 *
 * All three are rows of one `SegmentedList` now. The old build gave each of them
 * its own bordered panel with a hand-rolled header, so three different-looking
 * boxes sat above the results list and none of them matched the list language the
 * rest of the app had been rebuilt on. A row that expands in place is both the
 * smaller thing to write and the one that reads as part of the page.
 *
 * The posture is unchanged and deliberate: this reports what the sources say and
 * links to them, it does not tell anyone what to do. The copy names the source
 * rather than compressing it into an instruction, which is why the CPA MRI
 * recommendation reads as "MtF.wiki's recommendation is an MRI" and not "get an
 * MRI".
 */

const SOURCES: Record<MonitoringNotice['kind'], { label: string; url: string }[]> = {
    prl: [
        { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/monitoring' },
    ],
    alt: [
        { label: 'FDA CASODEX', url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=dfee4fe7-8478-4a3e-925d-00be3cd0ab67' },
    ],
    k: [
        { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/antiandrogen/spironolactone' },
        { label: 'Endocrine Society', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9562816/' },
    ],
    cpa_cumulative: [
        { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/antiandrogen/cyproterone' },
        { label: 'SfE', url: 'https://www.endocrinology.org/news/item/23306/risk-of-meningioma-with-cyproterone-acetate-' },
    ],
};

const BODY: Record<MonitoringNotice['kind'], string> = {
    prl: 'monitor.notice.prl',
    alt: 'monitor.notice.alt',
    k: 'monitor.notice.k',
    cpa_cumulative: 'monitor.notice.cpa_cumulative',
};

/** Every re-check interval and its source, so a reminder can name where it came from. */
const RECHECK_SOURCES: Record<RecheckReminder['kind'], { label: string; url: string }[]> = {
    liver_cpa: [
        { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/monitoring' },
    ],
    liver_bical: [
        { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/monitoring' },
        { label: 'FDA CASODEX', url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=dfee4fe7-8478-4a3e-925d-00be3cd0ab67' },
    ],
    potassium_spiro: [
        { label: 'Endocrine Society', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9562816/' },
        { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/antiandrogen/spironolactone' },
    ],
    // The interval sources. The 3-month cadence is quoted by the US HRT review and
    // the Peking University Third Hospital follow-up page; the monitoring page
    // repeats the 3-month figure for liver function. The wording of each appears in
    // the body key, not here — these entries are the labels and links only.
    estradiol: [
        { label: 'MtF.wiki · 美国HRT综述', url: 'https://mtf.wiki/zh-cn/docs/hrt/us/overview' },
        { label: 'MtF.wiki · 北医三院', url: 'https://mtf.wiki/zh-cn/docs/hrt/puth' },
        { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/monitoring' },
    ],
};

/** The trough-timing sources: the wiki's draw-before-the-next-dose line and UCSF. */
const E2_TROUGH_SOURCES: { label: string; url: string }[] = [
    { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/monitoring' },
    { label: 'UCSF', url: 'https://transcare.ucsf.edu/guidelines' },
];

const RECHECK_BODY: Record<RecheckReminder['kind'], string> = {
    liver_cpa: 'monitor.recheck.liver',
    liver_bical: 'monitor.recheck.liver',
    potassium_spiro: 'monitor.recheck.potassium',
    estradiol: 'monitor.recheck.estradiol',
};

const fmt = (n?: number) => (n === undefined ? '' : String(Math.round(n * 100) / 100));

const fill = (template: string, notice: MonitoringNotice) =>
    template
        .replace('{value}', fmt(notice.value))
        .replace('{uln}', fmt(notice.uln))
        .replace('{grams}', fmt(notice.grams));

/** `出处：MtF.wiki · FDA CASODEX` — one sentence, links inline, as the sources state it. */
const SourceLinks: React.FC<{ sources: { label: string; url: string }[]; t: (k: string) => string }> = ({ sources, t }) => (
    <p className="mon-src">
        {t('monitor.sources')}{' '}
        {sources.map((source, i) => (
            <React.Fragment key={source.url}>
                {i > 0 && <span aria-hidden> · </span>}
                <a href={source.url} target="_blank" rel="noreferrer noopener">{source.label}</a>
            </React.Fragment>
        ))}
    </p>
);

/**
 * One evidence notice — a static row: the measured value, the threshold it
 * crossed, and the source that states the threshold.
 */
export const MonitoringNoticeLine: React.FC<{ notice: MonitoringNotice; t: (k: string) => string }> = ({ notice, t }) => (
    <div className="li mon">
        <div className="mon-body" style={{ paddingTop: 14 }}>
            <p className="mon-lead">
                <SpriteIcon id="warn" />
                <span>{fill(t(BODY[notice.kind]), notice)}</span>
            </p>
            <SourceLinks sources={SOURCES[notice.kind]} t={t} />
        </div>
    </div>
);

/**
 * One due re-check: the interval that has elapsed, the dose it was counted from,
 * and the source that states the interval.
 *
 * It can be closed, because a reminder that cannot be silenced teaches people to
 * ignore reminders — but closing only collapses it to a row, and the row is still
 * there until it is dismissed, so the sources never become unreachable. The
 * dismissal is the small control on the right, persisted by the caller per due
 * date; a later interval boundary resurfaces it.
 *
 * Both facts the row has to be honest about are on screen once it is open: the
 * date the schedule was anchored to, and the interval's source. The line naming
 * the anchor's weakness is always shown rather than tucked away, because the
 * anchor is the one part of this the app has to infer. Estradiol can be anchored
 * to the last logged check, and then the copy says so instead of claiming a first
 * dose.
 */
export const RecheckReminderLine: React.FC<{
    reminder: RecheckReminder;
    t: (k: string) => string;
    /** Local-date formatter for the anchoring dose, supplied by the caller's locale. */
    formatDate: (h: number) => string;
    /** True when this due date has already been closed on this account. */
    dismissed: boolean;
    /** Persist the dismissal for this due date. */
    onDismiss: () => void;
    /** Whether initially expanded (defaults to false for compact presentation). */
    defaultExpanded?: boolean;
}> = ({ reminder, t, formatDate, dismissed, onDismiss, defaultExpanded = false }) => {
    const [open, setOpen] = useState(defaultExpanded);
    const panelId = useId();

    if (dismissed && !open) return null;

    const drugName = t(`ester.${reminder.ester}`);
    const bodyKey = reminder.kind === 'estradiol' && reminder.basis === 'last_check'
        ? 'monitor.recheck.estradiol_check'
        : RECHECK_BODY[reminder.kind];

    return (
        <div className={`li mon${open ? ' open' : ''}`}>
            <div className="mon-head">
                <button
                    type="button"
                    className="mon-btn"
                    onClick={() => setOpen(value => !value)}
                    aria-expanded={open}
                    aria-controls={panelId}
                >
                    <span className="ic am" aria-hidden="true"><SpriteIcon id="warn" /></span>
                    <div className="t">
                        <b>{t('monitor.recheck.title')}</b>
                        <span className="s">{drugName} · {formatDate(reminder.startH)}</span>
                    </div>
                    <SpriteIcon id="chev" />
                </button>
                <button
                    type="button"
                    className="icon-del"
                    onClick={onDismiss}
                    aria-label={t('monitor.recheck.dismiss')}
                >
                    <SpriteIcon id="x" />
                </button>
            </div>
            <div id={panelId} className="disclosure" data-open={open}>
                <div className="disclosure-inner">
                    <div className="mon-body">
                        <p>
                            {t(bodyKey)
                                .replace('{drug}', drugName)
                                .replace('{months}', String(reminder.intervalMonths))}
                        </p>
                        <SourceLinks sources={RECHECK_SOURCES[reminder.kind]} t={t} />
                        {reminder.kind === 'estradiol' && (
                            <>
                                <p className="mon-lead">
                                    <SpriteIcon id="warn" />
                                    <span>{t('monitor.recheck.e2_safety')}</span>
                                </p>
                                <p>
                                    {t('monitor.recheck.e2_trough')}
                                </p>
                                <SourceLinks sources={E2_TROUGH_SOURCES} t={t} />
                                {reminder.customized && (
                                    <p style={{ opacity: .8 }}>{t('monitor.recheck.custom')}</p>
                                )}
                            </>
                        )}
                        <p style={{ opacity: .9 }}>
                            {t(reminder.basis === 'last_check' ? 'monitor.recheck.basis_check' : 'monitor.recheck.basis')
                                .replace('{drug}', drugName)
                                .replace('{date}', formatDate(reminder.startH))}
                        </p>
                        <p style={{ opacity: .75 }}>
                            {t(reminder.basis === 'last_check' ? 'monitor.recheck.weakness_check' : 'monitor.recheck.weakness')}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

/**
 * The spironolactone precautions, each one a line the reference states verbatim
 * in substance (§2.2 "Dosing frequency and food" and §2.1's hyperkalemia row).
 *
 * Meal timing is deliberately absent: §2.2's last row records "whether to take
 * with food/with a meal — **not stated in the sources I checked**", and §5 gap 12
 * repeats it. "Take with food" appears in no language for that reason.
 *
 * These sit with the compound they concern — the caller renders them when the
 * person is on spironolactone — rather than as a general wall of advice.
 */
const PRECAUTIONS = [
    'monitor.precaution.food',
    'monitor.precaution.fluid',
    'monitor.precaution.combination',
    'monitor.precaution.contraindication',
] as const;

export const SpironolactonePrecautions: React.FC<{ t: (k: string) => string }> = ({ t }) => {
    const [open, setOpen] = useState(false);
    const panelId = useId();

    return (
        <div className={`li mon${open ? ' open' : ''}`}>
            <div className="mon-head">
                <button
                    type="button"
                    className="mon-btn"
                    onClick={() => setOpen(value => !value)}
                    aria-expanded={open}
                    aria-controls={panelId}
                >
                    <span className="ic" aria-hidden="true"><SpriteIcon id="info" /></span>
                    <div className="t">
                        <b>{t('monitor.precaution.title')}</b>
                        <span className="s">{t('monitor.hint')}</span>
                    </div>
                    <SpriteIcon id="chev" />
                </button>
            </div>
            <div id={panelId} className="disclosure" data-open={open}>
                <div className="disclosure-inner">
                    <div className="mon-body">
                        <ul className="mon-list">
                            {PRECAUTIONS.map(key => <li key={key}>{t(key)}</li>)}
                        </ul>
                        <SourceLinks
                            t={t}
                            sources={[
                                { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/antiandrogen/spironolactone' },
                                { label: 'Endocrine Society', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9562816/' },
                            ]}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MonitoringNoticeLine;
