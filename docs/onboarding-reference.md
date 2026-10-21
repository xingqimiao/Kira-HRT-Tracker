# Onboarding flow — handoff reference for an external agent

This document maps the first-run introduction so an agent without repository access can propose improvements against the right screens, behavior, assets and constraints. It is a navigation and behavior brief, not a verbatim copy of the source code. The implementation remains in the repository paths below; if code changes are requested, first ask the repository owner to provide the relevant source files.

The design source of truth is `docs/m3e-onboarding-prototype.html` — an M3 Expressive "Pixel phone activation" prototype. `src/pages/Onboarding.tsx` and `src/onboarding.css` are a port of it, not a re-interpretation: geometry, easing and timing come from that file.

## Product purpose and entry behavior

The onboarding is a full-screen, multi-step first-run flow. It chooses the language and HRT mode, collects optional start-date/weight settings, explains data import, offers the Android/PWA install, states the privacy and medical position, and ends on a blessing card. It renders instead of the main application shell so a new user cannot navigate away before setting language and mode.

- Entry and first-run gate: `src/App.tsx` initializes `showOnboarding` using `shouldShowOnboarding()` and renders `<Onboarding />` when true.
- Eligibility and completion persistence: `src/pages/Onboarding.tsx` exports `shouldShowOnboarding()` and `markOnboardingSeen()`. The local-storage flag is `app-onboarded=true`. Existing event data also suppresses the first-run flow to avoid showing setup to existing users.
- Replay: Settings provides a replay action, handled in `src/App.tsx` through `replayOnboarding`. During replay, the start-date and weight steps are read-only (`ob2.date_locked` is shown in place of the date hint); do not change that protection.
- Data writes: start date and body weight are committed using callbacks passed from `App.tsx`, not direct local-storage writes. Keep account-scoped data semantics intact.
- Import writes: the import row calls `onImportJson`, which is `importEventsFromJson` in `App.tsx` — the same pipeline the data screen uses, including the password sheet an encrypted backup opens. Do not add a second parser.
- Native builds: `isNativeApp()` filters the Android/PWA step out of the step list, so the flow is seven steps inside the Tauri Android client and eight on the web.

## Current step order

The active sequence is assembled from `ALL_STEPS` in `src/pages/Onboarding.tsx`; each entry carries the petal count and depth of the badge behind the vial.

1. `lang` — language. Seven languages; the one matching the device is the full-width top row (`.lang-card.sys-top`), the other six sit in a 3×2 grid. No card is labelled "system language".
2. `type` — HRT type. Two asymmetric tiles: feminising (MTF) and masculinising (FTM).
3. `date` — HRT start date. A tappable `.li` row opens the app's own `TimePage` date picker; a second row is the "haven't started yet / later" switch.
4. `weight` — body weight. A hero tile with −/+ steppers, a large numeric field and 45/55/65/75 kg presets.
5. `import` — import from another app. Opens a file picker; compatible with Kira / Oyama / Transmtf / Featherline exports.
6. `app` — Android client download and PWA install (web only; omitted on native).
7. `privacy` — hardware security module + system Keystore, then the not-a-medical-device statement.
8. `bloom` — the closing blessing card with the five-stripe transgender flag.

Navigation is a top bar (back pill, segmented progress, `n / m`) and a bottom bar (Skip, Next; the last step replaces both with a single "Enter Kira HRT Tracker" button). There is no per-step "skip this question" CTA: leaving the date unset is itself an answer, and the weight has a default.

## Motion rules (do not regress these)

- `[data-m]` press: one delegated `pointerdown` listener on the root adds `.mo`, which morphs `border-radius` to `--mo` and scales to `.95`; release clears it after 260 ms. The class is written to the DOM directly rather than held in React state, so the transition starts on the same frame as the touch.
- Selection: `.on` on a language card morphs `22px → 99px`; on an HRT tile it morphs to the asymmetric leaf (`42px 16px 42px 16px` / `16px 42px 16px 42px`); on a weight preset `14px → 99px` plus `scale(1.04)`.
- Page transition: `.page-anim` is keyed by step id **only**. A tap inside a step changes classes and nothing else — re-keying on a selection would remount the panel and replay the entrance animation on every tap.
- The seven greetings are stacked in one grid cell (`.stack-cell`) with the inactive ones `invisible`, so the block is as tall as the longest and choosing a language never moves the grid under the finger.
- `prefers-reduced-motion: reduce` disables the page fade and the vial float.

## Source map

- `src/pages/Onboarding.tsx`: step list, lifecycle helpers, all eight panels, press delegation, install-prompt capture, import wiring.
- `src/onboarding.css`: the whole visual layer, scoped under `.ob2` (the prototype reuses very short names — `.li`, `.t`, `.s`, `.ic` — that already exist in `m3e.css`).
- `src/components/TimePage.tsx`: the in-app date picker the date step opens.
- `src/components/Icon.tsx` + `src/icons`: every glyph. There are no emoji anywhere in the flow.
- `src/App.tsx`: first-run state, standalone rendering, props/data writes, replay handler, `importEventsFromJson`.
- `src/contexts/LanguageContext.tsx`: language loading, persisted language and fallback behavior. Onboarding calls `ensureAll()` because it renders the seven greetings together before a language is selected.
- `src/contexts/HRTModeContext.tsx`: global mode selection.
- `src/utils/nativeUpdate.ts`: Android APK URL, resolved from the update manifest with the version-derived URL as fallback.
- `src/utils/platform.ts`: `isNativeApp()`, which decides whether the `app` step exists.
- `src/pages/Settings.tsx`: replay entry point.

`src/components/IntroCard.tsx` and `src/components/OnboardingFeatures.tsx` are no longer imported by the flow — they belong to the previous design and are kept only until the owner decides otherwise.

## Visual assets

Everything on screen is drawn in JSX or inline SVG; there are no onboarding image files:

- the pixel vial (`PixelTube`) and its two rising bubbles,
- the rose-curve badge behind it (`cookiePath`), whose lobes change per step,
- the pixel tick on a chosen language (`PixelCheck`),
- the five-stripe transgender flag (`viewBox="0 0 54 34"`, `preserveAspectRatio="none"`, bands overlapping by 0.4 units so no scale factor can open a hairline between two of them).

`public/pwa-512x512.png` is no longer used by the flow.

## Localization

The seven language packs are `src/i18n/langs/{zh,en,ja,ko,tr,yue,zh-TW}.ts`. The flow's own copy lives under the `ob2.*` namespace (43 keys), plus `onboarding.sendoff_line` and `onboarding.sendoff_flag_alt` which it shares with the previous design. Only the language step carries a subtitle; every other step is a title and a panel. `\n` inside a pack value is a line break — the component turns it into `<br>`, it is not HTML.

Keep keys aligned across all seven packs; validate with:

```sh
node --experimental-transform-types scripts/check-i18n-coverage.mjs --strict
```

`src/i18n/types.ts` defines the language IDs and order. The language picker values are assembled in `src/App.tsx` using native-script labels.

## Visual and behavioral constraints for proposed improvements

- Preserve language selection before explanatory copy; a new user may not understand the default language.
- Preserve replay's read-only start date and weight, and keep account-scoped setting writes routed through callbacks/data layer.
- Keep the `app` step conditional on `isNativeApp()`.
- The privacy step must say "hardware security module / system Keystore". It must not claim end-to-end encryption.
- The medical statement is a statement, not a disclaimer to be softened: the curves are estimates, the app is not a medical device, and it does not prescribe.
- Keep accessibility: keyboard-operable rows, `aria-pressed` on selections, a labelled progress bar, readable contrast, focus treatment and reduced-motion support.
- Keep the seven translations complete. Do not introduce text baked into images when it should be localized.

## Recommended handoff request

Ask the external agent to first return a screen-by-screen critique and a prioritized redesign proposal, including copy/layout/accessibility/motion suggestions, and to identify exactly which source files it would change. The external agent cannot inspect this repository, so do not ask it to implement edits directly. Have it return proposed code or a patch only after you provide the relevant source excerpts. Avoid deployment, release packaging or publication; those require separate explicit authorization.
