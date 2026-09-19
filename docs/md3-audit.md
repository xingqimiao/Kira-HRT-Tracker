# MD3 audit and token decision — 2026-09-20

Target: `E:\HRT` web UI (React 18 + Vite + Tailwind v4, no component library).
Method: source audit of `src/` plus measurements in the built app
(`npx vite build` + `vite preview`, computed styles read with Playwright).
Written after the first implementation pass, so "now" below means the state of
this commit and "next" is what is still owed.

## Score by category (0–10, per the material-3 skill's audit)

| Category      | Before | Now | Evidence |
|---------------|--------|-----|----------|
| Color tokens  | 6 | 9 | 44 `--color-m3-*` roles already existed and light/dark/key-blue were all covered, but the names were the app's own and `inverse-*`, `on-error`, `scrim`, `shadow` were missing. All 44 now have `--md-sys-color-*` aliases; the four missing roles were added to both themes. |
| Typography    | 3 | 8 | The weakest area: no typescale at all, and 325 Tailwind size utilities across 48 files (`text-xs` alone 163×). The 15 MD3 styles with size/line-height/weight/tracking are now tokens; the utilities were left in place on purpose (see "not done"). |
| Shape         | 6 | 9 | Radii existed as app tokens (`--radius-*`) and Tailwind's own `rounded-lg/xl/2xl` leaked in beside them. `--md-sys-shape-corner-*` now name them; the filled text field moved from 12dp to the spec's 4dp. |
| Elevation     | 6 | 9 | The tonal-first approach was already right; there was no level scale. `--md-sys-elevation-level0…5` now exist, with shadows only on 1–3. |
| Components    | 5 | 8 | The old layer had one focus state in the whole file (the switch) and hover implemented as a per-component colour swap. Buttons now have five emphasis levels, five sizes and a real state layer; fields have filled + outlined + error; cards have three variants; nav, list and snackbar are shaped by the spec. Still missing: bottom sheet, segmented button, chip, toolbar. |
| Layout        | 5 | 5 | `max-w-2xl` constrains the reading column and the 8dp spacing tokens now exist, but the ≥1280px `--ui-scale` root-font zoom is a non-MD3 answer to "the layout is undersized on a wide display" — window size classes and a rail at ≥840dp are the real fix, and neither is done. |
| Navigation    | 5 | 7 | The bar is still a floating island rather than a flush NavigationBar, but its items are now the spec's: a 32×64 secondary-container indicator behind the active icon, label-medium, on-surface vs on-surface-variant. No rail. |
| Motion        | 8 | 9 | M3 easing/duration tokens, separate enter/exit keyframes and three `prefers-reduced-motion` blocks were already in place. Added: the strengthened `--ease-out`/`--ease-in-out`/`--ease-drawer` curves, the first `@media (hover: hover) and (pointer: fine)` gating in the codebase, and reduced-motion coverage for everything new. |
| Accessibility | 4 | 8 | 54 aria attributes existed, but there was no visible keyboard focus anywhere except the switch and `.input-base` explicitly set `outline: none`. Now: one global `:focus-visible` ring (2px primary, verified 2px solid rgb(168,64,90) in the build), a 48dp touch-target helper, and error state driven by `aria-invalid`. |
| Theming       | 7 | 8 | Light/dark/key-blue all resolve through the role tokens (verified in the built app in both themes). No dynamic colour and no contrast levels — out of scope for a static site. |

Overall: ~53/100 before, ~80/100 now, with the remaining gap concentrated in
typography adoption and layout (window size classes).

## Bugs found and fixed on the way

- `#B3261E` was hard-coded as the error colour in 8 places across
  `CoreAuthForm.tsx` and `CoreAccountSettings.tsx`. That is the *light* theme's
  error role; on the dark surface it fails contrast. All 8 now use `text-cos-error`
  / `bg-cos-error` + `text-cos-on-error`, which switch with the theme.
- `.input-base` removed the focus outline with no replacement.
- The nav item's active icon was painted with the label colour instead of the
  indicator's, because the selector required the `<svg>` to be a direct child and
  `Icon` wraps it in a span. Found by measuring, not by reading.

## Token decision (the one the handoff asked to settle first)

Adopted the recommended **alias layer**: `--md-sys-*` points at the existing
`--color-m3-*` / `--radius-*` / `--shadow-m3-*` values, new components use the
spec names, old call sites keep working and migrate as they are touched. Aliases
are declared on `html` (via `@theme static`), the same element the light and
key-blue overrides live on, so theme switching still resolves correctly — verified
by reading computed values in both themes from the built bundle.

## Deliberate deviations

- **Typeface stays the system stack.** MD3's default is Roboto/Roboto Flex, but
  the privacy policy promises no third-party requests on page load, and a webfont
  CDN would break that. The stack already falls back to Roboto on Android.
- **The mobile bar stays a floating island.** The container is the app's; the
  items are the spec's. Making the bar flush is a navigation-structure change
  (and should come with a rail at ≥840dp), not a styling one.
- **Tailwind size utilities are not rewritten.** 325 call sites is a mechanical
  diff that would bury the reasoning; the tokens exist for new work, and the
  existing utilities already sit close to the scale (`text-sm` is exactly
  body-medium, 14/20).

## Next

1. Apply the typescale where it is semantically wrong today: headings that are
   `text-xs`/body weight, labels that are not 500, the 10px nav label.
2. Replace `--ui-scale` with window size classes + a constraint on the reading
   column, and add a navigation rail at ≥840dp.
3. Remaining components in order: bottom sheet (the dialogs' compact form
   already animates like one), segmented button, chip, toolbar.
4. Re-check the Caddy static-404 question below — it matters to every
   future deploy.

## Shipped

Deployed on 2026-09-19 19:10 (server local time), commit `35e4dd0`, using the
usual sequence: `git push origin main` → `VITE_API_ORIGIN=https://api.kiramyao.com/hrt`
`vite build` → local tar → scp to `/tmp` → `rsync -a --delete` into
`/srv/hrt-web`. The previous bundle was backed up first
(`/srv/hrt-web-backup-20260919-191010.tgz` on the host), and the **new service
worker was copied over the old file name** (`sudo cp /srv/hrt-web/sw-35e4dd0.js
/srv/hrt-web/sw-11902fe.js`), because `rsync --delete` removes the old name and a
client whose registered SW 404s can never update itself.

Verified against production, through Cloudflare rather than the origin:

- the served HTML references `sw-35e4dd0.js` and the new CSS, and the page runs
  with no console errors;
- `sw-35e4dd0.js` and the old name `sw-11902fe.js` return byte-identical
  `text/javascript` (so clients still on the old name recover on their own);
- the MD3 tokens resolve, the nav indicator shows 1/0 for active/inactive, the
  active icon is `rgb(4,34,46)` (on-secondary-container) and Tab puts a
  `2px solid rgb(168,64,90)` ring on the first control.

**Open observation.** The origin still answers
`curl -skI --resolve hrt.kiramyao.com:443:127.0.0.1 https://hrt.kiramyao.com/definitely-missing.js`
with `200` and `content-type: text/html` — the SPA fallback. So the "missing
static assets 404" change recorded as landed in `e90084d7` is not in effect on
this host right now. Nothing broke this time because both SW names really exist,
but the next deploy that introduces a new `sw-<commit>.js` re-opens exactly the
cache-poisoning window that change was made to close.
