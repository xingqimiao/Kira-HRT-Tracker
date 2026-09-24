# Kira HRT — data interchange protocol

This document is for the authors of **other HRT trackers** who want their users to be
able to move their history into *Kira HRT Tracker* (and, where they choose, back out).

It has two halves:

1. **What you can write** — the JSON our importer reads. Write this and your users can
   bring their data here in one step.
2. **What we write** — our own export format, and how to read it if you want to accept
   files *from* us.

Both directions are the same shape, deliberately. There is no separate "import format"
and "export format" to keep in step.

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
| `extras` | object | no | Route-specific numeric detail; see §4.3. |

### 4.2 `labResults[]` — a blood test

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | As above. |
| `timeH` | number | yes | Hours since epoch. |
| `concValue` | number | yes | The concentration, in `unit`. |
| `unit` | string | yes | `"pg/ml"`, `"pmol/l"`, `"ng/dl"` or `"nmol/l"`. |

The first two units are estradiol units; the last two are testosterone units. A record
carrying neither a hormone value nor any monitoring field is skipped.

Optional monitoring values may ride on the same record: `prolactin`, `prolactinUln`,
`alt`, `altUln`, `ast`, `potassium`. Send them only if you have them — a record with
monitoring values and no hormone reading should also set `"monitoringOnly": true`.

### 4.3 `extras` — route detail

A numeric bag. Send only the keys that apply to the route:

| key | route | meaning |
|---|---|---|
| `sublingualTier` | sublingual | 0–3 = quick / casual / standard / strict |
| `sublingualTheta` | sublingual | absorbed fraction 0–1 (overrides `sublingualTier`) |
| `releaseRateUGPerDay` | patchApply | patch release rate, µg/day |
| `patchWearH` | patchApply | planned wear, hours |
| `gelSite` | gel | 0–3 = arm / thigh / scrotal / abdomen |
| `gelProductId` | gel | 1–5 for the presets, ≥1000 for a user product (§8) |
| `gelCoverage` | gel | 0–6 = product / palm1 / palm2 / palm3 / thigh / arm / arms2 |
| `gelCoApplied` | gel | 0–2 = none / sunscreen / moisturizer |
| `gelWashAfterH` | gel | hours after application the site was washed |
| `concentrationMGmL` | gel | product concentration, mg/mL |
| `areaCM2` | gel | application area, cm² |

Unknown keys are ignored. Values are numbers — never strings.

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

`CPA`, `SPIRO` and `BICAL` are anti-androgens: they are carried in the `ester` field
because a record has to name its substance somehow, but they are **not** estrogens and
**not** modelled. Send them as-is; do not convert them to an estradiol equivalent.

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
estreva, estrogel, divigel, and a DIY entry) and ids ≥1000 are user-defined. This app does
not currently persist a user catalogue, so **a custom product's name and concentration do
not survive the trip** — the record keeps its dose, route, site and id, and the id
resolves to nothing until the same product exists here. Built-in presets transfer whole.

If you send a `gelProducts[]` array, we skip it and report how many entries were skipped,
rather than importing a catalogue we cannot represent.

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
