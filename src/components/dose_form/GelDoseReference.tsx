import React, { useMemo, useState } from 'react';
import Icon from '../Icon';
import { useTranslation } from '../../contexts/LanguageContext';
import { ExternalLink } from '../../icons';
import { Icon as SpriteIcon } from '../../ui/SvgDefs';
import { AdaptiveSheet, useMediaQuery } from '../../ui/proto';

/**
 * Package measurements as a converter.
 *
 * The numbers exist so a dose can be entered the way the label prints it, so a row is
 * an action, not a line of documentation: it fills the dose field with that unit's
 * estradiol amount times the multiplier. Rows that measure identically are merged —
 * one row per measurement, with the brands that share it listed underneath — and the
 * list is ordered by where the device is, so the package the person can buy comes first.
 *
 * Collapsed, the card is a single row. On a phone the list opens as a bottom sheet and
 * the choice only lands when 使用 is pressed; a cancelled sheet changes nothing. On a
 * wide screen it opens in place, because there is room for it.
 */

interface GelRow {
    id: string;
    /** The name to lead with; the other brands sharing this measurement follow. */
    name: string;
    /** Other products with the identical measurement, shown under the name. */
    alsoSoldAs?: string;
    /** Where the package is sold — also the ordering key. */
    regions: string[];
    strength?: string;
    unit: 'ruler' | 'pump' | 'applicator' | 'sachet';
    /** Gel weight delivered by one unit. */
    gel: string;
    /** Estradiol in that one unit, before the multiplier. */
    mg: number;
    /** Whether half a dispenser is offered as its own quick choice. */
    half?: boolean;
    url: string;
}

/**
 * One row per measurement. 爱斯妥 (China) and 健民 are the same tube; EstroGel,
 * Gynokadin and Organon Estrogel are the same 1.25 g pump.
 */
const ROWS: GelRow[] = [
    {
        id: 'cn-tube',
        name: '爱斯妥 / 健民',
        regions: ['CN'],
        strength: '0.06%',
        unit: 'ruler', gel: '2.5 g', mg: 1.5, half: true,
        url: 'https://tfsci.mtf.wiki/zh-cn/misc/oestrogel/',
    },
    {
        id: 'us-de-ca-pump',
        name: 'EstroGel®',
        alsoSoldAs: 'Gynokadin® · Organon Estrogel®',
        regions: ['US', 'DE', 'CA'],
        strength: '0.06%',
        unit: 'pump', gel: '1.25 g', mg: 0.75,
        url: 'https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/021166Orig1s020lbl.pdf',
    },
    {
        id: 'es-applicator',
        name: 'Oestraclin®',
        regions: ['ES'],
        strength: '0.06%',
        unit: 'applicator', gel: '2.5 g', mg: 1.5,
        url: 'https://cima.aemps.es/cima/dochtml/p/59577/Prospecto_59577.html',
    },
    {
        id: 'fr-pump',
        name: 'Estreva®',
        regions: ['FR'],
        strength: '0.1%',
        unit: 'pump', gel: '0.5 g', mg: 0.5,
        url: 'https://base-donnees-publique.medicaments.gouv.fr/medicament/63216075/extrait',
    },
    {
        id: 'gb-sachet-05',
        name: 'Sandrena®',
        regions: ['GB'],
        strength: '0.5 mg',
        unit: 'sachet', gel: '0.5 g', mg: 0.5,
        url: 'https://www.medicines.org.uk/emc/product/2219/pil',
    },
    {
        id: 'gb-sachet-1',
        name: 'Sandrena®',
        regions: ['GB'],
        strength: '1 mg',
        unit: 'sachet', gel: '1 g', mg: 1,
        url: 'https://www.medicines.org.uk/emc/product/2219/pil',
    },
];

const MULTIPLIERS = [1, 2, 3] as const;

/** Timezone → the country whose package is on the shelf. */
const TZ_REGION: Array<[string, string]> = [
    ['Asia/Shanghai', 'CN'], ['Asia/Chongqing', 'CN'], ['Asia/Urumqi', 'CN'],
    ['Asia/Hong_Kong', 'CN'], ['Asia/Macau', 'CN'], ['Asia/Taipei', 'CN'],
    ['Europe/Berlin', 'DE'], ['Europe/Vienna', 'DE'], ['Europe/Zurich', 'DE'],
    ['Europe/Madrid', 'ES'],
    ['Europe/Paris', 'FR'],
    ['Europe/London', 'GB'], ['Europe/Dublin', 'GB'], ['Europe/Lisbon', 'GB'],
    ['America/Toronto', 'CA'], ['America/Vancouver', 'CA'], ['America/Montreal', 'CA'],
    ['America/Edmonton', 'CA'], ['America/Winnipeg', 'CA'], ['America/Halifax', 'CA'],
];

/** The region to sort to the top: timezone first, then the UI language. */
function preferredRegion(): string | null {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const match = TZ_REGION.find(([prefix]) => zone === prefix || zone.startsWith(`${prefix}/`));
        if (match) return match[1];
        if (zone.startsWith('America/')) return 'US';
    } catch {
        // No Intl: fall through to the language.
    }
    const lang = (navigator.language || '').toUpperCase();
    if (lang.startsWith('ZH')) return 'CN';
    if (lang.startsWith('DE')) return 'DE';
    if (lang.startsWith('ES')) return 'ES';
    if (lang.startsWith('FR')) return 'FR';
    if (lang.startsWith('EN-GB')) return 'GB';
    if (lang.startsWith('EN-CA')) return 'CA';
    if (lang.startsWith('EN')) return 'US';
    return null;
}

const formatMg = (value: number) => `${Number(value.toFixed(3))} mg`;

export default function GelDoseReference({ onPick, onExpandedChange }: {
    onPick?: (mg: number) => void;
    /** Lets the form re-flow the sections below when the full list opens. */
    onExpandedChange?: (open: boolean) => void;
}) {
    const { t } = useTranslation();
    const desktop = useMediaQuery('(min-width: 760px)');

    const rows = useMemo(() => {
        const region = preferredRegion();
        if (!region) return ROWS;
        // Stable: inside the preferred group the authored order still holds.
        return ROWS
            .map((row, index) => ({ row, index, rank: row.regions.includes(region) ? 0 : 1 }))
            .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
            .map(entry => entry.row);
    }, []);

    const [open, setOpen] = useState(false);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [multiplier, setMultiplier] = useState<number>(1);
    /** What is currently applied to the dose field. */
    const [selected, setSelected] = useState<string | null>(null);
    /** What the sheet is about to apply — nothing happens until 使用. */
    const [pending, setPending] = useState<string | null>(null);

    const label = t('gel.reference.title');

    /**
     * A row id, or `<id>:half` for half a dispenser. One string keeps the "what is
     * selected" state a single value on both layouts.
     */
    const HALF = ':half';
    const mgFor = (id: string | null) => {
        if (!id) return null;
        const half = id.endsWith(HALF);
        const row = rows.find(r => r.id === (half ? id.slice(0, -HALF.length) : id));
        return row ? Number((row.mg * (half ? 0.5 : 1) * multiplier).toFixed(3)) : null;
    };

    const toggleOpen = () => {
        const next = !open;
        setOpen(next);
        onExpandedChange?.(next);
    };

    const openSheet = () => {
        setPending(selected);
        setSheetOpen(true);
    };

    const chooseMultiplier = (value: number) => {
        setMultiplier(value);
        // A different number of units is a different dose: keep an applied choice in
        // step instead of leaving the field on the old multiple.
        if (selected) {
            const half = selected.endsWith(HALF);
            const row = rows.find(r => r.id === (half ? selected.slice(0, -HALF.length) : selected));
            if (row) onPick?.(Number((row.mg * (half ? 0.5 : 1) * value).toFixed(3)));
        }
    };

    /** Desktop: selecting applies; selecting the same choice again lets go of it. */
    const pickInline = (id: string) => {
        if (selected === id) {
            setSelected(null);
            return;
        }
        setSelected(id);
        const mg = mgFor(id);
        if (mg !== null) onPick?.(mg);
    };

    const closeSheet = () => {
        setSheetOpen(false);
        setPending(selected);
    };

    const applySheet = () => {
        if (!pending) return;
        const mg = mgFor(pending);
        setSelected(pending);
        if (mg !== null) onPick?.(mg);
        setSheetOpen(false);
    };

    const rowNode = (row: GelRow, activeId: string | null, onPickId: (id: string) => void) => {
        const halfId = `${row.id}${HALF}`;
        const rowActive = activeId === row.id;
        const halfActive = activeId === halfId;
        return (
        <li key={row.id} className={rowActive ? 'fav' : ''}>
            <div className="m3e-gelref-meta">
                <div className="m3e-gelref-name">{row.name}</div>
                <div className="m3e-gelref-badges">
                    {row.regions.map(code => <span key={code} className="m3e-gelref-badge">{code}</span>)}
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
                {row.alsoSoldAs && <div className="m3e-gelref-also">{row.alsoSoldAs}</div>}
            </div>
            <div className="m3e-gelref-actions">
                {/* Half a dispenser is a legitimate dose and not a multiple of one, so it
                    sits immediately before the pill it modifies; the label is
                    locale-specific, hence the width floor (a circle for 半, a capsule
                    for Half). */}
                {row.half && (
                    <button
                        type="button"
                        className="m3e-gelref-half"
                        aria-pressed={halfActive}
                        aria-label={`${row.name} · ${t('gel.reference.half')} · ${formatMg(row.mg * 0.5 * multiplier)}`}
                        onClick={() => onPickId(halfId)}
                    >
                        {t('gel.reference.half')}
                    </button>
                )}
                <button
                    type="button"
                    className="m3e-gelref-pill"
                    aria-pressed={rowActive}
                    onClick={() => onPickId(row.id)}
                    aria-label={`${multiplier} ${t(`gel.unit.${row.unit}`)} · ${formatMg(row.mg * multiplier)}`}
                >
                    {multiplier} {t(`gel.unit.${row.unit}`)}
                    <span className="dim">({row.gel})</span>
                    <span className="arrow" aria-hidden="true">→</span>
                    <b>{formatMg(row.mg * multiplier)}</b>
                </button>
            </div>
        </li>
        );
    };

    const multiplierChips = (
        <div className="m3e-gelref-mult" role="group" aria-label={label}>
            {MULTIPLIERS.map(m => (
                <button
                    key={m}
                    type="button"
                    className={multiplier === m ? 'on' : ''}
                    aria-pressed={multiplier === m}
                    onClick={() => chooseMultiplier(m)}
                >
                    {m}×
                </button>
            ))}
        </div>
    );

    return (
        <div className="li col-li m3e-gelref">
            <button
                type="button"
                className="m3e-gelref-head"
                aria-expanded={desktop ? open : undefined}
                onClick={desktop ? toggleOpen : openSheet}
            >
                <div className="m3e-gelref-title">
                    <span className="ic p" aria-hidden="true"><SpriteIcon id="gel" /></span>
                    <div>
                        <div className="t">{label}</div>
                        {/* While the list is open the warning sits next to the multiplier,
                            so printing it here as well would say it twice on one screen. */}
                        {!(desktop && open) && <div className="s">{t('gel.reference.short_note')}</div>}
                    </div>
                </div>
                {desktop
                    ? <SpriteIcon id="down" className={open ? 'i m3e-gelref-chev up' : 'i m3e-gelref-chev'} />
                    : <SpriteIcon id="chev" />}
            </button>

            {desktop && open && (
                <>
                    <div className="m3e-gelref-sheet-head">
                        <span className="m3e-gelref-note">{t('gel.reference.short_note')}</span>
                        {multiplierChips}
                    </div>
                    <ul className="m3e-gelref-list" role="list">
                        {rows.map(row => rowNode(row, selected, pickInline))}
                    </ul>
                    <p className="m3e-gelref-note">{t('gel.reference.note_detail')}</p>
                </>
            )}

            <AdaptiveSheet
                open={desktop ? false : sheetOpen}
                onClose={closeSheet}
                title={label}
                closeLabel={t('btn.close')}
                footer={(
                    <div className="m3e-gelref-sheet-actions">
                        <button type="button" className="btn" disabled={!pending} onClick={applySheet}>
                            {t('gel.reference.use')}
                        </button>
                    </div>
                )}
            >
                <div className="m3e-gelref-sheet-head">
                    <span className="m3e-gelref-note">{t('gel.reference.short_note')}</span>
                    {multiplierChips}
                </div>
                <ul className="m3e-gelref-list" role="list">
                    {rows.map(row => rowNode(row, pending, (id) => setPending(p => (p === id ? null : id))))}
                </ul>
            </AdaptiveSheet>
        </div>
    );
}
