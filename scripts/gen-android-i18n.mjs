// Generates the Android string resources for the six non-English locales.
//
//   node scripts/gen-android-i18n.mjs
//
// The web build already ships seven translated packs. Rather than hand-writing a
// second translation set, this maps each Android resource name onto the web key
// that says the same thing and copies the value across. Keys the web pack does
// not carry are skipped, so a locale file only ever contains real translations —
// the English `values/strings.xml` stays the fallback for everything else.
//
// Values are XML-escaped, and any web-style `{placeholder}` is dropped: the
// Android resources that format a number (`records_count`, `account_days`) are
// deliberately left out of the map, because Android's formatting syntax is not
// the web's and a half-converted placeholder renders as `%1$d` on screen.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const LOCALES = [
    { web: 'zh', qualifier: 'values-zh' },
    { web: 'zh-TW', qualifier: 'values-zh-rTW' },
    { web: 'yue', qualifier: 'values-b+yue' },
    { web: 'ja', qualifier: 'values-ja' },
    { web: 'ko', qualifier: 'values-ko' },
    { web: 'tr', qualifier: 'values-tr' },
];

/**
 * Android resource name → web i18n key.
 *
 * Only entries whose web key exists in the packs are emitted. Anything absent
 * here (app_name, the notification channel copy, the formatting strings) is
 * intentionally English-only.
 */
const MAP = {
    tab_overview: 'nav.home',
    tab_records: 'nav.history',
    tab_checkup: 'nav.lab',
    tab_settings: 'nav.settings',
    tab_account: 'nav.account',

    fab_quick_record: 'quickadd.button',
    fab_add_dose: 'timeline.add_title',
    fab_add_result: 'lab.add_title',

    overview_empty_title: 'home.empty_title',
    overview_empty_body: 'home.empty_subtitle',
    overview_log_dose: 'home.empty_cta',
    overview_e2: 'label.e2',
    overview_recent: 'orderbook.title',
    overview_chart: 'chart.title',
    range_7d: 'chart.range_7d',
    range_30d: 'chart.range_30d',
    range_all: 'chart.range_all',
    chart_curve: 'settings.chart_style.line',
    chart_candles: 'settings.chart_style.1d',

    records_title: 'timeline.title',
    records_unit: 'timeline.records',
    records_empty: 'timeline.empty',
    records_select: 'timeline.select',
    records_select_all: 'timeline.select_all',
    common_delete: 'btn.delete',
    common_cancel: 'btn.cancel',
    common_save: 'btn.save',
    common_back: 'core.back',
    common_confirm: 'btn.confirm',

    checkup_title: 'lab.title',
    checkup_text_records: 'journal.section',
    checkup_empty: 'lab.empty',

    settings_title: 'nav.settings',
    settings_general: 'settings.group.general',
    settings_plans: 'plan.title',
    settings_reminders: 'settings.group.reminders',
    settings_data: 'settings.group.data',
    settings_about: 'settings.group.about',
    settings_language: 'drawer.lang',
    settings_appearance: 'settings.theme',
    settings_weight: 'status.weight',
    settings_calibration: 'cal.settings',
    settings_pk_model: 'settings.pk_engine',
    settings_clear_all: 'settings.privacy',
    settings_export: 'export.title',
    settings_import: 'import.title',

    account_title: 'nav.account',
    days_unit: 'time.day',
    account_sync: 'settings.auto_sync',
    account_sync_now: 'settings.auto_sync',
    account_mcp: 'mcp.title',
    account_security: 'settings.security',
    account_hrt_since: 'account.hrt_start_label',

    sheet_close: 'core.close',
};

const KEY_RE = /^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gm;

function readPack(locale) {
    const source = readFileSync(new URL(`../src/i18n/langs/${locale}.ts`, import.meta.url), 'utf8');
    const out = new Map();
    for (const match of source.matchAll(KEY_RE)) {
        // The packs are JSON-shaped literals; unescape the handful of sequences
        // that actually appear in them.
        const value = match[2]
            .replace(/\\"/g, '"')
            .replace(/\\n/g, ' ')
            .replace(/\\\\/g, '\\');
        out.set(match[1], value);
    }
    return out;
}

function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, "\\'");
}

const missing = new Map();
let written = 0;

for (const locale of LOCALES) {
    const pack = readPack(locale.web);
    const lines = [];

    for (const [androidKey, webKey] of Object.entries(MAP)) {
        const value = pack.get(webKey);
        if (value === undefined || value.trim() === '') {
            missing.set(webKey, (missing.get(webKey) ?? 0) + 1);
            continue;
        }
        // A leftover web placeholder would be printed verbatim by Android.
        if (/\{[a-z]+\}/i.test(value)) {
            missing.set(`${webKey} (placeholder)`, (missing.get(`${webKey} (placeholder)`) ?? 0) + 1);
            continue;
        }
        lines.push(`    <string name="${androidKey}">${escapeXml(value)}</string>`);
    }

    const dir = new URL(`../android/app/src/main/res/${locale.qualifier}/`, import.meta.url);
    mkdirSync(dir, { recursive: true });
    const body = [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<!-- Generated by scripts/gen-android-i18n.mjs from src/i18n/langs/${locale.web}.ts.`,
        '     Re-run the script rather than editing by hand. -->',
        '<resources>',
        ...lines,
        '</resources>',
        '',
    ].join('\n');
    writeFileSync(new URL('strings.xml', dir), body);
    written += 1;
    console.log(`${locale.qualifier}: ${lines.length} strings`);
}

if (missing.size > 0) {
    console.log('\nKeys with no usable translation (English fallback):');
    for (const [key, count] of [...missing.entries()].sort()) {
        console.log(`  ${key} — ${count} locale(s)`);
    }
}
console.log(`\nwrote ${written} locale files`);

