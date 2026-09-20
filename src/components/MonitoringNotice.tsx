import React from 'react';
import Icon from './Icon';
import { AlertCircle, ExternalLink } from '../icons';
import { MonitoringNotice } from '../../logic';

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

export default MonitoringNoticeLine;
