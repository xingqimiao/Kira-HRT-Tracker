import React, { useState } from 'react';
import Icon from './Icon';
import { AlertCircle, AlertTriangle, CircleOff, Droplet, ExternalLink, Info, X } from '../icons';
import { MonitoringNotice, RecheckReminder, Ester } from '../../logic';

/**
 * One monitoring notice: the measured value, the threshold it crossed, and the
 * source that states that threshold.
 *
 * The posture is deliberate and the same everywhere — this reports what the
 * sources say, it does not tell anyone what to do. The copy names the source and
 * links to it rather than compressing it into an instruction, which is why the
 * MRI recommendation at 10 g of CPA reads as "MtF.wiki's recommendation is an
 * MRI" and not "get an MRI".
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

const fmt = (n?: number) => (n === undefined ? '' : String(Math.round(n * 100) / 100));

const fill = (template: string, notice: MonitoringNotice) =>
    template
        .replace('{value}', fmt(notice.value))
        .replace('{uln}', fmt(notice.uln))
        .replace('{grams}', fmt(notice.grams));

export const MonitoringNoticeLine: React.FC<{ notice: MonitoringNotice; t: (k: string) => string }> = ({ notice, t }) => (
    <p className="flex items-start gap-1.5 text-m3-body-compact leading-snug text-cos-warning/90">
        <Icon icon={AlertCircle} size={14} strokeWidth={1.75} className="mt-[3px] shrink-0" />
        <span>
            {fill(t(BODY[notice.kind]), notice)}{' '}
            <span className="opacity-70">{t('monitor.sources')}</span>{' '}
            {SOURCES[notice.kind].map((source, i) => (
                <React.Fragment key={source.url}>
                    {i > 0 && <span className="opacity-70"> · </span>}
                    <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-0.5 underline underline-offset-2"
                    >
                        {source.label}
                        <Icon icon={ExternalLink} size={11} strokeWidth={2} />
                    </a>
                </React.Fragment>
            ))}
        </span>
    </p>
);

/**
 * The sources behind each re-check interval, so the reminder can name the row it
 * came from the way the value notices above do.
 *
 * These are the intervals docs/monitoring-reference.md actually states — liver
 * on CPA and bicalutamide (§1.1 row 1, §4 "Liver function"), potassium on
 * spironolactone (§2.1, Endocrine Society). Prolactin has no interval anywhere in
 * that document, so there is no branch for it: a source-less cadence is exactly
 * the thing not to invent.
 */
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

const SourceLinks: React.FC<{ sources: { label: string; url: string }[] }> = ({ sources }) => (
    <>
        {sources.map((source, i) => (
            <React.Fragment key={source.url}>
                {i > 0 && <span className="opacity-70"> · </span>}
                <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-0.5 underline underline-offset-2"
                >
                    {source.label}
                    <Icon icon={ExternalLink} size={11} strokeWidth={2} />
                </a>
            </React.Fragment>
        ))}
    </>
);

/**
 * One re-check reminder: the interval that has elapsed, the recorded dose it was
 * counted from, and the source that states the interval.
 *
 * This is the same posture as `MonitoringNoticeLine` and deliberately so — it
 * says a draw is *due*, never that anything is wrong. The two facts it has to
 * carry for that to be honest are both on screen: which dose the schedule was
 * anchored to (with its date), and the interval's source. The line that names the
 * first-logged-dose weakness is always shown rather than tucked away, because the
 * anchor is the one part of this the app has to guess at.
 *
 * It can be closed, because a reminder that cannot be silenced teaches people to
 * ignore reminders — but closing only collapses it to a row that opens it again,
 * so dismissing never puts the sources out of reach. The dismissal is persisted by
 * the caller per due date; a later interval boundary resurfaces it.
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
}> = ({ reminder, t, formatDate, dismissed, onDismiss }) => {
    // A re-open is local, not a change of the stored dismissal: reading the
    // sources again is not the same as asking for the reminder to return, so a
    // reload puts the row back in the shape the user left it.
    const [reopened, setReopened] = useState(false);

    if (dismissed && !reopened) {
        return (
            <button
                type="button"
                onClick={() => setReopened(true)}
                className="flex items-start gap-1.5 text-start text-m3-body-compact leading-snug text-[var(--color-m3-on-surface-variant)] hover:text-[var(--color-m3-on-surface)]"
            >
                <Icon icon={AlertTriangle} size={14} strokeWidth={1.75} className="mt-[3px] shrink-0" />
                <span>
                    <span className="font-semibold text-[var(--color-m3-on-surface)] underline decoration-[var(--color-m3-outline-variant)] underline-offset-2">
                        {t('monitor.recheck.title')}
                    </span>{' '}
                    <span className="opacity-70">{t('monitor.recheck.show')}</span>
                </span>
            </button>
        );
    }

    return (
        <div className="flex items-start gap-1.5 text-m3-body-compact leading-snug text-[var(--color-m3-on-surface-variant)]">
            <Icon icon={AlertTriangle} size={14} strokeWidth={1.75} className="mt-[3px] shrink-0" />
            <div className="min-w-0 flex-1">
                <p className="font-semibold text-[var(--color-m3-on-surface)]">
                    {t('monitor.recheck.title')}
                </p>
                <p className="mt-0.5">
                    {t(RECHECK_BODY[reminder.kind])
                        .replace('{drug}', t(`ester.${reminder.ester}`))
                        .replace('{months}', String(reminder.intervalMonths))}{' '}
                    <span className="opacity-70">{t('monitor.sources')}</span>{' '}
                    <SourceLinks sources={RECHECK_SOURCES[reminder.kind]} />
                </p>
                {/* Estradiol carries two things the other reminders do not: when to
                    take the draw, and the clinician line. Both are shown in the body
                    rather than a footnote — the safety line first, because low
                    estradiol and mood are why someone opens this, and the answer is a
                    doctor rather than a number. */}
                {reminder.kind === 'estradiol' && (
                    <>
                        <p className="mt-1 flex items-start gap-1.5 font-medium text-cos-warning">
                            <Icon icon={AlertCircle} size={13} strokeWidth={2} className="mt-[3px] shrink-0" />
                            <span>{t('monitor.recheck.e2_safety')}</span>
                        </p>
                        {/* The 3-month claim's own wording, quoted rather than
                            paraphrased, under the source links printed with the body. */}
                        <p className="mt-0.5 opacity-80">{t('monitor.recheck.e2_interval')}</p>
                        <p className="mt-0.5">
                            {t('monitor.recheck.e2_trough')}{' '}
                            <span className="opacity-70">{t('monitor.sources')}</span>{' '}
                            <SourceLinks sources={E2_TROUGH_SOURCES} />
                        </p>
                        {reminder.customized && (
                            <p className="mt-0.5 opacity-70">{t('monitor.recheck.custom')}</p>
                        )}
                    </>
                )}
                <p className="mt-0.5 opacity-80">
                    {t('monitor.recheck.basis')
                        .replace('{drug}', t(`ester.${reminder.ester}`))
                        .replace('{date}', formatDate(reminder.startH))}
                </p>
                <p className="mt-0.5 opacity-70">{t('monitor.recheck.weakness')}</p>
            </div>
            {/* Always writes the dismissal (a no-op when it is already stored),
                then collapses a re-opened row. */}
            <button
                type="button"
                onClick={() => { onDismiss(); setReopened(false); }}
                aria-label={t('monitor.recheck.dismiss')}
                className="-mr-1 mt-0.5 shrink-0 rounded-full p-1 text-[var(--color-m3-on-surface-variant)] hover:bg-[var(--color-m3-surface-container)] hover:text-[var(--color-m3-on-surface)]"
            >
                <Icon icon={X} size={14} strokeWidth={2} />
            </button>
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
 * These sit with the compound they concern — the caller renders them on the
 * spironolactone context — rather than as a general wall of advice.
 */
const PRECAUTIONS: { key: string; icon: typeof Info }[] = [
    { key: 'monitor.precaution.food', icon: CircleOff },
    { key: 'monitor.precaution.fluid', icon: Droplet },
    { key: 'monitor.precaution.combination', icon: CircleOff },
    { key: 'monitor.precaution.contraindication', icon: AlertCircle },
];

export const SpironolactonePrecautions: React.FC<{ t: (k: string) => string }> = ({ t }) => (
    <div className="text-m3-body-compact leading-snug text-[var(--color-m3-on-surface-variant)]">
        <p className="font-semibold text-[var(--color-m3-on-surface)]">{t('monitor.precaution.title')}</p>
        <ul className="mt-1 space-y-1">
            {PRECAUTIONS.map(({ key, icon }) => (
                <li key={key} className="flex items-start gap-1.5">
                    <Icon icon={icon} size={13} strokeWidth={1.75} className="mt-[3px] shrink-0 opacity-70" />
                    <span>{t(key)}</span>
                </li>
            ))}
        </ul>
        <p className="mt-1">
            <span className="opacity-70">{t('monitor.sources')}</span>{' '}
            <SourceLinks
                sources={[
                    { label: 'MtF.wiki', url: 'https://mtf.wiki/zh-cn/docs/medicine/antiandrogen/spironolactone' },
                    { label: 'Endocrine Society', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9562816/' },
                ]}
            />
        </p>
    </div>
);

export default MonitoringNoticeLine;
