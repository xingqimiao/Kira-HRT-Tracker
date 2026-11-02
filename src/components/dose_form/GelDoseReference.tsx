import React, { useMemo, useState } from 'react';
import Icon from '../Icon';
import { useTranslation } from '../../contexts/LanguageContext';
import { ExternalLink } from '../../icons';
import { Icon as SpriteIcon } from '../../ui/SvgDefs';

/**
 * Package measurements, as a converter.
 *
 * This is not a reference table to read: the numbers exist so a dose can be entered
 * in units the label prints. Each row's pill fills the dose field with that unit's
 * estradiol amount, times the multiplier above it, and the product used most recently
 * is pinned to the top on the next open (local only — it is a habit, not account data).
 */

interface GelRow {
    id: string;
    name: string;
    /** Where the package is sold, when that is what identifies it. */
    region?: string;
    /** Concentration or per-sachet strength. */
    strength?: string;
    unit: 'ruler' | 'pump' | 'applicator' | 'sachet';
    /** Gel weight delivered by one unit of `unit`. */
    gel: string;
    /** Estradiol in that one unit, before the multiplier. */
    mg: number;
    url: string;
}

const ROWS: GelRow[] = [
    { id: 'oestrogel-cn', name: 'Oestrogel® (爱斯妥)', region: 'CN', strength: '0.06%', unit: 'ruler', gel: '2.5 g', mg: 1.5, url: 'https://tfsci.mtf.wiki/zh-cn/misc/oestrogel/' },
    { id: 'jianmin', name: '健民', strength: '0.06%', unit: 'ruler', gel: '2.5 g', mg: 1.5, url: 'https://tfsci.mtf.wiki/zh-cn/misc/estradiol-gel-jianmin/' },
    { id: 'estrogel-us', name: 'EstroGel®', region: 'US', strength: '0.06%', unit: 'pump', gel: '1.25 g', mg: 0.75, url: 'https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/021166Orig1s020lbl.pdf' },
    { id: 'gynokadin', name: 'Gynokadin®', region: 'DE', strength: '0.06%', unit: 'pump', gel: '1.25 g', mg: 0.75, url: 'https://www.fachinfo.de/fi/pdf/001638' },
    { id: 'oestraclin', name: 'Oestraclin®', region: 'ES', strength: '0.06%', unit: 'applicator', gel: '2.5 g', mg: 1.5, url: 'https://cima.aemps.es/cima/dochtml/p/59577/Prospecto_59577.html' },
    { id: 'organon-ca', name: 'Organon Estrogel®', region: 'CA', strength: '0.06%', unit: 'pump', gel: '1.25 g', mg: 0.75, url: 'https://www.organon.com/canada-en/estrogel-pm_e/' },
    { id: 'estreva', name: 'Estreva®', strength: '0.1%', unit: 'pump', gel: '0.5 g', mg: 0.5, url: 'https://base-donnees-publique.medicaments.gouv.fr/medicament/63216075/extrait' },
    { id: 'sandrena-05', name: 'Sandrena®', strength: '0.5 mg', unit: 'sachet', gel: '0.5 g', mg: 0.5, url: 'https://www.medicines.org.uk/emc/product/2219/pil' },
    { id: 'sandrena-1', name: 'Sandrena®', strength: '1 mg', unit: 'sachet', gel: '1 g', mg: 1, url: 'https://www.medicines.org.uk/emc/product/2219/pil' },
];

const MULTIPLIERS = [0.5, 1, 2] as const;
const FAVOURITE_KEY = 'hrt-gel-ref-last';
const COLLAPSED_ROWS = 4;

function readFavourite(): string | null {
    try {
        return localStorage.getItem(FAVOURITE_KEY);
    } catch {
        return null;
    }
}

const formatMg = (value: number) => `${Number(value.toFixed(3))} mg`;

export default function GelDoseReference({ onPick, onExpandedChange }: {
    onPick?: (mg: number) => void;
    /** Lets the form re-flow the sections below when the full list opens. */
    onExpandedChange?: (open: boolean) => void;
}) {
    const { t } = useTranslation();
    const [favourite, setFavourite] = useState<string | null>(readFavourite);
    const [multiplier, setMultiplier] = useState<number>(1);
    const [showAll, setShowAll] = useState(false);

    // The last product used goes first: on a repeat dose it is almost always the same
    // tube, and scrolling past eight others to find it is the whole cost of this panel.
    const rows = useMemo(() => {
        if (!favourite) return ROWS;
        return [...ROWS].sort((a, b) => (b.id === favourite ? 1 : 0) - (a.id === favourite ? 1 : 0));
    }, [favourite]);

    const visible = showAll ? rows : rows.slice(0, COLLAPSED_ROWS);

    const pick = (row: GelRow) => {
        setFavourite(row.id);
        try {
            localStorage.setItem(FAVOURITE_KEY, row.id);
        } catch {
            // Private mode: the pin just does not survive a reload.
        }
        onPick?.(Number((row.mg * multiplier).toFixed(3)));
    };

    return (
        <div className="li col-li m3e-gelref">
            <div className="m3e-gelref-head">
                <div className="m3e-gelref-title">
                    <span className="ic p" aria-hidden="true"><SpriteIcon id="gel" /></span>
                    <div>
                        <div className="t">{t('gel.reference.title')}</div>
                        <div className="s">{t('gel.reference.short_note')}</div>
                    </div>
                </div>
                <div className="m3e-gelref-mult" role="group" aria-label={t('gel.reference.title')}>
                    {MULTIPLIERS.map(m => (
                        <button
                            key={m}
                            type="button"
                            className={multiplier === m ? 'on' : ''}
                            aria-pressed={multiplier === m}
                            onClick={() => setMultiplier(m)}
                        >
                            ×{m}
                        </button>
                    ))}
                </div>
            </div>

            <ul className="m3e-gelref-list" role="list">
                {visible.map(row => (
                    <li key={row.id} className={row.id === favourite ? 'fav' : ''}>
                        <div className="m3e-gelref-meta">
                            <div className="m3e-gelref-name">{row.name}</div>
                            <div className="m3e-gelref-badges">
                                {row.region && <span className="m3e-gelref-badge">{row.region}</span>}
                                {row.strength && <span className="m3e-gelref-badge">{row.strength}</span>}
                                <a
                                    className="m3e-gelref-src"
                                    href={row.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label={`${row.name} ↗`}
                                >
                                    <Icon icon={ExternalLink} size={12} />
                                </a>
                            </div>
                        </div>
                        <button
                            type="button"
                            className="m3e-gelref-pill"
                            onClick={() => pick(row)}
                            aria-label={`${row.name} · ${formatMg(row.mg * multiplier)}`}
                        >
                            1 {t(`gel.unit.${row.unit}`)}
                            <span className="dim">({row.gel})</span>
                            <span className="arrow" aria-hidden="true">→</span>
                            <b>{formatMg(row.mg * multiplier)}</b>
                        </button>
                    </li>
                ))}
            </ul>

            {rows.length > COLLAPSED_ROWS && (
                <button type="button" className="m3e-gelref-more" onClick={() => { const next = !showAll; setShowAll(next); onExpandedChange?.(next); }}>
                    {t(showAll ? 'gel.reference.collapse' : 'gel.reference.show_all').replace('{n}', String(rows.length))}
                </button>
            )}

            <p className="m3e-gelref-note">{t('gel.reference.note')}</p>
        </div>
    );
}
