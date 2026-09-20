# 体感记录 — a private body-and-mood journal

**Status:** implemented on branch `rewrite`. This revision **replaces** the 2.1 plan, whose
public-community half is cancelled. It is the only plan for this feature.

Every statement below is labelled:

- **[fact]** — verified in the tree, with `path:line`.
- **[decision]** — a choice made for this implementation.
- **[judgement]** — an assistant's assessment, not verified by a source or a test.

---

## 0. What was cancelled, and what survived

**[fact — user instruction]** The community layer around the journal was cancelled entirely:
no public posts, no comments, no likes, no feed, no moderation, no pseudonyms, no avatars, no
Turnstile on posting, no new tables, and no privacy-policy change. Revision 2.1 designed those
things (its `journal_posts`, `journal_comments`, `journal_likes` and `journal_reports`
tables, the live-resolved author identity, the operator queue). **None of it is being built**,
and none of it is sketched here again.

**[judgement — why the split was real]** The cancelled design was not arbitrary. A record in
`records` is readable only by its owner, because every read is scoped to the caller
(`server/src/records.ts:172`, `:221`, `:240`). A public post has to be readable by strangers,
so it could not live there and the plan proposed a second, deliberately-plaintext store. That
reasoning is recorded only so nobody re-derives it; the feature it justified is gone.

**[decision]** What survives is the private journal alone — 体感记录: how the body and mood are
actually feeling (排尿耐受, 出油 / 脱发 / 体毛, 情绪耐受), one person's own records.

---

## 1. The data model — one new `category`, no DDL

**[fact]** The record store is `records`. The row carries plaintext addressing
(`user_id`, `taken_at`, `category`) and one sealed payload; everything the person typed is
inside `payload_encrypted` (`server/schema.sql:433-445`).

**[fact]** Every read is owner-scoped. `RecordService.list` fixes `user_id = $1`
(`server/src/records.ts:172`); `remove` (`:221`) and `get` (`:240`) do the same; the
upsert refuses to touch another account's row (`:148`,
`WHERE records.user_id = EXCLUDED.user_id`).

**[fact — the column has no CHECK]** `category` is declared
`varchar(32) NOT NULL DEFAULT 'dose'` with no constraint
(`server/schema.sql:441`). Adding a category is therefore **code-only**:
`RECORD_CATEGORIES` in `server/src/records.ts:38` is the allowlist, and
`isCategory` (`:69-71`) is the only gate.

**[fact — schema.sql runs whole-file, every boot]** `migrate()` reads the whole file and
executes it as one query (`server/src/db.ts:47-52`), and the http command calls it on boot
(`server/src/index.ts:61`), as does the `migrate` command (`:50-51`). It is safe to re-run
because every statement is `CREATE ... IF NOT EXISTS`. This is also why nothing here needed a
migration: there is no migration runner to add one to.

**[decision]** A check-in is one record:

```jsonc
// records.id          -> "journal:<mode>:<uuid>"
// records.category    -> "journal"
// records.taken_at    -> the check-in time
// records.payload_encrypted -> decrypted -> this:
{
  "id": "<uuid>",
  "timeH": 497197.0,             // hours since epoch, the dose/lab unit
  "updatedAt": 1789909314843,    // epoch ms, what sync's newest-wins compares
  "urinaryTolerance": 3,         // 0–5 self-rating, or absent = not answered
  "skinOil": null,               // 出油
  "hairLoss": null,              // 脱发
  "bodyHair": null,              // 体毛
  "moodTolerance": 2,            // 情绪耐受
  "symptoms": { "liver": [], "meningioma": ["tinnitus"], "hyperkalemia": [] },
  "note": "free text"
}
```

**[decision]** The five scales are separate fields, each a whole number from 0 to 5 or absent.
There is no total, no average, no trend and no derived value anywhere — see §3.

**[fact]** The two-part id is what makes a retried write idempotent: the upsert conflicts on the
id alone (`server/src/records.ts:140-151`). The client mapping is defined once in
`src/services/recordDocs.ts:24` and `:140-149`.

**[fact]** The shape and its validation live in one pure module, `src/utils/bodyJournal.ts`
(`JOURNAL_SCALE_FIELDS` at `:19-26`, the symptom groups at `:35-45`, the sanitiser at
`:113-150`). A rating outside 0–5 is **dropped, not coerced** (`sanitizeScale`, `:78-82`).

---

## 2. The two silent readers, and the merge path

A new head in the record id is invisible unless every reader is taught it. There are three
places, and two of them fail *silently*:

1. **[fact — silent reader #1: the client]** `recordsToPayload` reassembles the app's payload
   from records (`src/services/recordDocs.ts:173-250`). A head it does not know increments
   `unknown` and the record is dropped (`:212`), with only a `console.warn`
   (`src/services/coreSync.ts:162`). The journal head is handled at
   `src/services/recordDocs.ts:210`.
2. **[fact — silent reader #2: the server]** `buildExportPayload`
   (`server/src/records.ts:330`) walks the same ids for `/api/export` and the MCP
   `hrt_sync_state` tool. An unrecognised head is counted into `unknown` (`:415`) and never
   leaves the server. The journal head is handled at `:393`, and the export version is now
   `3` (`:438`) because the shape gained a collection. **This is the one that would have
   lost data quietly: the export would still be valid JSON, with one wrong number in it.**
3. **[fact — the merge]** `src/utils/syncMerge.ts` decides what two devices converge on.
   `journal` is a record kind (`:36-37`) with real tombstones (`:150`, `:192`, `:248`) and
   the ordinary union/newest-wins merge (`:562`, `:569`), and it participates in the state
   fingerprint (`:359`). Without the tombstone, a deleted check-in resurrects on the next
   sync; without the merge, a check-in from the other device never arrives. The carry-forward
   of remote tombstones before a push is in `src/services/coreSync.ts:227`.

**[fact — app-side]** `src/hooks/useAppData.ts` reads and writes the per-mode journal store
(`:221`, `:266`, `:338`), builds it into the export payload (`:982`, `:991`, `:996`),
merges it in (`:1064`, `:1074-1080`), and handles it in both import paths
(`:664-803` replace-import, `:839-963` merge-import). The client payload's own version marker
moved to `3` for the same reason as the server's.

**[fact — the i18n gate]** `scripts/check-i18n-coverage.mjs` imports `TRANSLATIONS`
(`:16`), takes `zh` as the reference key set (`:19`), and reports `missing` and `unused`
per language (`:25-32`, gap count at `:47`). A key present in one bundle and absent from
another does not throw — it falls back and renders in the wrong language — so every journal
string is in all seven: `const JOURNAL_I18N` in `src/i18n/translations.ts`, spread **last**
in each language's merge so it wins.

---

## 3. The check-in form — and what it must never do

**[decision]** The form lives in 记录 (`src/pages/History.tsx`, rendered from
`src/components/JournalCheckIn.tsx`) because that is the page the user named, and it is where
the rest of the personal log already is.

**[decision]** A check-in captures: a time (defaulting to now), the five 0–5 self-ratings
(each optional), an optional source-cited symptom checklist, and a free-text note. Nothing
else.

**The rule, stated plainly:**

- **[fact]** The five experience scales are **not clinical signals**.
  `docs/monitoring-reference.md` §5 (`:186-219`) lists what the sources do **not** support —
  no numeric thresholds for most of the panel, no target for the anti-androgen class — and §6.2
  (`:256-271`) is the definitive list of what the same logic *does* require. The named
  experience scales appear in neither. They are an experience log.
- **[decision]** Nothing derives a threshold, a trend-based warning, a total, a score, or a
  "your levels may be off" hint from them. The form shows what the user entered and stops.
  The register note (`journal.register`) says so on screen.
- **[decision]** The optional symptom items are the only source-backed part, and each group
  cites its source on screen. They are drawn from `docs/monitoring-reference.md` §6.2:
  - **Liver-related symptoms** — the FDA CASODEX label §5.1 signs that trigger an
    immediate ALT (`docs/monitoring-reference.md:268`): nausea, vomiting, abdominal pain,
    fatigue, anorexia, flu-like symptoms, dark urine, jaundice, right-upper-quadrant
    tenderness.
  - **Meningioma-related symptoms** — the SfE list that calls for an urgent MRI
    (`docs/monitoring-reference.md:269`): vision loss, hearing loss, anosmia, tinnitus,
    seizures, limb weakness.
  - **Hyperkalemia risk factors** — the spironolactone risk factors the sources name
    (`docs/monitoring-reference.md:105`, `:266-267`): age over 45, renal insufficiency,
    other potassium-sparing drugs, potassium supplements. These are **risk factors, not
    symptoms**, and the group is labelled as such.
- **[fact]** The stored item keys are an allowlist in `src/utils/bodyJournal.ts:35-45`; a
  value the source does not name is dropped by the sanitiser (`:93-104`).

**[judgement]** The form is an aid to remembering what was felt. It is not a screening
instrument, and it has had no clinician review.

---

## 4. Verification actually run

- `node scripts/check-i18n-coverage.mjs` — 7 languages, **0 gaps**, 710 keys each.
- `npx tsc --noEmit -p tsconfig.json` — no `src/` errors from this work.
- `node --experimental-transform-types scripts/check-spiro.mjs` — 24/24.
- `node scripts/check-template-quick-add.mjs` — 4/4.
- `node --experimental-transform-types --import ./server/resolve-hook.mjs
  scripts/check-body-journal.mjs` — 8/8, including a two-state `mergeSyncStates` union, a
  tombstone delete, newest-wins, and a payload → records → payload round-trip.
- `cd server; npm test` — 104/104.
- `npx vite build` with `VITE_API_ORIGIN=https://api.kiramyao.com/hrt` — built; the origin
  string is present in the bundle.
- **Driven in the browser**: a check-in was created in 记录 (排尿耐受 3, 情绪耐受 2,
  Tinnitus), persisted to storage, survived a reload and rendered; the JSON export was
  captured from the app's own download and contains
  `modes.transfem.journal[0].id === "ab228619-…"` with `meta.version === 3`.

---

## 5. Deliberate limits

- **[judgement]** The five scales and their labels are the user's own vocabulary. The 0–5
  range is a decision, not a source-backed instrument.
- **[judgement]** There is no trend view, no average and no comparison across days. Adding one
  would be the exact move §3 forbids, on a self-rating that no source validates.
- **[fact]** No new table, dependency, column or migration was added; `category` had no
  CHECK to change (`server/schema.sql:441`).
