/**
 * The about page's behaviour. Shared verbatim by /about/ and /about/en/ — every
 * path it touches is relative to the logo <img>, so the two depths (../brand vs
 * ../../brand) do not need two files.
 *
 * Loaded with `defer` and referenced with a relative path, because the CSP is
 * `script-src 'self'`: an inline script is blocked outright, and so is an inline
 * `onclick=`. Clicks are read off `data-act` instead. See about-boot.js for the
 * pre-paint half.
 */
(() => {
  'use strict';

  // --- 1. Theme: follow the system, and toggle from the top-right button -----
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme(isDark) {
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');

    // Derived from the current src rather than written out: the zh page is one
    // directory deep and the en page two, and a hardcoded path would be wrong in
    // exactly one of them.
    const logo = document.getElementById('brandLogoImg');
    if (logo) logo.src = logo.src.replace(/kira-app-icon(-dark)?\.svg$/, isDark ? 'kira-app-icon-dark.svg' : 'kira-app-icon.svg');
  }

  applyTheme(darkMedia.matches);
  darkMedia.addEventListener('change', (e) => applyTheme(e.matches));

  // --- 2. Expand / collapse the full drug list ------------------------------
  function toggleDrugList() {
    const btn = document.getElementById('drugToggleBtn');
    const body = document.getElementById('drugCollapseBody');
    if (btn) btn.classList.toggle('open');
    if (body) body.classList.toggle('open');
  }

  // Delegated: `data-act` replaces the inline handlers the CSP refuses.
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-act]') : null;
    if (!target) return;
    if (target.dataset.act === 'theme') {
      applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark');
    } else if (target.dataset.act === 'drugs') {
      toggleDrugList();
    }
  });

  // --- 3. The breathing M3E cookie polygons --------------------------------
  function cookiePath(cx, cy, r, n, a, ph) {
    const pts = [];
    for (let i = 0; i <= 100; i++) {
      const t = (i / 100) * Math.PI * 2;
      const rr = r * (1 + a * Math.cos(n * (t - ph)));
      pts.push(`${i ? 'L' : 'M'}${(cx + rr * Math.cos(t)).toFixed(1)},${(cy + rr * Math.sin(t)).toFixed(1)}`);
    }
    return pts.join(' ') + 'Z';
  }

  const liveCookies = document.querySelectorAll('.js-live-cookie');
  const startTime = performance.now();
  function animateCookies(now) {
    const sec = (now - startTime) * 0.001;
    liveCookies.forEach((el, idx) => {
      const n = parseInt(el.dataset.n, 10) || 9;
      const r = parseFloat(el.dataset.r) || 50;
      const cx = parseFloat(el.dataset.cx) || 50;
      const cy = parseFloat(el.dataset.cy) || 50;
      const amp = 0.085 + 0.025 * Math.sin(sec * 1.1 + idx);
      const ph = sec * 0.25 * (idx % 2 === 0 ? 1 : -1);
      el.setAttribute('d', cookiePath(cx, cy, r, n, amp, ph));
    });
    requestAnimationFrame(animateCookies);
  }
  requestAnimationFrame(animateCookies);

  // --- 4. Scroll-driven stage radius morph --------------------------------
  const stages = document.querySelectorAll('.js-scroll-stage');
  function onScroll() {
    const vh = window.innerHeight;
    stages.forEach((st) => {
      const rect = st.getBoundingClientRect();
      const rawP = 1 - (rect.top + rect.height * 0.5) / (vh + rect.height * 0.35);
      const p = Math.max(0, Math.min(1, rawP));
      const r1 = parseFloat(st.dataset.r1) || 88;
      const r2 = parseFloat(st.dataset.r2) || 24;
      const cA = Math.round(r1 + (r2 - r1) * p);
      const cB = Math.round(r2 + (r1 - r2) * p);
      st.style.borderRadius = `${cA}px ${cB}px ${cA}px ${cB}px`;

      const phone = st.querySelector('.js-phone');
      if (phone) {
        const yOffset = Math.round((0.5 - p) * 38);
        phone.style.transform = `translate3d(0, ${yOffset}px, 0)`;
      }
    });
  }
  window.addEventListener('scroll', () => requestAnimationFrame(onScroll), { passive: true });
  onScroll();

  // --- 5. Text reveal ------------------------------------------------------
  // `hidden` is only ever added here, next to the code that removes it, so the
  // two cannot drift apart and leave a section invisible for good.
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) e.target.classList.add('in');
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.reveal-text').forEach((el) => io.observe(el));

  // The observer is the animation; this sweep is the guarantee. A fast jump —
  // a fragment link, a restored scroll position, a programmatic scrollTo — can
  // move past a section between two frames, and the entry for it never arrives
  // (seen live: one section stayed blank while the other thirteen revealed).
  // Anyone at or above the fold is revealed unconditionally.
  function revealInView() {
    const fold = window.innerHeight * 0.92;
    document.querySelectorAll('.reveal-text:not(.in)').forEach((el) => {
      if (el.getBoundingClientRect().top < fold) el.classList.add('in');
    });
  }
  revealInView();
  window.addEventListener('scroll', revealInView, { passive: true });
  window.addEventListener('resize', revealInView, { passive: true });

  // --- 6. Press physics on [data-m] ---------------------------------------
  document.addEventListener('pointerdown', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-m]') : null;
    if (el) el.classList.add('mo');
  });
  ['pointerup', 'pointercancel'].forEach((ev) =>
    document.addEventListener(ev, () => {
      setTimeout(() => document.querySelectorAll('.mo').forEach((el) => el.classList.remove('mo')), 250);
    }),
  );
})();
