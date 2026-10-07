import { openUrl } from '@tauri-apps/plugin-opener';
import { isNativeApp } from './platform';

/** On Android, hand web links to the system browser. */
export async function openExternalUrl(url: string): Promise<void> {
    if (isNativeApp()) {
        await openUrl(url);
    } else {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

/**
 * Route every plain `<a href="http…">` through `openExternalUrl` while inside
 * the Tauri webview — without this, an anchor tap navigates the app's own
 * webview. Capture phase, so it wins over per-anchor handlers; `window.open`
 * call sites are migrated to `openExternalUrl` individually instead.
 */
export function installNativeLinkInterceptor(): () => void {
    if (!isNativeApp()) return () => {};
    const onClick = (ev: MouseEvent) => {
        if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        const anchor = (ev.target as HTMLElement | null)?.closest?.('a[href]');
        const href = anchor?.getAttribute('href') ?? '';
        if (!/^https?:\/\//i.test(href)) return;
        ev.preventDefault();
        void openExternalUrl(href);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
}
