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

/**
 * If the policy refuses a script again, hand the text back.
 *
 * `.js` exists only to arm the reveal animation — it is what makes the text
 * start hidden. A blocked about.js would therefore blank the page a second
 * time, so a `script-src` violation removes the class and everything shows.
 * This is the one failure mode the 2026-10-23 outage had that no amount of
 * build-time checking can rule out on the client.
 */
document.addEventListener('securitypolicyviolation', (e) => {
  const directive = e.effectiveDirective || e.violatedDirective || '';
  if (directive.startsWith('script-src')) document.documentElement.classList.remove('js');
});
