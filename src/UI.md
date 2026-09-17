# UI notes

Conventions for the interface. Read this before adding a screen or changing a
colour — most of what follows is a decision that is not obvious from the code.

## Where the surface values live

`src/index.css`, in the `@theme static` block, plus `:root:not(.dark)` beneath it.

Components refer to **roles**, never to palette steps:

    bg-[var(--color-m3-surface)]        surface
    text-[var(--color-m3-on-surface)]   text on any surface
    text-[var(--color-m3-on-surface-variant)]   secondary text

The `--color-m3-dark-*` set exists because the app was written as
`bg-[X] dark:bg[Y]` in ~250 places. Both sides are now filled with the same
dark-first values, so the default theme is not a special case — it is the theme.
The light palette overrides the roles in `:root:not(.dark)`, and nothing else has
to care which one is active.

**Dark is the default** (`App.tsx` theme initialiser), because this is a record
app read mostly at night. A stored choice in `app-theme` always wins.

### Adding a colour

Add the role to the `@theme static` block, add its light reading to
`:root:not(.dark)`, and use the role. Do not use a Tailwind palette step
(`text-red-500`, `bg-gray-100`) at a call site — the palette it came from was
scaffolding and has been swept out. Where a semantic utility is wanted,
`--color-cos-*` in the theme block maps to the same roles, giving `text-cos-error`
and friends.

## Layout

- **One bar, across the top.** `Sidebar.tsx` renders a 64px bar (`.m3-navbar`):
  the page colour at 88% with a blur, pill-shaped links, the current one *filled*.
  It is `position: fixed` and desktop-only; mobile keeps the floating bottom bar in
  `App.tsx`. `.scroll-pb-nav` reserves its height with `padding-top` at `md`.
- **Pages own their own measure.** The shell is full-bleed. Most pages cap at
  `max-w-2xl`; the dashboard widens to a two-column chart layout once there is data.
- **Sticky page headers** use a plain `top-0`, and pin correctly under the bar at
  both breakpoints with no desktop override. That is not an oversight: a sticky
  offset is measured from the scroller's *content* edge, which the bar's reserved
  `padding-top` has already moved 64px down. So `top-0` lands 64px on desktop and
  0 on mobile, where there is no bar. Adding `md:top-[var(--m3-navbar-height)]` on
  top of that padding counted the bar twice and pinned every header 128px down,
  with content scrolling through the gap above it.
- **The reading column** is capped and centred inside each page. It is what makes a
  dark page with hairlines feel composed rather than merely wide.

## Surfaces

`.m3-card` is the containment primitive: `--color-m3-fill-soft` (a 6% white wash)
and a single hairline, 20px corner, **no shadow**. Nothing in this app is
elevatable — a card groups, it does not float. Dialogs are the one exception, since
they genuinely sit over content they do not control.

Buttons are pills. `.btn-primary` is filled, `.btn-secondary` is outlined,
`.btn-ghost` is borderless. `.m3-icon-button` is the 48px round target for when an
icon *is* the control.

## Icons

Everything comes from `src/icons`, which re-exports `reicon` plus a small
`./compat` module for the glyphs reicon does not ship. Nothing imports
`reicon` or `lucide-react` directly.

`reicon` icons are **functions returning `SVGSVGElement`, not React components**, so
they render through one wrapper:

    <Icon icon={Heart} size={16} className="text-cos-primary" />

Not `<Heart size={16} />`. When an icon is a button's only content, the *button*
carries the `aria-label`; `Icon` sets `aria-hidden` otherwise.

Adding a glyph reicon lacks: add the name to `scripts/gen-compat-icons.mjs`,
run it, and commit the regenerated `src/icons/compat.ts`.

**Do not replace** `src/flag_svg/`, the pixel-cat sprite, `ShieldIcon`'s drawing, or
`ResultChart`'s marks — those are artwork and data marks, not icons.

## Motion

The `--md-sys-motion-*` tokens in `index.css` are spec values and are already
correct. Two rules that are easy to get wrong:

- Enter and exit use **different** curves. Entering decelerates, leaving
  accelerates. Do not reverse an entrance.
- `prefers-reduced-motion` must still **hide closed surfaces**: animating out is
  what removes them. The `[data-state="closed"]` properties in `index.css` do
  this, and removing the animation without them leaves a dismissed dialog on
  screen blocking the page.

## Verification

`vite build` proves it compiles; it does not prove it renders. Load the app and
walk the main views — a `reicon` icon passed the wrong way fails at runtime with
React error #31, which a build cannot catch.
