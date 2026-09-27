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
