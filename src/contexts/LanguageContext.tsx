import React, { createContext, useContext, useState, useEffect } from 'react';
import { TRANSLATIONS, Lang } from '../i18n/translations';
import { onAppSettingsApplied } from '../utils/appSettings';

const LanguageContext = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string } | null>(null);

export const useTranslation = () => {
    const ctx = useContext(LanguageContext);
    if (!ctx) throw new Error("useTranslation must be used within LanguageProvider");
    return ctx;
};

const RTL_LANGS: ReadonlySet<Lang> = new Set<Lang>();

const LANG_LOCALE: Record<Lang, string> = {
    'zh': 'zh-CN',
    'zh-TW': 'zh-TW',
    'yue': 'zh-HK',
    'en': 'en',
    'ja': 'ja',
    'ko': 'ko',
    'tr': 'tr',
};

/**
 * Where a key falls through to when its own pack hasn't got it.
 *
 * The old chain was zh then en for everyone, which put Simplified Chinese in
 * front of a Turkish or Korean reader — a script they may not read at all —
 * ahead of English, which most of them can at least muddle through. So the
 * script the reader is likeliest to recognise goes first: the Chinese packs
 * fall back among themselves, and everyone else takes English before Chinese.
 *
 * zh and en still point at each other last, because between them they carry
 * every key in the app, so nothing can fall all the way through to a raw
 * dotted key.
 */
const FALLBACK: Record<Lang, readonly Lang[]> = {
    'zh': ['en'],
    'zh-TW': ['zh', 'en'],
    'yue': ['zh-TW', 'zh', 'en'],
    'en': ['zh'],
    'ja': ['en', 'zh'],
    'ko': ['en', 'zh'],
    'tr': ['en', 'zh'],
};

function detectBrowserLang(): Lang {
    if (typeof navigator === 'undefined') return 'zh';
    const candidate = (navigator.languages && navigator.languages.length > 0 ? navigator.languages[0] : navigator.language) || '';
    const raw = candidate.toLowerCase();
    if (raw.startsWith('zh-hk') || raw.startsWith('yue') || raw === 'zh-hant-hk') return 'yue';
    if (raw.startsWith('zh-tw') || raw.startsWith('zh-hant') || raw.startsWith('zh-mo')) return 'zh-TW';
    if (raw.startsWith('zh')) return 'zh';
    if (raw.startsWith('ja')) return 'ja';
    if (raw.startsWith('ko')) return 'ko';
    if (raw.startsWith('tr')) return 'tr';
    if (raw.startsWith('en')) return 'en';
    return 'zh';
}

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
    const [lang, setLang] = useState<Lang>(() => {
        const stored = localStorage.getItem('hrt-lang') as Lang | null;
        if (stored && stored in TRANSLATIONS) return stored;
        return detectBrowserLang();
    });

    // Adopt a language the account says this device should be using. Guarded by
    // the key actually holding a language this build knows, so a payload from a
    // newer version cannot put the UI into a pack that does not exist.
    useEffect(() => onAppSettingsApplied(() => {
        const saved = localStorage.getItem('hrt-lang') as Lang | null;
        if (saved && saved in TRANSLATIONS) setLang(saved);
    }), []);

    useEffect(() => {
        localStorage.setItem('hrt-lang', lang);
        document.title = "Kira HRT Tracker";
        document.documentElement.lang = LANG_LOCALE[lang] ?? lang;
        document.documentElement.dir = RTL_LANGS.has(lang) ? 'rtl' : 'ltr';
    }, [lang]);

    const t = (key: string) => {
        const packs = (TRANSLATIONS as Record<string, Record<string, string>>);
        const own = packs[lang]?.[key];
        if (own !== undefined) return own;
        for (const alt of FALLBACK[lang] ?? FALLBACK.zh) {
            const value = packs[alt]?.[key];
            if (value !== undefined) return value;
        }
        return key;
    };

    return (
        <LanguageContext.Provider value={{ lang, setLang, t }}>
            {children}
        </LanguageContext.Provider>
    );
};
