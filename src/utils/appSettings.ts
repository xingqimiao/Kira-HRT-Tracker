/**
 * The app's own preferences, as one movable bag.
 *
 * Theme, key colour, language, HRT mode and vial visibility each live in their own
 * context and own their own storage key — correctly, because each has an owner that
 * knows when it changed. What none of them has is a way to be told "the account
 * says the theme is now light, and you did not change it".
 *
 * So this module is the seam for that one direction. `read` collects the current
 * values out of storage; `apply` writes a bag back and announces it, and each
 * owner listens and adopts its own key. An event rather than props because the
 * owners sit in four different trees (App, LanguageContext, HRTModeContext,
 * VialContext) and threading a settings prop through all of them to reach a
 * preference they already own would be the larger change.
 *
 * Calibration method and history window deliberately are NOT here: they are
 * account-scoped (`hrt-u<id>-cal-method`), so the data layer owns them and moves
 * them directly.
 */
import type { AppSettings } from './syncMerge';

/** Fired after `apply` so each owner can adopt its own key. */
export const APP_SETTINGS_EVENT = 'app-settings-applied';

/**
 * The settings this module moves: the ones that live in a single, un-namespaced
 * storage key. Calibration method and history window are deliberately absent —
 * they are account-scoped (`hrt-u<id>-cal-method`), so the data layer, which
 * knows the owner, moves those itself.
 */
export type GlobalSettingKey = 'theme' | 'keyColor' | 'lang' | 'hrtMode' | 'showVial' | 'timezone';

/**
 * Storage key per setting. These are the keys the owning contexts already use —
 * this module reads and writes the same ones rather than introducing a parallel
 * set that would drift from them.
 */
const KEYS: Record<GlobalSettingKey, string> = {
    theme: 'app-theme',
    keyColor: 'app-key-color',
    lang: 'hrt-lang',
    hrtMode: 'hrt-mode',
    showVial: 'app-blood-vial',
    // Written only when the account says so (an agent set it); the app has no
    // control for it, but carrying it keeps the bag and the server's column one
    // value rather than two that disagree. See `AppSettings.timezone`.
    timezone: 'app-timezone',
};

/**
 * When this device's bag last *changed*, for the sync merge's newest-wins rule.
 *
 * Global rather than account-scoped, matching the keys themselves: theme and
 * language are device-wide in this app, so a per-account stamp would claim a
 * precision the values do not have.
 */
const STAMP_KEY = 'app-settings-at';

/**
 * The bag as this module last saw it. Any read that disagrees with it is a real
 * local edit, and that — not the act of writing a key — is what bumps the stamp.
 *
 * This is what keeps a sync *adopting* the account's settings from looking like
 * an edit by the device that adopted them: `applyAppSettings` records the bag it
 * wrote, so the reads that follow it see no difference and leave the stamp alone.
 * Without it, the adopting device would immediately stamp itself newer and push
 * the same values straight back.
 */
let lastKnown: AppSettings | null = null;

function sameBag(a: AppSettings, b: AppSettings): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AppSettings>;
    for (const key of keys) if (a[key] !== b[key]) return false;
    return true;
}

/** Epoch ms this device's settings bag last changed. 0 for a device that never has. */
export function appSettingsStamp(): number {
    const raw = Number(localStorage.getItem(STAMP_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Mark the bag as freshly edited.
 *
 * Needed for the settings `readAppSettings` cannot see drift in: the calibration
 * method and history window live under account-scoped keys (the data layer owns
 * them), so a change to one of those would not move the stamp on its own — and
 * the merge, seeing an unstamped bag, would let the account's older copy win and
 * quietly revert the edit.
 */
export function touchAppSettings(): void {
    localStorage.setItem(STAMP_KEY, String(Date.now()));
}

/** Collect the values currently on this device. Missing keys are simply absent. */
export function readAppSettings(): AppSettings {
    // Accumulated as `unknown` and cast once — see the note in `sanitizeAppSettings`
    // on why the key union's write type is not assignable per-key.
    const out: Record<string, unknown> = {};
    for (const [key, storageKey] of Object.entries(KEYS) as [GlobalSettingKey, string][]) {
        const value = localStorage.getItem(storageKey);
        // Every one of these is persisted as a string; `showVial` stores
        // 'true'/'false' so a boolean is normalised back on the way out.
        if (value === null || value === '') continue;
        out[key] = key === 'showVial' ? value !== 'false' : value;
    }
    const bag = out as AppSettings;
    if (lastKnown === null) lastKnown = bag;
    else if (!sameBag(bag, lastKnown)) {
        lastKnown = bag;
        localStorage.setItem(STAMP_KEY, String(Date.now()));
    }
    return bag;
}

/**
 * Write a bag back and tell the owners.
 *
 * Only keys present in `settings` are touched, so a payload that says nothing
 * about (say) the language cannot clear it. `showVial` is stored as the string
 * 'true' / 'false' because that is the form its context persists and reads.
 *
 * `at` is the stamp that came with the bag, recorded verbatim rather than
 * refreshed: restamping would make an adopted bag look like a fresh local edit
 * and let it beat a genuinely newer one on the next round.
 */
export function applyAppSettings(settings: AppSettings | undefined, at = 0): void {
    if (!settings) return;
    const touched: GlobalSettingKey[] = [];
    const adopted: AppSettings = { ...(lastKnown ?? {}) };
    for (const [key, storageKey] of Object.entries(KEYS) as [GlobalSettingKey, string][]) {
        const value = settings[key];
        if (value === undefined || value === '') continue;
        localStorage.setItem(storageKey, String(value));
        (adopted as any)[key] = value;
        touched.push(key);
    }
    if (touched.length === 0) return;
    // Recorded before the listeners run: they read the bag back and must not see
    // it as an edit.
    lastKnown = adopted;
    if (at > 0) localStorage.setItem(STAMP_KEY, String(at));
    window.dispatchEvent(new CustomEvent(APP_SETTINGS_EVENT));
}

/** Subscribe an owner to adopted settings. Returns the unsubscribe function. */
export function onAppSettingsApplied(handler: () => void): () => void {
    window.addEventListener(APP_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(APP_SETTINGS_EVENT, handler);
}
