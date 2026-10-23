/**
 * The two things that have to happen before the first paint.
 *
 * Both are here, in a file, because the site's CSP is `script-src 'self'` — no
 * `unsafe-inline`, no nonce — so an inline `<script>` never runs. That is what
 * blanked /about/ on 2026-10-23: the whole page hung off an inline block, and
 * `.reveal-text` sits at `opacity: 0` until it is observed, so every section
 * rendered as an empty colour block.
 *
 * 1. `js` on <html> — the reveal styles are scoped to `.js .reveal-text`, so a
 *    build that never runs this shows the text instead of hiding it forever.
 * 2. The colour scheme, before paint, or a dark-mode visitor gets a white flash.
 *
 * The logo swap needs the DOM and lives in about.js.
 */
document.documentElement.classList.add('js');
if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.setAttribute('data-theme', 'dark');
}
