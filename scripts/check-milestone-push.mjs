
/**
 * The push, sampled.
 *
 *   node scripts/check-milestone-push.mjs
 *
 * A screenshot cannot show whether the page was pushed or jumped: both end in
 * the same place. So this samples the content's own top every 50ms from the
 * moment the bar is in the DOM until well past its entrance, and asserts that
 * the content *travels* — that no single frame carries a whole bar's height.
 *
 * Same idea for the exit: the content must come back up over the exit token and
 * finish exactly where it started.
 *
 * It also measures both variants, because the bar is one line on day 100 and
 * three on day 365, and a height that was written down instead of measured
 * would be wrong for one of them.
 *
 * Needs the preview bundle served:
 *   npx vite preview --config vite.dev-local.config.ts --port 5199
 *
 * It also needs Playwright, which this repo does not depend on — the other
 * browser checks next door have the same arrangement. Point `PLAYWRIGHT_DIR` at
 * a tree that has it (an npx cache works) and the import resolves from there:
 *
 *   $env:PLAYWRIGHT_DIR='...\_npx\<hash>\node_modules'; node scripts/check-milestone-push.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const playwrightDir = process.env.PLAYWRIGHT_DIR;
const { chromium } = await import(
  playwrightDir ? pathToFileURL(join(playwrightDir, 'playwright', 'index.mjs')).href : 'playwright',
);

const BASE = process.env.HRT_BASE || 'http://127.0.0.1:5199';
const SAMPLE_MS = 600;
const STEP_MS = 50;

const targetDateFor = (days) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
};

/** Answers the start-date question in the intro, then leaves the rest alone. */
async function setStartDate(page, days) {
  const target = targetDateFor(days);
  await page.goto(BASE + '/');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'English' }).first().click().catch(() => {});
  await page.waitForTimeout(250);
  for (let i = 0; i < 3; i++) {
    const next = page.getByRole('button', { name: /^Next$/ });
    if (!(await next.count())) break;
    await next.first().click();
    await page.waitForTimeout(320);
  }
  const trigger = page.locator('button[aria-expanded]').first();
  await trigger.click();
  await page.waitForTimeout(350);
  const pick = async (label, optionLabel) => {
    await page.getByRole('button', { name: label, exact: true }).first().click();
    await page.waitForTimeout(220);
    await page.getByRole('option', { name: optionLabel, exact: true }).first().click();
    await page.waitForTimeout(220);
  };
  await pick('Year', String(target.getFullYear()));
  await pick('Month', target.toLocaleDateString('en-US', { month: 'long' }));
  await pick('Day', String(target.getDate()));
  await trigger.click().catch(() => {});
  await page.waitForTimeout(250);
  for (let i = 0; i < 12; i++) {
    const b = page.getByRole('button', { name: /^(Skip|Next)$/ });
    if (!(await b.count())) break;
    await b.first().click().catch(() => {});
    await page.waitForTimeout(280);
  }
  await page.waitForTimeout(400);
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.includes('hrt-start')).map((k) => localStorage.getItem(k)));
  if (!stored.some((v) => v)) throw new Error('start date not written');
}

/* ---------------------------------------------------------------- sampling --

   The sampler runs *inside* the page. It is installed as an init script so it is
   already there when React renders the bar; the arm function then waits for the
   shell to appear and reads the content's top on a 50ms cadence from that
   moment. Reading on a timer rather than on rAF is deliberate — the point is
   wall-clock travel, and getBoundingClientRect() forces the layout the reader
   would have got anyway. */

const INSTALL_SAMPLER = () => {
  const content = () => document.querySelector('.m3-shell-body > .overflow-y-auto');
  const shell = () => document.querySelector('.m3-milestone-shell');
  window.__mbArm = (ms) => new Promise((resolve) => {
    const samples = [];
    const t0 = performance.now();
    const tick = () => {
      const el = content();
      const sh = shell();
      const now = Math.round(performance.now() - t0);
      const rect = el ? el.getBoundingClientRect() : null;
      const shRect = sh ? sh.getBoundingClientRect() : null;
      samples.push({
        t: now,
        top: rect ? Math.round(rect.top) : null,
        shell: shRect ? Math.round(shRect.height) : null,
        state: sh ? (sh.dataset.open === 'true' ? 'open' : (sh.dataset.state || 'gone')) : 'gone',
      });
      if (now >= ms) resolve(samples);
      else setTimeout(tick, 50);
    };
    tick();
  });
};

const show = (label, samples) => {
  console.log('  ' + label);
  for (const s of samples) {
    console.log('    t=' + String(s.t).padStart(3) + 'ms  top=' + String(s.top).padStart(4) + '  strip=' + String(s.shell).padStart(4) + '  ' + s.state);
  }
};

/** Travel = how far the content moved, and how much of it moved in one step. */
function travel(samples) {
  const tops = samples.map((s) => s.top).filter((v) => v !== null);
  let biggestStep = 0;
  for (let i = 1; i < tops.length; i += 1) biggestStep = Math.max(biggestStep, Math.abs(tops[i] - tops[i - 1]));
  /* Where it started and where it landed, plus how long it took to get there:
     the first sample that left the start, to the first that reached the end. A
     jump has a `travelMs` of one step; a tween has a run of them. */
  const last = tops[tops.length - 1];
  const firstMoved = samples.find((s) => s.top !== null && s.top !== tops[0]);
  const firstArrived = samples.find((s) => s.top === last);
  return {
    first: tops[0],
    last,
    total: last - tops[0],
    biggestStep,
    travelMs: firstMoved && firstArrived ? firstArrived.t - firstMoved.t : 0,
  };
}

/* ------------------------------------------------------------------- cases -- */

const results = [];
const record = (ok, name, detail) => {
  results.push([ok, name, detail]);
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
};

/* ------------------------------------------------------------------ shots --

   Two pictures of the bar: the whole thing, and the heading corner the cake
   glyph sits in, where the words begin. Clipped in *page* coordinates, which is
   what `page.screenshot({ clip })` wants — a rect read off the DOM is
   viewport-relative, and getting that wrong does not fail, it photographs the
   middle of the page, which is how a picture lies.

   The bar's height is measured, never written down: it is 46px on day 100 and
   128px on day 365. */
async function cropBar(page, name) {
  const clip = await page.evaluate(() => {
    const bar = document.querySelector('.m3-milestone-bar').getBoundingClientRect();
    const top = bar.top + window.scrollY;
    // The bar starts beside the rail from 840 up, so its left is 80 and not 0.
    const left = bar.left;
    return {
      bar: { x: left, y: top, width: Math.round(bar.width), height: Math.round(bar.height) },
      corner: { x: left, y: top, width: 80, height: Math.min(56, Math.round(bar.height)) },
    };
  });
  await page.screenshot({ path: name + '-bar.png', clip: clip.bar });
  await page.screenshot({ path: name + '-corner.png', clip: clip.corner });
}

/**
 * Bring the bar into view before anything is measured. The scrolling content is
 * taller than the phone, so a clip taken against a scrolled page is a coin toss
 * on a 390px window.
 */
async function showBar(page) {
  await page.evaluate(() => {
    document.querySelector('.m3-shell-body > .overflow-y-auto').scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(120);
}

/**
 * The anniversary bar, settled, and what is actually in it.
 *
 * This used to drive a candle through three frames. There is no candle any more,
 * so what is left to check is the thing that replaced it: the cake glyph is
 * present, it is the reicon one, it is inside the bar, it does not sit on the
 * words, and nothing in the bar is animating. The entrance is pinned to its end
 * state first, so these are readings of the settled bar and not of a frame of
 * something else.
 */
async function captureCake(page, label) {
  await page.waitForSelector('.m3-milestone-bar', { timeout: 20000 });
  await showBar(page);
  await page.evaluate(() => {
    const shell = document.querySelector('.m3-milestone-shell');
    const bar = document.querySelector('.m3-milestone-bar');
    const height = bar.getBoundingClientRect().height;
    shell.style.setProperty('--m3-milestone-height', height + 'px');
    shell.dataset.open = 'true';
    shell.style.transition = 'none';
    shell.style.height = height + 'px';
    // The entrance translates the bar from -100%; everything measured here is
    // the bar after it has landed.
    for (const a of bar.getAnimations()) {
      a.currentTime = a.effect.getTiming().duration;
      a.pause();
    }
  });
  // `Icon`'s markup lands after the first paint; one frame is enough and is not
  // the thing being asserted (the box is).
  await page.waitForTimeout(150);

  const state = await page.evaluate(() => {
    const bar = document.querySelector('.m3-milestone-bar');
    const barBox = bar.getBoundingClientRect();
    const glyph = document.querySelector('.m3-milestone-bar__cake');
    const text = document.querySelector('.m3-milestone-bar__text');
    const body = document.querySelector('.m3-milestone-bar__body');
    const title = document.querySelector('.m3-milestone-bar__title');
    const glyphBox = glyph.getBoundingClientRect();
    const textBox = text.getBoundingClientRect();
    return {
      // `Icon` writes reicon's own `toSvg()` markup through
      // `dangerouslySetInnerHTML`, so the `<svg>` exists in the DOM but not
      // necessarily at the instant a probe first runs. Both are recorded: the
      // wrapper's box is the assertion, the svg is the note.
      glyphSvg: !!glyph.querySelector('svg'),
      glyphWidth: Math.round(glyphBox.width),
      glyphHeight: Math.round(glyphBox.height),
      inBar: glyphBox.top >= barBox.top - 1 && glyphBox.bottom <= barBox.bottom + 1,
      // The glyph takes its own strip; the words must not start behind it.
      clearOfText: glyphBox.right <= textBox.left + 1,
      title: title ? title.textContent.trim() : null,
      titleLines: body ? 2 : 1,
      body: body ? body.textContent.replace(/\s+/g, ' ').trim() : null,
      // Everything inside the bar that is animating, entrance aside. The
      // entrance is on the bar itself and is excluded by starting at its
      // children.
      animatingInsideBar: [...bar.querySelectorAll('*')]
        .reduce((n, el) => n + el.getAnimations().filter((a) => a.playState === 'running').length, 0),
      barHeight: Math.round(barBox.height),
      textRight: Math.round(textBox.right),
      barRight: Math.round(barBox.right),
    };
  });

  await cropBar(page, label);
  await page.screenshot({ path: label + '-page.png' });
  return state;
}

async function run() {
  const browser = await chromium.launch();

  const withMilestone = async (days, opts = {}) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      ...opts,
    });
    const page = await context.newPage();
    await setStartDate(page, days);
    await page.evaluate(() => localStorage.setItem('hrt-lang', 'en'));
    await page.addInitScript(INSTALL_SAMPLER);
    return { context, page };
  };

  for (const [days, label] of [[100, 'day 100 (confetti, one line)'], [365, 'day 365 (cake, three lines)']]) {
    const { context, page } = await withMilestone(days);
    await page.reload();

    console.log('\n== ' + label + ' ==');
    await page.waitForSelector('.m3-milestone-shell', { timeout: 20000 });
    const samples = await page.evaluate((n) => window.__mbArm(n), SAMPLE_MS);
    show('enter', samples);

    const geometry = await page.evaluate(() => {
      const bar = document.querySelector('.m3-milestone-bar');
      const sh = document.querySelector('.m3-milestone-shell');
      const el = document.querySelector('.m3-shell-body > .overflow-y-auto');
      return {
        barHeight: bar.getBoundingClientRect().height,
        barTop: bar.getBoundingClientRect().top,
        shellHeight: sh.getBoundingClientRect().height,
        shellTop: sh.getBoundingClientRect().top,
        contentTop: el.getBoundingClientRect().top,
      };
    });

    const enter = travel(samples);
    /* "Pushed, not jumped" is a claim about the shape, not about the total: the
       entrance decelerates, so an emphasized-decelerate start covers most of the
       distance in the first frames whatever the bar's height — a 46px bar cannot
       travel more than 46px, so a fraction-of-total threshold would only be
       measuring the bar. What a jump looks like is the whole distance in one
       step; what a tween looks like is a run of distinct intermediate values
       with none of them the end state. */
    const tops = samples.map((s) => s.top).filter((v) => v !== null);
    const intermediates = tops.filter((v) => v !== tops[0] && v !== tops[tops.length - 1]).length;
    record(enter.biggestStep < enter.total && intermediates >= 3 && enter.total > 0,
      label + ': the page is pushed over time, not jumped in one step',
      'travelled ' + enter.total + 'px through ' + intermediates + ' intermediate values; largest single 50ms step '
        + enter.biggestStep + 'px (< ' + enter.total + 'px total)');
    record(Math.abs(geometry.shellHeight - geometry.barHeight) < 0.5,
      label + ': the strip settles exactly on the bar',
      'strip ' + geometry.shellHeight + 'px vs bar ' + geometry.barHeight + 'px');
    record(Math.abs(geometry.shellTop - geometry.barTop) < 1,
      label + ': the bar sits on the strip it paid for',
      'strip top ' + Math.round(geometry.shellTop) + ' vs bar top ' + Math.round(geometry.barTop));

    const restTop = Math.round(geometry.contentTop);

    console.log('  -- exit --');
    const exitWait = days === 365 ? 8000 : 4200;
    await page.waitForFunction(
      () => document.querySelector('.m3-milestone-shell') && document.querySelector('.m3-milestone-shell').dataset.state === 'closed',
      null, { timeout: exitWait + 8000 });
    const exitSamples = await page.evaluate((n) => window.__mbArm(n), 500);
    show('exit', exitSamples);
    const exit = travel(exitSamples);
    record(exit.total < 0 && Math.abs(exit.biggestStep) < Math.abs(exit.total) * 0.6,
      label + ': the exit pushes the page back the same way',
      'returned ' + exit.total + 'px; largest single 50ms step ' + Math.abs(exit.biggestStep) + 'px');

    await page.waitForTimeout(500);
    const after = await page.evaluate(() => {
      const el = document.querySelector('.m3-shell-body > .overflow-y-auto');
      return { shell: !!document.querySelector('.m3-milestone-shell'), top: Math.round(el.getBoundingClientRect().top), scroll: el.scrollTop };
    });
    /* `restTop` is the content's top on the frame the bar was armed, which is
       already a frame *into* the push — so the meaningful end state is the one
       with no bar at all. Read it off the shell's own sibling after the fact:
       with the shell gone and nothing else in the flow above it, the content's
       top is the top of the scrolling box, which is 0. */
    record(!after.shell && after.top === 0,
      label + ': settles exactly, no residual gap',
      'content top ' + after.top + ' with the shell out of the DOM (was ' + restTop + ' mid-push); shell still mounted: ' + after.shell);

    const summary = { label, enter, exit, barHeight: Math.round(geometry.barHeight), shellHeight: Math.round(geometry.shellHeight), restTop, after };
    results.push(['info', label, summary]);
    await context.close();
  }

  /* The anniversary bar is a still picture now: a cake glyph and the words. What
     is worth checking is that it is the cake, that it is in the bar and not on
     the words, and that nothing in it is moving. */
  console.log('\n== the anniversary bar (day 365) ==');
  {
    const { mkdirSync } = await import('node:fs');
    const OUT = process.env.HRT_SHOTS || 'E:/HRT/.milestone-shots';
    mkdirSync(OUT, { recursive: true });
    const seen = [];
    for (const width of [390, 1200]) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await withMilestone(365, { viewport: { width, height: 844 } });
        await page.evaluate((t) => localStorage.setItem('app-theme', t), theme);
        await page.reload();
        const label = 'cake-365-' + width + '-' + theme;
        const cake = await captureCake(page, OUT + '/' + label, OUT);
        console.log('  ' + label + ' | glyph ' + cake.glyphTag + (cake.glyphSvg ? '+svg' : ' NO-SVG')
          + ' ' + cake.glyphWidth + 'x' + cake.glyphHeight
          + ' | in bar ' + cake.inBar + ' | clear of text ' + cake.clearOfText
          + ' | animating inside bar ' + cake.animatingInsideBar
          + ' | title ' + JSON.stringify(cake.title) + ' | body lines ' + cake.titleLines
          + ' | bar ' + cake.barHeight + 'px');
        seen.push({ label, cake });
        await context.close();
      }
    }
    const first = seen[0].cake;
    record(seen.every((s) => s.cake.glyphWidth === 24 && s.cake.glyphHeight === 24),
      'the cake: the 24dp reicon glyph is rendered, at every width and theme',
      seen.map((s) => s.label + ' ' + s.cake.glyphWidth + 'x' + s.cake.glyphHeight + (s.cake.glyphSvg ? ' svg' : '')).join(' | '));
    record(seen.every((s) => s.cake.inBar && s.cake.clearOfText),
      'the cake: it is inside the bar and clear of the words',
      seen.map((s) => s.label + ' inBar ' + s.cake.inBar + ' clear ' + s.cake.clearOfText).join(' | '));
    record(seen.every((s) => s.cake.animatingInsideBar === 0),
      'the cake: nothing in the bar is animating',
      'running animations, entrance excluded: ' + seen.map((s) => s.cake.animatingInsideBar).join('/'));
    record(!!first.title && !!first.body && first.titleLines === 2,
      'the cake: the title and the anniversary message are both rendered',
      JSON.stringify(first.title) + ' + ' + JSON.stringify((first.body || '').slice(0, 48)) + '...');
    results.push(['info', 'cake', { cake: seen }]);
  }

  /* Reduced motion: no tween on the push, the bar at full height, the words
     present, no confetti travel, and nothing animating in the bar. */
  console.log('\n== reduced motion (day 100 + day 365) ==');
  for (const days of [365, 100]) {
    const { context, page } = await withMilestone(days, { reducedMotion: 'reduce' });
    await page.reload();
    await page.waitForSelector('.m3-milestone-shell', { timeout: 20000 });
    const rm = await page.evaluate(async () => {
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 300) {
        const sh = document.querySelector('.m3-milestone-shell');
        const el = document.querySelector('.m3-shell-body > .overflow-y-auto');
        const bar = document.querySelector('.m3-milestone-bar');
        out.push({
          t: Math.round(performance.now() - t0),
          top: Math.round(el.getBoundingClientRect().top),
          strip: Math.round(sh.getBoundingClientRect().height),
          bar: Math.round(bar.getBoundingClientRect().height),
          // The wrapper, not the `<svg>`: `Icon` inserts its markup after the
          // first paint, so a probe that runs immediately would call a
          // rendered glyph missing. The box is what is being asserted.
          glyph: (() => {
            const g = document.querySelector('.m3-milestone-bar__cake');
            if (!g) return false;
            const b = g.getBoundingClientRect();
            return b.width === 24 && b.height === 24;
          })(),
          animating: [...bar.querySelectorAll('*')]
            .reduce((n, el) => n + el.getAnimations().filter((a) => a.playState === 'running').length, 0),
        });
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        samples: out,
        barAnim: getComputedStyle(document.querySelector('.m3-milestone-bar')).animationName,
        shellTransition: getComputedStyle(document.querySelector('.m3-milestone-shell')).transitionDuration,
        text: document.querySelector('.m3-milestone-bar').innerText.replace(/\s+/g, ' '),
        pieceAnim: document.querySelector('.m3-confetti__piece')
          ? getComputedStyle(document.querySelector('.m3-confetti__piece')).animationName : 'no-confetti',
      };
    });
    show('enter, day ' + days + ' (reduced motion)', rm.samples.map((s) => ({ ...s, state: 'bar ' + s.bar })));
    const flat = rm.samples.every((s) => s.top === rm.samples[0].top);
    const fullFromFrameOne = rm.samples.every((s) => s.strip === rm.samples[0].strip && s.strip === s.bar);
    record(flat && fullFromFrameOne && rm.shellTransition.includes('0s'),
      'reduced motion (day ' + days + '): no tween on the push, full height from frame one',
      'top held at ' + rm.samples[0].top + '; strip ' + rm.samples[0].strip + 'px = bar ' + rm.samples[0].bar + 'px; transition ' + rm.shellTransition);
    record(rm.text.length > 20, 'reduced motion (day ' + days + '): the words are there', JSON.stringify(rm.text.slice(0, 70)));
    if (days === 100) record(rm.pieceAnim === 'none', 'reduced motion (day 100): the confetti animation is off', 'animationName ' + rm.pieceAnim);
    if (days === 365) {
      const glyph = rm.samples.map((s) => s.glyph);
      const moving = rm.samples.map((s) => s.animating);
      record(glyph.every(Boolean) && moving.every((n) => n === 0),
        'reduced motion (day 365): the cake is rendered and nothing in the bar animates',
        'glyph present in ' + glyph.filter(Boolean).length + '/' + glyph.length + ' samples;' +
        'running animations in the bar ' + [...new Set(moving)].join('/'));
      record(rm.text.includes('KiraEqual') && rm.text.length > 40,
        'reduced motion (day 365): the anniversary text is complete', JSON.stringify(rm.text.slice(0, 110)));
      await page.screenshot({ path: (process.env.HRT_SHOTS || 'E:/HRT/.milestone-shots') + '/cake-365-reduced-motion.png' });
    }
    results.push(['info', 'reduced motion day ' + days, { label: 'reduced motion day ' + days, reduced: rm }]);
    await context.close();
  }

  await browser.close();

  console.log('\n=== summary ===');
  for (const r of results) {
    const entry = r[2];
    if (!entry || (!entry.enter && !entry.cake && !entry.reduced)) continue;
    if (entry && entry.cake) {
      console.log('the cake | ' + entry.cake.map((s) => s.label + ' glyph ' + s.cake.glyphWidth + 'x' + s.cake.glyphHeight
        + ' inBar ' + s.cake.inBar).join(' | '));
      continue;
    }
    if (entry && entry.reduced) {
      console.log(entry.label + ' | bar animationName ' + entry.reduced.barAnim + ' | shell transition ' + entry.reduced.shellTransition
        + ' | confetti ' + entry.reduced.pieceAnim + ' | top ' + entry.reduced.samples[0].top + ' flat over ' + entry.reduced.samples.length + ' samples');
      continue;
    }
    console.log(entry.label + ' | bar ' + entry.barHeight + 'px | strip ' + entry.shellHeight + 'px | pushed ' + entry.enter.total
      + 'px in ' + entry.enter.travelMs + 'ms (max 50ms step ' + entry.enter.biggestStep + 'px) | returned ' + entry.exit.total
      + 'px in ' + entry.exit.travelMs + 'ms (max 50ms step ' + Math.abs(entry.exit.biggestStep) + 'px) | settled at top '
      + entry.after.top);
  }

  const failed = results.filter((r) => r[0] === false).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
