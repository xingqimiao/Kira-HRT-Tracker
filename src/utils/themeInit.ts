import { AppTheme } from '../constants';

/**
 * Put the saved theme and key colour on `<html>` immediately, without React.
 *
 * Needed because the app's only theme effect lives in `AppContent`, and three
 * routes render **outside** it: the X landing (`/auth/x/callback`), a public share
 * link, and the onboarding gate's own pre-mount frame. On those routes `.dark` was
 * never added, so every `dark:` class and every `.dark …` rule sat inert and the
 * page rendered light while the rest of the app honoured the setting. The key
 * colour is the same bug one class over — a user on the blue palette got a pink
 * primary button on these routes.
 *
 * The stylesheet keys off classes, not a `prefers-color-scheme` query, so matching
 * the platform means resolving `system` here as well: adding `.dark`
 * unconditionally would force these routes to light on a dark OS.
 *
 * Idempotent, and deliberately free of app state: it is called at module load from
 * `main.tsx`, before React renders, so there is no frame in the wrong theme.
 */
export function applyStoredTheme(): void {
    if (typeof document === 'undefined') return;

    // Private mode or storage disabled must not throw here — this runs before the
    // first render, and the system preference needs no storage to resolve.
    const read = (key: string): string | null => {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    };

    const saved = read('app-theme');
    const theme: AppTheme =
        saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';

    const prefersDark =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-color-scheme: dark)').matches
            : false;

    const isDark = theme === 'system' ? prefersDark : theme === 'dark';
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(isDark ? 'dark' : 'light');

    root.classList.toggle('key-blue', read('app-key-color') === 'blue');
}
