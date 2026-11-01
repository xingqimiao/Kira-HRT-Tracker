import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';

/** Package-specific measurements, not treatment recommendations. */
export default function GelDoseReference() {
    const { t } = useTranslation();
    const rows = [
        [`Oestrogel® (爱斯妥) · ${t('gel.reference.chinatube')} · 0.06% · 30 g / 80 g`, 'ruler', '2.5 g', '1.5 mg', 'https://tfsci.mtf.wiki/zh-cn/misc/oestrogel/'],
        ['健民 · 0.06% · 40 g', 'ruler', '2.5 g', '1.5 mg', 'https://tfsci.mtf.wiki/zh-cn/misc/estradiol-gel-jianmin/'],
        ['EstroGel® · US', 'pump', '1.25 g', '0.75 mg', 'https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/021166Orig1s020lbl.pdf'],
        ['Gynokadin® · Germany', 'pump', '1.25 g', '0.75 mg', 'https://www.fachinfo.de/fi/pdf/001638'],
        ['Oestraclin® · Spain', 'applicator', '2.5 g', '1.5 mg', 'https://cima.aemps.es/cima/dochtml/p/59577/Prospecto_59577.html'],
        ['Organon Estrogel® · Canada', 'pump', '1.25 g', '0.75 mg', 'https://www.organon.com/canada-en/estrogel-pm_e/'],
        ['Estreva® · 0.1%', 'pump', '0.5 g', '0.5 mg', 'https://base-donnees-publique.medicaments.gouv.fr/medicament/63216075/extrait'],
        ['Sandrena® · 0.5 mg', 'sachet', '0.5 g', '0.5 mg', 'https://www.medicines.org.uk/emc/product/2219/pil'],
        ['Sandrena® · 1 mg', 'sachet', '1 g', '1 mg', 'https://www.medicines.org.uk/emc/product/2219/pil'],
    ];
    return (
        <details className="li col-li">
            <summary style={{ cursor: 'pointer', minHeight: 48, display: 'flex', alignItems: 'center' }}>{t('gel.reference.title')}</summary>
            <p className="s">{t('gel.reference.note')}</p>
            <dl style={{ width: '100%', margin: 0 }}>
                {rows.map(([name, unit, amount, active, url]) => (
                    <div key={name} style={{ padding: '8px 0', borderBottom: '1px solid var(--outline-variant, currentColor)' }}>
                        <dt><a href={url} target="_blank" rel="noreferrer">{name}</a></dt>
                        <dd className="s" style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.5 }}>{t(`gel.reference.${unit}`)} · {t('gel.reference.gel')} {amount} · {t('gel.reference.active')} {active}</dd>
                    </div>
                ))}
            </dl>
        </details>
    );
}
