import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { DoseEvent, LabResult, Ester, isTestosteroneEster, isT_LabUnit, isMonitoringOnlyLab, monitoringValues, MONITORING_UNIT } from '../../logic';

/**
 * The compound a record names, for the CSV's "item" column.
 *
 * Every non-estrogen used to land in the final `else` and be exported as
 * "Estradiol", so a logged spironolactone dose would have been written into a CSV
 * as estradiol. Exhaustive by way of a `switch` on the enum: adding a compound now
 * fails the type check here instead of silently returning a wrong name.
 */
const exportCompoundName = (ester: Ester): string => {
    switch (ester) {
        case Ester.SPIRO: return 'Spironolactone';
        case Ester.BICAL: return 'Bicalutamide';
        case Ester.CPA: return 'Cyproterone Acetate';
        case Ester.T:
        case Ester.TC:
        case Ester.TE:
        case Ester.TU:
            return 'Testosterone';
        case Ester.E2:
        case Ester.EB:
        case Ester.EV:
        case Ester.EC:
        case Ester.EN:
        case Ester.EU:
            return 'Estradiol';
    }
};
import { formatDate } from '../utils/helpers';
import { Lang, TRANSLATIONS } from '../i18n/translations';

// Define the type for user-friendly export data
interface ExportData {
    events: DoseEvent[];
    labResults: LabResult[];
    weight: number;
    lang: Lang;
    t: (key: string) => string;
}

export const exportToCSV = (data: ExportData): string => {
    const { events, labResults, lang, t } = data;
    const rows = [];

    // Header
    rows.push([
        t('export.col.type'),
        t('export.col.date'),
        t('export.col.item'),
        t('export.col.value'),
        t('export.col.unit'),
        t('export.col.route_ester')
    ]);

    // Events
    events.forEach(e => {
        const date = formatDate(new Date(e.timeH * 3600000), lang);
        rows.push([
            t('export.val.dose'),
            date,
            exportCompoundName(e.ester),
            e.doseMG,
            'mg',
            `${e.route} - ${e.ester}`
        ]);
    });

    // Labs. A result may carry an E2/T reading, monitoring bloods, or both, so each
    // analyte gets its own row rather than being folded into one line.
    labResults.forEach(l => {
        const date = formatDate(new Date(l.timeH * 3600000), lang);
        if (!isMonitoringOnlyLab(l)) {
            rows.push([
                t('export.val.lab'),
                date,
                isT_LabUnit(l.unit) ? 'Testosterone' : 'Estradiol',
                l.concValue,
                l.unit,
                '-'
            ]);
        }
        for (const mv of monitoringValues(l)) {
            rows.push([
                t('export.val.lab'),
                date,
                t(`monitor.${mv.analyte.toLowerCase()}`),
                mv.value,
                MONITORING_UNIT[mv.analyte],
                mv.uln !== undefined ? `${t('monitor.uln')} ${mv.uln}` : '-'
            ]);
        }
    });

    return rows.map(r => r.join(',')).join('\n');
};

const sortByDateDescending = <T extends { timeH: number }>(items: T[]): T[] =>
    items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => b.item.timeH - a.item.timeH || a.index - b.index)
        .map(({ item }) => item);

export const getLabTestLabel = (labResult: LabResult): 'E2' | 'T' =>
    isT_LabUnit(labResult.unit) ? 'T' : 'E2';

export const buildPDFDocument = (data: ExportData, generatedAt = new Date()) => {
    const { events, labResults } = data;
    // Force English for PDF to avoid font issues with non-Latin characters
    const safeLang = 'en';
    const tSafe = (key: string) => (TRANSLATIONS.en as any)[key] || key;

    const doc = new jsPDF();

    // Title
    doc.setFontSize(18);
    doc.text(tSafe('export.pdf.title'), 14, 22);
    doc.setFontSize(11);
    doc.text(`${tSafe('export.pdf.generated_on')} ${generatedAt.toLocaleDateString('en-US')}`, 14, 30);

    // --- Events Table ---
    doc.setFontSize(14);
    doc.text(tSafe('export.pdf.history'), 14, 45);

    const eventRows = sortByDateDescending(events).map(e => [
        formatDate(new Date(e.timeH * 3600000), safeLang as Lang),
        `${e.doseMG} mg`,
        e.route,
        e.ester
    ]);

    autoTable(doc, {
        startY: 50,
        head: [['Date', 'Dose', 'Route', 'Ester']],
        body: eventRows,
    });

    // --- Labs Table ---
    // @ts-ignore - autoTable adds lastAutoTable property
    const finalY = doc.lastAutoTable.finalY || 50;

    doc.setFontSize(14);
    doc.text(tSafe('export.pdf.labs'), 14, finalY + 15);

    const labRows = labResults.flatMap(l => {
        const date = formatDate(new Date(l.timeH * 3600000), safeLang as Lang);
        const rows: string[][] = [];
        if (!isMonitoringOnlyLab(l)) rows.push([date, getLabTestLabel(l), `${l.concValue} ${l.unit}`]);
        for (const mv of monitoringValues(l)) {
            rows.push([date, tSafe(`monitor.${mv.analyte.toLowerCase()}`), `${mv.value} ${MONITORING_UNIT[mv.analyte]}`]);
        }
        return rows;
    });

    autoTable(doc, {
        startY: finalY + 20,
        head: [['Date', 'Test', 'Level']],
        body: labRows,
    });

    return doc;
};

export const exportToPDF = (data: ExportData) => {
    const generatedAt = new Date();
    const doc = buildPDFDocument(data, generatedAt);

    doc.save(`hrt-report-${generatedAt.toISOString().split('T')[0]}.pdf`);
};
