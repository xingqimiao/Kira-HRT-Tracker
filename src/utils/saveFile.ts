import { isNativeApp } from './platform';

/**
 * Save a text file.
 *
 * Web uses the usual Blob + `<a download>` path. An Android WebView has no
 * download manager behind that attribute — the click is a no-op — so the native
 * shell exposes `HrtExport.save`, which opens the system document picker and
 * writes the text to whatever location the user chooses.
 */
interface HrtExportBridge {
    save(name: string, mime: string, content: string): void;
}

declare global {
    interface Window {
        HrtExport?: HrtExportBridge;
    }
}

export function saveTextFile(filename: string, mime: string, text: string): void {
    const bridge = isNativeApp() ? window.HrtExport : undefined;
    if (bridge) {
        bridge.save(filename, mime, text);
        return;
    }
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
