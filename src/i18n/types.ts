/**
 * Every language this build carries.
 *
 * Defined here rather than in `translations.ts` because the language packs, the
 * context and the coverage checker all need it, and `translations.ts` is now the
 * one file that is *not* shipped — it is the pre-split build artefact the packs
 * were generated from. Putting the shared type behind it would make every
 * consumer depend on a module that exists only for the migration.
 */
export type Lang = 'zh' | 'zh-TW' | 'yue' | 'en' | 'ja' | 'ko' | 'tr';

/** Every language this build carries, in the order the picker lists them. */
export const LANG_ORDER: readonly Lang[] = ['zh', 'zh-TW', 'yue', 'en', 'ja', 'ko', 'tr'];

/**
 * The shape every language pack shares.
 *
 * Deliberately `string`-valued and open-ended rather than a union of the 776 key
 * literals: the packs are loaded lazily and the fallback chain resolves keys at
 * runtime, so a missing key has to be representable (it reads as `undefined` and
 * the chain moves on). A closed key union would turn a translation gap into a
 * build error in the *consuming* file instead of a number in
 * `scripts/check-i18n-coverage.mjs`, which is where gaps are meant to surface.
 */
export type LangPack = Readonly<Record<string, string>>;
