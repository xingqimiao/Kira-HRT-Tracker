/** True when the SPA is running inside a Tauri v2 webview. */
export const isNativeApp = (): boolean =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
