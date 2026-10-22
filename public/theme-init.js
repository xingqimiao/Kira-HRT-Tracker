/**
 * Theme and viewport class before the first paint.
 *
 * Extracted from an inline <script> in index.html (2026-10-23) so the app can send
 * a Content-Security-Policy without 'unsafe-inline' on script-src. It is a classic,
 * non-deferred script: the parser blocks on it, so it still runs before the body is
 * painted, which is the whole point — the stylesheet resolves the LIGHT palette
 * until `html.dark` lands, and the Android WebView shows the html background in the
 * edge-to-edge strip.
 *
 * It duplicates `applyStoredTheme` on purpose; a pre-module script cannot import
 * it. Keep the two in step. Wrapped so private-mode storage or a missing
 * matchMedia cannot break the boot.
 */
(function () {
        try {
          var saved = localStorage.getItem('app-theme');
          var theme = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
          var prefersDark = typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-color-scheme: dark)').matches
            : false;
          var isDark = theme === 'system' ? prefersDark : theme === 'dark';
          var root = document.documentElement;
          root.classList.remove('light', 'dark');
          root.classList.add(isDark ? 'dark' : 'light');
          root.classList.toggle('key-blue', localStorage.getItem('app-key-color') === 'blue');
          // Clamp the document before first paint. The crawler footer below #root
          // makes the document taller than the viewport, and `app-viewport` (see
          // index.css) hides that overflow — but it was added by a module script, i.e.
          // after parse, so a scrollbar flashed on the right for that window and then
          // vanished when the class landed. Applying it here removes the flash, and a
          // no-JavaScript client never runs this, so it still gets the scrollable page
          // with the footer as its body.
          root.classList.add('app-viewport');
        } catch (e) {
          document.documentElement.classList.add('dark');
          document.documentElement.classList.add('app-viewport');
        }
      })();
