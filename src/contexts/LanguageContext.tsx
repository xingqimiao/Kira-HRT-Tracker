import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { LANG_ORDER } from '../i18n/types';
import type { Lang } from '../i18n/types';
import type { LangPack } from '../i18n/types';
import zhPack from '../i18n/langs/zh';
import { onAppSettingsApplied } from '../utils/appSettings';

const LanguageContext = createContext<{
    lang: Lang;
    setLang: (l: Lang) => void;
    t: (k: string) => string;
    /**
     * Resolve a key against a language that is not the selected one.
     *
     * The intro's language picker paints each option's subtitle in its own
     * language — a reader choosing between `日本語` and `한국어` needs to see how
     * they render, not the current language's word for them.
     *
     * Returns `undefined` for a pack that is not resident. This runs once per
     * option in a list render and must not start a fetch per option, so the
     * caller that needs every language calls `ensureAll` first — see the intro,
     * which stacks all seven to measure the tallest.
     */
    tIn: (l: Lang, k: string) => string | undefined;
    /**
     * Load every pack this build carries, then repaint.
     *
     * For the one screen that genuinely needs all of them: the intro stacks each
     * language's subtitle in a single grid cell so the box is as tall as the
     * longest, which requires the strings to exist, not just the selected one.
     * Loads in sequence rather than in parallel to keep the cold-start burst of
     * requests small; the intro is not on a latency-critical path.
     */
    ensureAll: () => void;
} | null>(null);

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

/**
 * Language packs, loaded on demand.
 *
 * Each pack is its own module so a build ships only the languages a reader can
 * actually see. Before the split every pack was in the entry chunk — a reader in
 * Chinese downloaded Japanese, Korean and Turkish copy they could not read, and
 * the seven packs together were the largest thing in the bundle.
 *
 * `zh` is imported statically and is always resident. That is not an arbitrary
 * default: it is where every fallback chain in `FALLBACK` ends, so with it in
 * memory `t()` can always answer — see the provider body for why that matters
 * while another pack is still in flight.
 */
const PACK_LOADERS: Record<Lang, () => Promise<{ default: LangPack }>> = {
    'zh': async () => ({ default: zhPack }),
    'zh-TW': () => import('../i18n/langs/zh-TW'),
    'yue': () => import('../i18n/langs/yue'),
    'en': () => import('../i18n/langs/en'),
    'ja': () => import('../i18n/langs/ja'),
    'ko': () => import('../i18n/langs/ko'),
    'tr': () => import('../i18n/langs/tr'),
};

const isLang = (value: unknown): value is Lang => LANG_ORDER.includes(value as Lang);

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
    const [lang, setLang] = useState<Lang>(() => {
        const stored = localStorage.getItem('hrt-lang');
        if (isLang(stored)) return stored;
        return detectBrowserLang();
    });

    // Packs already resolved. Starts with the statically-bundled `zh`, and holds
    // every pack the reader has used this session so switching back costs nothing.
    //
    // A `ref` rather than state: writing a pack here must not itself trigger a
    // render. The render that shows a newly-selected language is the one caused by
    // `setLang`, and by then the pack is in the map.
    const loaded = useRef<Partial<Record<Lang, LangPack>>>({ 'zh': zhPack });
    const [, forceRepaint] = useState(0);

    // Load the selected pack, then its fallback chain, in the background. The
    // chain is fetched too because `t()` consults it for any key the selected pack
    // does not restate, and a chain member arriving later than the pack would
    // change a string that had already been painted.
    useEffect(() => {
        let cancelled = false;
        const chain = [lang, ...(FALLBACK[lang] ?? FALLBACK.zh)];
        (async () => {
            for (const target of chain) {
                if (loaded.current[target]) continue;
                try {
                    const mod = await PACK_LOADERS[target]();
                    if (cancelled) return;
                    loaded.current[target] = mod.default;
                } catch {
                    // A pack that fails to fetch leaves its slot empty and `t()`
                    // falls through to the next member of the chain, so the UI
                    // degrades a language at a time instead of breaking.
                }
            }
            // Repaint once the chain is resident, so strings that were answered
            // from `zh` while the real pack loaded are replaced.
            if (!cancelled) forceRepaint((n) => n + 1);
        })();
        return () => { cancelled = true; };
    }, [lang]);

    // Adopt a language the account says this device should be using. Guarded by
    // the key actually holding a language this build knows, so a payload from a
    // newer version cannot put the UI into a pack that does not exist.
    useEffect(() => onAppSettingsApplied(() => {
        const saved = localStorage.getItem('hrt-lang');
        if (isLang(saved)) setLang(saved);
    }), []);

    useEffect(() => {
        localStorage.setItem('hrt-lang', lang);
        document.title = "Kira HRT Tracker";
        document.documentElement.lang = LANG_LOCALE[lang] ?? lang;
        document.documentElement.dir = RTL_LANGS.has(lang) ? 'rtl' : 'ltr';
    }, [lang]);

    /**
     * Resolve a key against the loaded packs.
     *
     * Synchronous by contract — every call site is a render. On a cold start in a
     * language that isn't Chinese, the selected pack is still downloading on the
     * first render, so `loaded.current[lang]` is empty and the chain is walked
     * anyway: `zh` is always resident, and every chain ends in it, so the reader
     * gets the real Chinese string instead of a raw `settings.title`. The packs
     * land moments later and the effect above repaints with the right language.
     *
     * Text in the wrong language for one frame beats `settings.title` on screen,
     * and beats blocking the first paint on a network round trip.
     */
    const t = (key: string) => {
        const own = loaded.current[lang]?.[key];
        if (own !== undefined) return own;
        for (const alt of FALLBACK[lang] ?? FALLBACK.zh) {
            const value = loaded.current[alt]?.[key];
            if (value !== undefined) return value;
        }
        return loaded.current.zh?.[key] ?? key;
    };

    const tIn = (target: Lang, key: string): string | undefined =>
        loaded.current[target]?.[key];

    const ensureAll = useCallback(() => {
        let cancelled = false;
        (async () => {
            for (const target of LANG_ORDER) {
                if (loaded.current[target]) continue;
                try {
                    const mod = await PACK_LOADERS[target]();
                    if (cancelled) return;
                    loaded.current[target] = mod.default;
                } catch {
                    // Same degradation as the chain loader: the intro falls back to
                    // showing the options it does have rather than failing.
                }
            }
            if (!cancelled) forceRepaint((n) => n + 1);
        })();
        // The intro calls this on mount and unmounts when the reader moves on; the
        // flag stops a late pack from repainting an unmounted tree.
        return () => { cancelled = true; };
    }, []);

    return (
        <LanguageContext.Provider value={{ lang, setLang, t, tIn, ensureAll }}>
            {children}
        </LanguageContext.Provider>
    );
};
