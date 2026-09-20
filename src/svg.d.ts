declare module '*.svg' {
    const src: string;
    export default src;
}

/** Vite's `?raw` suffix: the file's text, not its URL. */
declare module '*.svg?raw' {
    const content: string;
    export default content;
}

