# Kira HRT — data interchange protocol

**English spec** · [中文指南](hrt-import-export-protocol.zh-CN.md)

This document is for the authors of **other HRT trackers** who want their users to be
able to move their history into *Kira HRT Tracker* (and, where they choose, back out).

It has two halves:

1. **What you can write** — the JSON our importer reads. Write this and your users can
   bring their data here in one step.
2. **What we write** — our own export format, and how to read it if you want to accept
   files *from* us.

Both directions are the same shape, deliberately. There is no separate "import format"
and "export format" to keep in step.

> **Read this in Chinese**: [`hrt-import-export-protocol.zh-CN.md`](hrt-import-export-protocol.zh-CN.md)
> is a step-by-step guide — field tables, working example code, a self-test checklist, and a
> prompt you can hand an AI assistant. **This** document stays the authority on field
> definitions; where the two disagree, this one wins.

---

## 1. The shapes are already close

This app is a fork of [Oyama's HRT Tracker][oyama], which is itself downstream of
[Mihari's PK core][mihara]. That lineage is why the formats below will look familiar: we
did not invent a schema, we inherited one and grew it. If your app descends from the same
line, you are probably already writing most of this and only need §4 to close the gap.

[oyama]: https://github.com/xunxunProjects/Oyama-s-HRT-Tracker
[mihara]: https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test

---

## 2. The minimum a file must carry

A file with just this imports cleanly:

```json
{
  "format": "kira-hrt",
  "version": 1,
  "events": [],
  "labResults": [],
  "weight": 62
}
```

- **`format`** — the string `"kira-hrt"`. Present so a reader can identify the file
  without guessing from its shape. See §3 for why that matters.
- **`version`** — protocol version, currently `1`. A reader that does not understand a
  higher number should refuse rather than guess.
- **`events`** — dose records (may be empty; may be omitted).
- **`labResults`** — blood-test records (may be empty; may be omitted).
- **`weight`** — the user's body weight in **kg** (may be omitted).

Everything else is optional. **A section you omit is left untouched on the importing
side; a section you send as `[]` clears it.** That distinction is load-bearing — see §6.

---

## 3. `format`, and why the field exists

Without it, a reader has to recognise the format from the keys present. That works until
two formats share keys — and ours does: this app was forked from Oyama, so an Oyama file
and a Kira file both carry `meta`, `modes`, `events` and `labResults`. Shape-sniffing
cannot separate them, and picking wrong is a silent misread rather than an error.

So the identifier is explicit. **If you write one field for us, write `format`.** We also
accept a file with no identifier at all by falling back to shape detection, but that path
is the one that can be wrong.

---

## 4. Records

All timestamps are the same unit throughout: **`timeH` is hours since the Unix epoch**
(1970-01-01T00:00:00Z), *not* milliseconds, *not* a date string.

```
timeH = (epochMilliseconds) / 3_600_000
```

A record dated 2025-06-01T12:00:00Z has `timeH = 487_020`. This is the single most common
mistake when writing a converter — a millisecond value silently imports as a date in 1970.

### 4.1 `events[]` — a dose

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | Any unique string. A UUID is what we generate; yours need only be unique within the file. |
| `timeH` | number | yes | Hours since epoch (§4). |
| `route` | string | yes | One of the route values in §5. Unrecognised → the row is skipped. |
| `ester` | string | recommended | One of the ester values in §5. Unrecognised → coerced to `"E2"`. |
| `doseMG` | number | yes | Milligrams of **the substance named in `ester`** — the ester itself, or the anti-androgen. See §7. |
| `extras` | object | no | Route-specific detail; see §4.3. |

### 4.2 `labResults[]` — a blood test

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | As above. |
| `timeH` | number | yes | Hours since epoch. |
| `concValue` | number | yes | The concentration, in `unit`. |
| `unit` | string | yes | `"pg/ml"`, `"pmol/l"`, `"ng/dl"` or `"nmol/l"`. |
| `analyte` | string | recommended | `"E2"`, `"T"` or `"unknown"`. The hormone this reading measures. **Send it**; when absent Kira stores `unknown` rather than guessing from the unit. |

The first two units are estradiol units; the last two are testosterone units. A record
carrying neither a hormone value nor any monitoring field is skipped.

**`analyte` is authoritative.** `"T"` with `"pg/ml"` is a testosterone reading that was
mislabelled — it is routed as T, never as E2. `"E2"` with `"ng/dl"` is the reverse.
A missing or invalid value is stored as `"unknown"`, and unknown labs are kept but
**excluded from every calibration fit** (E2, T and background E2) until the user confirms
the type. This is deliberate: inferring from the unit is how a mislabelled T result used
to contaminate an E2 fit.

Optional monitoring values may ride on the same record: `prolactin`, `prolactinUln`,
`alt`, `altUln`, `ast`, `potassium`. Send them only if you have them — a record with
monitoring values and no hormone reading should also set `"monitoringOnly": true`.

### 4.2.1 Legacy backups without `analyte`

Backups written before the field existed carry only `unit` + `concValue`. On import Kira
keeps every record but labels the labs `unknown`; they are visible and exported, but not
used for calibration.

The import **preview** therefore offers a one-time, user-confirmed compatibility option
when it detects such rows:

```
pg/ml, pmol/l -> E2
ng/dl, nmol/l -> T
```

The checkbox is on by default for a legacy file and can be cleared before confirming.
It applies only to that import; it is never applied to an explicit `"unknown"`, and never
used for live API/MCP writes. Without it, the labs stay unknown until the user edits each
one and chooses E2/T.

Users upgrading from an old backup should be told that the unit mapping is a convenience,
not proof: a unit that was wrong in the old data will still be wrong after the import.

### 4.3 `extras` — route detail

A bag of route-specific values. Send only the keys that apply. Almost all of them are
numbers; the two patch-identity keys are strings.

| key | type | route | meaning |
|---|---|---|---|
| `sublingualTier` | number | sublingual | 0–3 = quick / casual / standard / strict |
| `sublingualTheta` | number | sublingual | absorbed fraction 0–1 (overrides `sublingualTier`) |
| `releaseRateUGPerDay` | number | patchApply | patch release rate, µg/day |
| `patchWearH` | number | patchApply | planned wear, hours |
| `gelSite` | number | gel | 0–3 = arm / thigh / scrotal / abdomen |
| `gelProductId` | number | gel | 1–5 for the presets, ≥1000 for a user product (§8) |
| `gelCoverage` | number | gel | 0–6 = product / palm1 / palm2 / palm3 / thigh / arm / arms2 |
| `gelCoApplied` | number | gel | 0–2 = none / sunscreen / moisturizer |
| `gelWashAfterH` | number | gel | hours after application the site was washed |
| `concentrationMGmL` | number | gel | product concentration, mg/mL |
| `areaCM2` | number | gel | application area, cm² |
| `patchInstanceId` | **string** | patchApply | the identity of this patch, for pairing with a removal; the record's own `id` when omitted |
| `patchRemovalFor` | **string** | patchRemove | the `id` of the `patchApply` this removal ends |

Unknown keys are ignored.

---

## 5. Enumerations

These are the exact strings. Anything else is rejected or coerced, as noted above.

**`route`**

```
sublingual  injection  patchApply  patchRemove  gel  oral
```

**`ester`**

| value | substance |
|---|---|
| `E2`  | unesterified estradiol |
| `EB`  | estradiol benzoate |
| `EV`  | estradiol valerate |
| `EC`  | estradiol cypionate |
| `EN`  | estradiol enanthate |
| `EU`  | estradiol undecylate |
| `CPA` | cyproterone acetate |
| `SPIRO` | spironolactone |
| `BICAL` | bicalutamide |
| `T`   | unesterified testosterone |
| `TC`  | testosterone cypionate |
| `TE`  | testosterone enanthate |
| `TU`  | testosterone undecanoate |
| `P4`  | micronised progesterone |
| `MPA` | medroxyprogesterone acetate |
| `NET` | norethisterone |
| `RALOX` | raloxifene (a SERM) |
| `FIN` | finasteride |
| `DUT` | dutasteride |
| `GNRH` | a GnRH analogue |

`CPA`, `SPIRO`, `BICAL`, `P4`, `MPA`, `NET`, `RALOX`, `FIN`, `DUT` and `GNRH` are
**recorded but not modelled**: the record is stored, synced and exported exactly like any
other, and the PK engine simply draws no curve for it. They are carried in the `ester`
field because a record has to name its substance somehow. Send them as-is; do not convert
them to an estradiol or testosterone equivalent.

---

## 6. The absent-vs-empty rule

This is the one semantic that will bite you if you do not design for it.

- A section **absent** from your file means *"this file says nothing about that section —
  leave the target's data alone."*
- A section present and **empty** (`"events": []`) means *"there are none — clear it."*

So an events-only export must **omit** `labResults` rather than send it as `[]`, or
importing it into an account that has labs will wipe them. Our own export writes every
section explicitly, because a backup is meant to be a complete statement; a partial
export (one collection, for a transfer) omits what it does not carry.

---

## 7. `doseMG` is the substance, not its estradiol equivalent

This trips up most converters.

`doseMG` is the mass of the drug the user actually took. A 2 mg estradiol valerate tablet
has `doseMG: 2` and `ester: "EV"` — *not* `1.53`, which is its estradiol equivalent.
The equivalence, if you compute it, is a simulation input, not a record field. Send the
label's number.

The same rule for anti-androgens: 12.5 mg of cyproterone acetate is `doseMG: 12.5`,
`ester: "CPA"`. It has no estradiol equivalent and none should be invented.

---

## 8. Optional collections

Identical rules to §4, for a fuller transfer:

- **`doseTemplates[]`** — a saved dose shape. Fields: `id`, `name` (string), `route`,
  `ester`, `doseMG`, `extras`, `createdAt` (epoch **ms**).
- **`journal[]`** — a private text note. Fields: `id`, `timeH`, `note` (≤2000 chars).
  An entry with no words is not stored.
- **`quickDoses`** — one-tap dose buttons, per mode (see §9).
- **`weightUpdatedAt`**, **`pkParams`**, **`pkParamsUpdatedAt`** — account settings, for a
  full backup. Omit these in a transfer.

### Gel products

`gelProductId` addresses a **catalogue**: ids 1–5 are the built-in presets (oestrogel,
estreva, estrogel, divigel, and a DIY entry) and ids ≥1000 are user-defined. The catalogue
is persisted, so a custom product's name, concentration and absorption constants travel
with the file and survive the import:

- a `gelProducts[]` array at the top level is merged into the account's catalogue;
- our own export carries the same list at `appState.settings.gelProducts`.

One limitation remains: ids 1–5 are **ours**. A file that uses a preset id for a product
that is not that preset will resolve to our preset. A custom product should therefore be
given an id ≥1000, not a preset id.

---

## 9. Multi-mode files

The protocol above is the **flat** shape: one `events` list, for whoever is reading it.
That is what a transfer between apps should use.

Our own export wraps both HRT modes, because an account can hold records for both:

```json
{
  "format": "kira-hrt",
  "meta": { "version": 3, "exportedAt": "2025-06-01T12:00:00.000Z" },
  "mode": "transfem",
  "weight": 62,
  "modes": {
    "transfem": { "events": [], "labResults": [], "doseTemplates": [], "quickDoses": [], "journal": [] },
    "transmasc": { "events": [], "labResults": [], "doseTemplates": [], "quickDoses": [], "journal": [] }
  },
  "events": [],
  "labResults": [],
  "doseTemplates": []
}
```

The flat keys mirror the **currently active mode**, so a reader that ignores `modes`
still gets that mode's data. A reader that wants both reads `modes`. When writing *to* us,
use whichever suits you: `modes` if you distinguish transfeminine and transmasculine
records, flat `events`/`labResults` if you do not.

Our export carries `analyte` on every lab where it is known. Exports written before that
field existed do not; they import as `unknown` unless the user accepts the one-time legacy
unit mapping described in §4.2.1.

---

## 10. Encrypted files (optional)

Both this app and Oyama support a password-encrypted envelope, and we can read each
other's. The envelope is:

```json
{
  "encrypted": true,
  "iv":    "<base64, 12 bytes>",
  "salt":  "<base64, 16 bytes>",
  "iter":  600000,
  "data":  "<base64, AES-GCM ciphertext + 16-byte tag>"
}
```

- **Key derivation** — PBKDF2-HMAC-SHA-256 over the UTF-8 password, using `salt`, for
  `iter` iterations, producing a 256-bit key.
- **Cipher** — AES-GCM, `iv` as the nonce.
- **Encoding** — `data` is base64 of the raw ciphertext *with the GCM tag appended*.

`iter` is read from the file. Our reader accepts anything in `[100000, 1000000]` and
falls back to `100000` outside it — a file declaring no `iter` (as Transmtf's does) is
therefore read at 100000. So our reader handles both the 600000 this app writes and the
100000 Transmtf writes. Write 600000 if you are choosing.

An encrypted **Oyama cloud** bundle (`{"cloud":1,"iv":…,"data":…}`) is a different thing —
its key is derived from the account's password *and* its user id, so it cannot be opened
by anyone who does not hold that id. We do not support those; ask the user to export the
password-protected file instead.

---

## 11. What we can read today

For the three projects this document was written alongside:

| source | plaintext | password-encrypted |
|---|---|---|
| **Kira HRT** (this app) | ✅ | ✅ |
| **Oyama's HRT Tracker** | ✅ | ✅ (same envelope) |
| **Transmtf HRT Tracker** | ✅ | ✅ (PBKDF2 100000) |
| **Featherline** | — | ✅ (binary `HRTBKP1` envelope; see their `docs/backup-format.md`) |

Featherline's is not JSON at all: a 65-byte header (`HRTBKP1` magic, Argon2id parameters,
salt, nonce) followed by AES-256-GCM ciphertext over `gzip(json)`, the whole header fed in
as additional authenticated data. We parse and decrypt it directly rather than asking
Featherline to change. **If you are writing a new exporter, use the JSON in §2–§9**; the
binary path exists only because that file format already shipped.

### Two notes for anyone implementing a reader

Both came out of testing against a real backup rather than a fixture, and both cost a
round to find:

**1. A Featherline dose carries float-reconstruction noise, and it must be rounded.**
Their dose is *derived* (a strength divided by a ratio, or a fraction of a strength)
rather than stored, so a 12.5 mg tablet arrives as `12.499934062706513`. Written
straight through, that puts a meaningless run of digits in the user's timeline on every
such record, and it is the kind of wrong that makes them distrust the whole import.
We round to **three significant figures**, which recovers what was typed
(`12.499934 → 12.5`, `8.25063 → 8.25`, `10.000253 → 10`) while a genuinely precise
`0.935` survives. Featherline does the same on its own side, at six figures.

**2. An imported gel stores its dose in `strengthMgPerVial`, and that is correct.**
It looks suspicious that a gel's `strengthMgPerVial` equals its `equivalentE2Mg` — but
for a gel the applied estradiol *is* the PK input, so the two are the same number by
construction, not by mistake. For a pill they differ, which is why a reader must take
the substance's own mass (`strengthMgPerTablet` × fraction) and never
`equivalentE2Mg`. See §7.

Our own reader is verified against a real 18 KB backup: 284 doses and 2 labs mapped
with nothing skipped. That is one file from one person, so treat it as evidence that
the format is read correctly rather than as coverage of every variation.

---

## 12. Checking your output

1. **Validate the JSON.** It must parse.
2. **Check `timeH` is in hours.** Multiply your epoch-ms timestamp by nothing and divide
   by 3 600 000. Spot-check one record against the date you expect.
3. **Check `doseMG` against a label.** If your value is smaller than the printed dose, you
   have sent an estradiol equivalent instead of the substance.
4. **Import it into a scratch account** and confirm the count and the earliest date match
   what you exported.
5. If a row is skipped, it is almost always `route` or `timeH` — those two are the fields
   that reject rather than coerce.

We welcome issues and pull requests against this document:
<https://github.com/xingqimiao/Kira-HRT-Tracker>.
