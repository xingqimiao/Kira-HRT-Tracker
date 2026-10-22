> 中文版：[about.md](about.md)

# Kira HRT Tracker

Dose log · level estimates · privacy first · open source (MIT)

Record what you took and when, estimate the curve with a population pharmacokinetic model, and feed your own blood tests back in so the model fits you. It is a record book, not a prescription.

- Web app: <https://hrt.kiramyao.com>
- Landing page: <https://hrt.kiramyao.com/about/en/>
- Source: <https://github.com/xingqimiao/Kira-HRT-Tracker>

---

## Who it is for

People on injectable, gel, oral or patch HRT who want to answer "roughly where are my levels this week", "was that dose too high", or "when should I get tested next" — without maintaining a spreadsheet by hand.

## Logging

- Routes: oral, sublingual, gel, injection, patch, and patch removal.
- Sublingual takes an absorption tier, converting "how long you held it" into a fraction absorbed. Two minutes under the tongue and ten are not the same dose.
- Gel records the product, application site and area, co-applied sunscreen or moisturiser, and wash-off time. All of those change absorption; without them the curve is only an average.
- Injections distinguish oil from aqueous vehicles — they release at different speeds.
- Patches record the nominal release rate (µg/day) and wear hours; removal links to the patch that was worn.
- Reusable one-tap templates, with undo.
- Three schedule shapes (N times a day, every x hours, every x days); overdue doses are highlighted on the overview with one-tap catch-up.
- Batch select and delete; table and timeline views.

## Estimates

- Two engines: the built-in model (2026 literature parameters) and the Transmtf engine, giving two comparable curves from one history. Switching changes the estimate only, never a record.
- Line or candlestick (OHLC) chart, 7 / 30 / all windows, target band behind the curve.
- Current level, time since the last dose and a dose-level reference, all on the first screen.
- Four calibrations: off, MIPD (MAP fit), EKF and OU-Kalman. Without labs the population model stands alone; with labs, calibration pulls it toward your own metabolism. You can fit on the data before a test (forward) or on everything (retrospective).
- Each curve shows its calibration multiplier, e.g. ×0.42 — the model's persistent overestimate of you, quantified.

## Labs and reminders

- Estradiol (pg/mL, pmol/L) and testosterone (ng/dL, nmol/L); two values at one instant are saved separately and share a timestamp.
- Monitoring items judged against reference thresholds — liver function, potassium and others — each notice naming its source and stating evidence rather than an instruction.
- Re-check reminders on the intervals the community reference recommends.
- Measured results sit beside the modelled curve: filled dot for the lab, hollow for the model.

## Lab-report OCR

Photograph a report and it is read on the device (PP-OCR on onnxruntime-web) — the image is never uploaded. The numbers are filled into the form for you to confirm before saving.

## Data and privacy

- Fully usable without an account: everything is written locally first, and the web build is an installable offline PWA.
- An account adds sync between devices and the AI assistant. Sync is incremental: only cloud changes are pulled, only local edits are pushed.
- Records are encrypted at rest with a per-account key, wrapped once by your password and once by a master key held in an HSM. In other words: the database holds no plaintext, and a password change rewraps that key without rewriting a single record. The service can unwrap it while you are signed in — which is what makes sync, share links and the MCP assistant work.
- Read-only share snapshots are sealed in the browser, with the key in the URL fragment — the server and its logs see ciphertext only.
- App lock: fingerprint or face, re-locks in the background, and the lock screen never shows a drug name.
- No ads, no analytics, no third-party trackers; without an account nothing leaves the device.
- Export everything, or delete the account outright.

## AI assistant

The app speaks MCP over Streamable HTTP: an assistant can read your records and write new doses or lab results without a manual export. Authorisation is a separate token you can rotate or revoke.

## Import / export

- JSON and CSV, and an export can be imported straight back.
- Also reads other trackers' data (Oyama, Transmtf, Featherline formats), with a count preview before importing.
- On Android the export goes through the system save dialog, so no storage permission is needed.

## Platforms

- Web: any modern browser, installable as a PWA and usable offline.
- Android: a Tauri 2 shell around the same front end, adding app lock, system export and predictive back.
- Seven languages: Simplified Chinese, Traditional Chinese, Cantonese, English, Japanese, Korean, Turkish — loaded on demand.
- Light, dark, or follow the system.

## Supported compounds

Grouped the way the dose panel groups them. Unless noted, each records a dose and takes part in the estimate.

### Estrogens · oral / sublingual
Estradiol valerate (EV) · 17β-estradiol (E2)

### Estrogens · gel
17β-estradiol gel · estradiol valerate gel

### Estrogens · injection
EV · estradiol enanthate (EN) · estradiol cypionate (EC) · estradiol benzoate (EB) · estradiol undecylate (EU)

### Estrogens · patches
Estradiol patches (50 / 100 / 150 / 200 µg/day) · removal records, linked to the patch worn

### Anti-androgens
Cyproterone acetate (CPA) · spironolactone · bicalutamide · GnRH analogues (record only)

### Progestins / SERM
Micronised progesterone · raloxifene

### Testosterone · gel / injection / capsules
Unesterified testosterone gel · testosterone cypionate (TC) · testosterone enanthate (TE) · testosterone undecanoate injection · testosterone undecanoate capsules

### Cyclical
Medroxyprogesterone acetate (MPA) · norethisterone

### Hair
Finasteride · dutasteride

(This list follows the app version; what the app offers is authoritative.)

## Get it

- Web: right here in the browser, with offline support.
- Android: <https://hrt.kiramyao.com/android/> or GitHub Releases.
- Store channel: the F-Droid build ships without Firebase and without a self-updater; the store handles updates.

## Open source and self-hosting

The app and the optional sync server are MIT-licensed and live in the same repository. Sync is optional: use it locally, run your own server, or skip accounts entirely. If you want to know what leaves the device, read the source — that is the only reliable answer.

## FAQ

**Do I need an account?**
No. Without one it is a complete offline record book; it simply will not sync between devices.

**Is my data uploaded?**
Only when you sign in and sync, and then encrypted. Photos and lab images never leave the device.

**How accurate is the estimate?**
Population models are rough — individuals can differ by a factor of several. With lab results, calibration pulls it toward you, but it stays an estimate and never becomes a measurement.

**What if I change phones?**
Sign in to the same account and sync; without an account, move across with an export file.

---

## Disclaimer

Estimates come from a population pharmacokinetic model, not from a blood test, and must not be used to decide a dose. Only a blood draw tells you the real level; always go by the laboratory report. This is not a medical device and does not provide medical advice.
