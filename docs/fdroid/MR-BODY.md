## Abstract for new app inclusion

**What it does, and how it is used.** Kira HRT is a private record book for hormone
replacement therapy. You log each dose — oral, sublingual, gel, injection or patch,
with the details that change absorption — and the app estimates your estradiol or
testosterone level from that history with a pharmacokinetic model. Blood tests you
enter pull the estimate toward your own metabolism (four calibration methods; the
curve shows its calibration multiplier, e.g. ×0.42). Lab reports can be read from a
photo, on the device. Everything is stored on the device first: without an account it
is a complete offline app; an account only adds cross-device sync, and records are
sealed with a per-account key before they leave the phone.

**Why I wrote it.** I take HRT myself and wanted a log that answers "roughly where are
my levels this week" without keeping a spreadsheet, and one that learns from my own lab
results instead of showing a population curve. The trackers I looked at were either
web-only, required an account for basic use, or showed a dose list with no estimation
at all.

**What is unique here.** There is no HRT tracker in F-Droid. Beyond a dose log this app
carries: two selectable pharmacokinetic engines, four calibration methods fitted to your
own blood tests, on-device OCR of lab reports (PP-OCRv6 through ONNX Runtime), optional
end-to-end-encrypted sync (the server holds no key material of its own), optional
connection to an AI assistant over MCP, and seven languages with phone and tablet
layouts.

Screenshots, also in `fastlane/metadata/android/{en-US,zh-CN}/images/phoneScreenshots`:
[overview](https://github.com/xingqimiao/Kira-HRT-Tracker/raw/v2.0.4/fastlane/metadata/android/en-US/images/phoneScreenshots/1-overview.jpg) ·
[add dose](https://github.com/xingqimiao/Kira-HRT-Tracker/raw/v2.0.4/fastlane/metadata/android/en-US/images/phoneScreenshots/2-add-dose.jpg) ·
[history](https://github.com/xingqimiao/Kira-HRT-Tracker/raw/v2.0.4/fastlane/metadata/android/en-US/images/phoneScreenshots/4-history.jpg) ·
[calibration](https://github.com/xingqimiao/Kira-HRT-Tracker/raw/v2.0.4/fastlane/metadata/android/en-US/images/phoneScreenshots/7-calibration.jpg)

## Licence

GPL-3.0-or-later since 2.0.4. The repository was MIT before that; GPL applies because
the `.hrtbackup` reader derives from Featherline's GPL-3.0 container code. Upstream
notices are preserved item by item in `THIRD-PARTY-LICENSES.md`: Oyama (MIT),
Transmtf (MIT), the Mihari model grant, Featherline (GPL-3.0).

## Build, and what the store flavour strips

Tauri 2 (Rust) + Vite front end. The store build sets `HRT_NO_FCM=1` and
`VITE_NO_SELF_UPDATE=1`:

- no Firebase/FCM anywhere in the APK — verified: 0 `com/google/firebase` references in
  `classes.dex`. The plugin's push half is patched out of the vendored notifications
  crate; its local-notification half is untouched.
- no self-update path — the update manifest URL is folded out of the bundle and the
  "check for updates" item is not rendered. Updates come from F-Droid.

`src-tauri/gen/` is generated, so the recipe runs `tauri android init` before the Gradle
build, and crates need `cargo vendor` for the offline step. The `Builds:` block is the
part I expect to iterate on with you.

## Two things worth your judgement

1. **The pharmacokinetic model is non-commercial.** `LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test`
   declares no licence file; its author granted this project non-commercial use in
   correspondence on 2026-09-18, recorded in full in `THIRD-PARTY-LICENSES.md`. The
   app's own code is GPL-3.0-or-later, the model is not. Flagging it now rather than
   leaving it to be found at build time — if it makes the app ineligible for the main
   repository, say so and I will withdraw the MR.
2. **The scanner downloads its assets on first use.** About 23 MB — PP-OCRv6 detector and
   recogniser (Apache-2.0) plus the ONNX Runtime wasm (MIT) — from our own origin,
   triggered by the user opening the scan feature, cached afterwards, no CDN, nothing at
   start-up. Happy to bundle them into the APK (about +44 MB) if that is required
   instead.

## Reproducible builds

Not enabled yet, and I would rather say why than leave it blank: the front end is built
by Vite at build time and embedded into the Rust binary, so byte-identical output
depends on pinned Rust, Node and NDK toolchains plus vendored crates. That pinning is
the iteration I expect on `Builds:`; once the recipe is stable I am glad to work on
reproducibility. F-Droid signing in the meantime is fine by me — users coming from our
own signed APK will need one reinstall, because the keys differ.

## Metadata

`fastlane/metadata/android/` in the app repo at the pinned commit: `en-US` and `zh-CN`,
9 / 8 phone screenshots, icon, and the `2000004.txt` changelog. The metadata file is the
only change in this MR.
