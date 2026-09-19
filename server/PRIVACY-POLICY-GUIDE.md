# Writing the Privacy Policy

Published at `https://hrt.kiramyao.com/privacy` (served from `public/privacy/index.html`),
covering the HRT service specifically.

This is a **structural and factual guide, not legal advice.** It tells you what you
must say because of how this system actually works, and which claims would be false.
Have the result reviewed by someone qualified in your jurisdiction before relying on it.

**Everything here was checked against the code, and each section names the file that
proves it.** The companion document is `CODE-AUDIT.md`, which is the claim-to-code table;
this is the prose that sits beside it. If the two ever disagree, the code wins and both
need fixing.

Two warnings before you start, because both were live errors in an earlier version of
this document:

- **There is no second factor, and there are no passkeys.** TOTP and its recovery
  codes were removed entirely — the columns and the `totp_backup_codes` table are
  dropped in `schema.sql`, and no route accepts a code. Passkeys went the same way
  (WebAuthn PRF, `webauthn_credentials` / `webauthn_challenges`): a passkey here existed
  to derive the data key, and once the server holds that key a passkey derives nothing.
  Nothing in the policy may promise an authenticator, a verification code, a recovery
  code, or signing in with a passkey. See §0 and §10.
- **We hold the key.** The architecture was reversed on purpose: the server keeps
  `ENCRYPTION_KEY` and decrypts records on read (`server/src/payloadCrypto.ts`). The
  claim that survives is "a stolen database dump is unreadable without the key". The
  claim that does not is "the operator cannot see your data". §2 is about keeping those
  two apart, because an earlier draft of this guide instructed the opposite.
- **There are no privacy modes.** Every account's data key is wrapped under a
  password-derived key *and* under the deployment's `SERVER_DEK_KEY`, so there is no
  account for which "we hold no copy of your unlock key" is true. Any sentence
  conditioned on "if you use advanced privacy mode" is now a sentence about nobody.
  See §2 and §3.

---

## 0. Identity and sign-in — say this before anything else

The login identifier is **a self-chosen account name, not an email address.**
`server/schema.sql` comments this on `users.username` and drops the old `email` column
outright; `validateUsername` in `server/src/accounts.ts` enforces 3–30 characters of
letters, digits, underscore and hyphen. There is **no email verification, no
verification mail, and no email-based recovery** — by design, so that a mail provider
can never become the gate on someone's medication history (`docs/auth-design.md` §2).

Three ways in, all of them real:

- **account name + password** — `POST /auth/register`, `POST /auth/login`. The password
  is stored only as a salted `scrypt` hash (`hashPassword` / `verifyPassword` in
  `server/src/accounts.ts`).
- **X** — `POST /auth/x/exchange`, after the `/auth/x/start` → `/auth/x/callback` pair.
- **Google** — `POST /auth/google/exchange`, the same shape.

What you may say about third parties here: we receive the provider's immutable account
id, and for X also the handle, display name and avatar
(`server/src/accounts.ts`, `createAccountFromX` / `listOAuthLinks`). Google is asked for
`openid` only and nothing else is read — `GOOGLE_SCOPE = 'openid'` in
`server/src/oauth.ts`, with a test that feeds the parser extra claims and asserts they
are ignored. We never receive a provider password, and we cannot post or read anything
on the user's behalf.

### The anti-ban rule — this is a *product* claim, and it is honest

An account created through X or Google starts with no password, so we do not pretend it
is finished. It can be signed into, but **it cannot store or read records until it binds
an account name and password of its own** (`/auth/credentials/bind`). Until it does,
every records route answers **`403 account_incomplete`** — deliberately a 403 and not a
401, so the app routes to the binding screen instead of signing the user out
(`requireBoundCtx` in `server/src/http.ts`).

`GET /auth/login-methods` reports `recovery_risk: true` while an account has exactly one
way in and that way is a social provider (`AccountService.loginOverview`). Say plainly
what that means: *if your social account is banned or the provider revokes access, the
account name and password you set are the way back to your records.* Unlinking is
refused outright when it would leave no way in at all (`unlinkProvider`) — so promise
that too, because the server enforces it.

Write the durable version of this, not a reassurance about a specific provider:

> Your account name is the login identifier. There is no email address on file, so we
> cannot reset a password by email. If you sign up through X or Google, we ask you to
> set an account name and password before your records can be saved — that pair is what
> keeps the account reachable if the social login ever stops working.

---

## 1. What we can and cannot see — get this right first

This is the section people get wrong, in two directions: they claim total blindness
(false), or they omit the encryption entirely (understates a real protection). Both are
wrong here for the same root reason, so start from the root: **the server decrypts
records when it reads them.**

**Encrypted — in one whole-record payload:**
- dose records: route, ester, dose, and the per-route extras
- lab results: the measured value and its unit
- body weight, HRT mode, calibration settings, PK parameter overrides
- free-text notes

Doses, labs and notes live in **one table, `records`**, and everything a person typed is
serialised to JSON and sealed as a single **AES-256-GCM** blob in `payload_encrypted`
(`server/src/payloadCrypto.ts`; `RecordService` in `server/src/records.ts`). The wire
format is `iv:tag:ciphertext`, base64 parts, with a fresh random IV per row.

**In the clear — we can read it, and the policy must say so:**
- **the account name**
- **when every record was taken.** `records.taken_at` is plaintext on purpose, so the
  timeline can be ordered and paginated in SQL rather than by pulling a whole history
  into memory. This is a real disclosure and is stated as one in the module's own
  header: the server learns *when* someone records a dose and roughly how often, without
  learning what.
- **the kind of each record** — `records.category`, one of `dose`, `lab`, `note`,
  `setting`. It is coarse, and it is still a disclosure.
- **account creation and update times**
- **IP addresses** of sign-in and registration attempts, in `auth_events`
  (`recordAuthEvent` in `server/src/accounts.ts`)
- **the provider identity**, if X or Google sign-in was used: the provider's immutable
  id, and for X a handle, display name and avatar (`oauth_accounts`)
- **counts** — how many records an account holds, and the fact that an account exists

Write the honest version: *"the values you record are encrypted, and a stolen database
dump is not readable without the encryption key which is kept outside the database. We
can read your records when we serve them to you, and we can see when each record was
taken, what kind of record it is, and your account name."*

Do not write *"we cannot access your data"* — the timestamps and the server-side key
above both make that false, and it is the kind of claim that becomes a problem precisely
when it matters.

**One more thing that is easy to miss:** there is no claim to make about a share link
leaking lab results. Share snapshots are refused unless they carry only dose events and
the modelled curve — lab results, weight, profile fields and an email key are on a
blocklist enforced in `server/src/shares.ts` (`assertShareable`). If you mention share
links at all, promise exactly that and nothing more.

---

## 2. The encryption's exact limit — and why the wording matters

The accurate statement is:

> Your records are encrypted before they are written to disk, with AES-256-GCM, under a
> key that is kept outside the database. A stolen database dump is therefore not
> readable on its own. The server holds that key, and decrypts your records in order to
> send them back to you.

Two things to avoid, and they are the two that were wrong before:

- **Do not say "end-to-end encrypted", and do not say "we hold no key".** Neither is
  true. `server/src/payloadCrypto.ts` opens with exactly this instruction to whoever
  reads it next: the server can decrypt every record it stores, the honest claim is
  "a stolen database dump is useless without this key", and *"nobody should read
  `ENCRYPTION_KEY` and conclude the operator cannot see the data"*. `records.ts` says the
  same in its own header. If you write the opposite, you are contradicting both files.
- **Do not copy the wording from the upstream project's README.** It describes a
  browser-only model where the server never sees plaintext. That was true before this
  rewrite and is not true now.

If in doubt, the honest phrasing is **"server-side encryption: encrypted at rest, and
the server can decrypt to serve them back to you."**

### Where the unlocked-session story still belongs

There is a second, separate key mechanism, and it is real but it is **not** a claim that
the operator cannot see your data. Read `server/src/session.ts` before writing about it:

- An account has a per-account data key (a DEK). It is stored only as ciphertext wrapped
  under two wrappers (`encryption_metadata` in `schema.sql`): one derived from the
  password, and one derived from the deployment's `SERVER_DEK_KEY`. A session holds the
  unwrapped DEK **in process memory** for a sliding idle window — `SESSION_TTL_MINUTES`,
  renewed by use and capped absolutely by `MAX_SESSION_AGE_MS` (`openSession` / `renew` /
  `lookupSession` in `server/src/session.ts`).
- The **password** wrapper is what makes the key depend on something only the user knows.
  The **server** wrapper is what makes the account recoverable and what lets a durable
  agent token read without a live unlock (`resolveApiContext` /
  `serverDekFor` in `server/src/accounts.ts`).
- There is **one arrangement**, not two. `users.privacy_mode` and the `standard` /
  `advanced` split are gone, and so is the recovery key that existed to open an
  `advanced` account (`/auth/recovery-key`, `addRecoveryWrapper`). Every account is
  written with both wrappers from registration.

So there is **no** supportable sentence of the form *"we hold no copy of your unlock key,
so a database dump alone does not open your records"*. That sentence used to be
available for `advanced` accounts and applied to a minority. Do not write it for any
account now, and do not write a mode-conditional version of it either: there is no mode
to condition on, and `GET /auth/account` no longer reports `privacy_mode`,
`has_recovery_key` or `server_recovery_available`. The only encryption claim left is the
one in §2 — a dump is unreadable without `ENCRYPTION_KEY`, which we hold.

---

## 3. The one loss that is left

There is no second factor, no recovery code and no recovery key, so the "two losses"
paragraph in the old guide has to be rewritten from scratch rather than edited. The only
loss left is this one:

- **A forgotten password.** The DEK is wrapped under a key derived from the password
  (`unwrapWithPassword`) *and* under the deployment's key (`unwrapWithServer`). A
  forgotten password therefore does not lose the records: the deployment can still open
  them. What it cannot do is hand the user a reset link, because there is no email address
  on file and no recovery route in the product — see `DEPLOY.md` §6, "A lost password", for
  what the operator can actually do and what it costs.
- **Nothing else.** There is no key for a user to write down and lose, because there is no
  recovery key any more.

**Nothing may promise a recovery key or recovery codes.** Both existed at different
times for different reasons and both are gone. What the policy may say is the smaller,
true thing: *a forgotten password is recoverable by the operator, and there is no email
address on file that would let you reset it yourself.* Do not describe a code, a key, or
a recovery procedure the software does not have — a user would rely on it.

What used to make this section long was the `advanced` account, which held no server
wrapper and so was genuinely unrecoverable without the recovery key it was told to keep.
That account no longer exists — see §2 — so that whole class of promise is deleted
rather than softened.

---

## 4. The disclosure almost everyone forgets: connected AI agents

This must be in the policy. Not optional, and not buried.

If a user connects an AI assistant through MCP, or pastes their records into any chat
service, **their records leave this system and are processed by that provider under
that provider's terms.** Plaintext. We have no control over it.

The mechanism, from the code (`server/src/mcp.ts`, `server/src/accounts.ts`,
`server/src/session.ts`):

- Access is by a permanent `hrt_` token minted at `POST /api/tokens`. It is stored only
  as a hash, and the plaintext is shown once (`mintApiToken`). It has no default expiry.
- **A token is a full credential, and that is the fact the policy has to carry.** It
  resolves to a user id (`resolveApiToken`) and the key then comes from the deployment's
  own copy of the account key (`resolveApiContext` → `serverDekFor` →
  `unwrapWithServer`). **No live unlock is required, and the user does not have to be
  present.** An earlier version of this guide said the opposite — that a token "does not
  create access by itself" and needed a session — and that was true only while some
  accounts could hold no server wrapper. Every account holds one now.
- **Signing out does not stop it.** `POST /auth/logout` closes a live unlock
  (`AccountService.lock`); a durable token is not a session, so it keeps working. The two
  things that end it are revoking the token (`DELETE /api/tokens/{id}`) and changing the
  password (`changePassword` deletes every token for the account).
- The only state in which a token reads nothing is `{ denied: 'locked' }`: the account
  carries no server wrapper, or the deployment has no `SERVER_DEK_KEY`. That is a
  misconfiguration or a pre-existing account, not a protection to describe.

So write the conservative version, and write it without hedging: **a token is a
credential that can read and write your records on its own, so it is worth exactly as
much as your password.** There is no account for which the weaker sentence is needed.

Suggested wording:

> You can connect an AI assistant to your account with an access token. Anything that
> assistant reads is sent to that assistant's provider and is governed by that
> provider's privacy policy, not ours. The token can read and write your records on its
> own, without you signing in — treat it exactly as you would treat your password, and
> revoke it in Settings when you are done.
>
> Once records reach the assistant's provider, they are outside our control and we
> cannot delete them there.

That last paragraph is the part most policies get wrong, and it needs to name the
onward transfer explicitly. The first paragraph is the part this guide got wrong: any
sentence that reassures the reader their token is inert between sign-ins is false.

---

## 5. What to say we collect, and why

Structure it as a table; it is easier to keep accurate. This one matches the schema as
it is now.

| What | Why | Plaintext in the database? |
|---|---|---|
| Account name | the login identifier | yes |
| Password | sign-in; stored only as a salted scrypt hash, never readable | n/a — hash only |
| X or Google account id | only if the user connects that provider, to identify them at sign-in | yes |
| X handle, display name, avatar | shown in the app as "who is signed in" | yes |
| Dose records | the core function | no — one encrypted payload |
| Lab results | the core function; used to personalise level estimates | no — same payload |
| Notes | the user's own annotations | no — same payload |
| Body weight, HRT mode, calibration | the model needs them to compute and calibrate | no — same payload |
| Record timestamps | ordering and paging | **yes** — say this |
| Record category (dose/lab/note/setting) | filtering the lists | **yes** — say this |
| IP address | abuse prevention and rate limiting | yes |

That last column is deliberately not headed "readable by us", because the answer to *that*
question is "yes, by decrypting" — see §2. The column says what survives a stolen database
dump, and the policy should not blur the two. Do not carry over the old rows for a
second-factor secret, recovery codes or a recovery key: those records do not exist any
more, and a table that lists them is a false statement of fact even before any prose
claim is written.

Also state, because they are true:

- **No email address is collected or required** — there is no email column and no
  verification mail (`schema.sql`, and `docs/auth-design.md` §2).
- **No real name is required.**
- **Nothing is sold or shared for advertising.** The live policy also claims no
  third-party analytics or tracking scripts in the app; that is a claim about the
  front-end bundle, which this pass did not re-verify — check it before you republish
  the sentence.
- **Share links** contain only the dosage history and the modelled curve, and expire
  (`assertShareable` in `server/src/shares.ts`; `shares.expires_at` is `NOT NULL` in
  `schema.sql`).

---

## 6. Third parties you must name

- **X and Google** — only when the user connects them. Say what we receive (the
  provider's immutable id; from X also handle, display name, avatar) and what we do not
  receive (a password, or the ability to post or read anything). Say that the provider's
  own privacy policy governs its side. Google gets one more sentence, because it is in
  the live policy already and Google's reviewer reads it: only the `openid` scope is
  requested, identity comes from the `sub` claim, and nothing else Google holds is
  requested, received, or used (`server/src/oauth.ts`).
- **Cloudflare** — DNS, CDN and abuse protection, and Turnstile on the registration
  form. The registration route calls Turnstile **before** creating anything
  (`/auth/register` in `server/src/http.ts`; `server/src/turnstile.ts` posts to
  Cloudflare's `siteverify`). Turnstile is a third party that sees the user's IP and
  browser during signup — name it rather than leaving it under "infrastructure", because
  the live policy does name it and that is the honest level of detail. Note the scope
  precisely: `verifyTurnstile` is called **only** by `/auth/register`, so an account
  created through X or Google is not Turnstile-gated, and the policy should not imply
  that it is.
- **The hosting provider** — it stores the database, and it holds the records only as
  ciphertext. The live policy names Oracle Cloud (Singapore region); this pass could not
  verify the deployment from the repository, so treat the named provider as a fact to
  confirm with whoever runs it, not as something the code proves.
- **AI providers** — see §4. Do not fold this into a general "third parties" sentence;
  it deserves its own paragraph.
- **No one else.** If that is true, say it explicitly. "We do not share your data with
  anyone else" is a strong statement when it is accurate.

---

## 7. Retention and deletion

Deletion is implemented, and it is real deletion rather than a flag
(`AccountService.deleteAccount` in `server/src/accounts.ts`). Cover each of these:

- **Active accounts**: records are kept until the user deletes them.
- **Deleting one record is also real.** `RecordService.remove` issues a `DELETE`, and its
  comment says so in as many words: "Deletion is physical: there is no tombstone here."
  An earlier version of this guide told the author to say the opposite — that deleting a
  dose only hid the row until the account was deleted. That was true of the old store and
  is false now. Say that removing a record removes it.
- **Account deletion is immediate and complete.** `DELETE /hrt/auth/account/delete`
  requires the session **and the password**. It is password-only: there is no second
  factor, so no code to supply, and any prose implying otherwise is describing software
  that no longer exists. The delete route is rate-limited like sign-in, and the same
  per-account lockout applies inside `deleteAccount` — worth one sentence, because it
  explains why repeated wrong passwords here can lock an account temporarily.
- **What removal covers**: the `users` row, and by `ON DELETE CASCADE` the records, lab
  data, settings, agent tokens, OAuth links and shares (every referencing table
  in `schema.sql` declares the cascade). `auth_events` is deleted **explicitly**, because
  its foreign key is `ON DELETE SET NULL` and a cascade would have left rows behind still
  holding IP addresses. Live unlocked sessions are closed, since they live in process
  memory where the cascade cannot reach. One `deletion_log` row survives, carrying **no
  identifier** — a reason, the account's creation time, and when it was deleted. State
  that, so the policy matches the software.
- **Audit records**: `auth_events` holds sign-in and registration events with IP
  addresses, and they are removed with the account. State that, and do not imply a
  general log-retention window you have not verified.
- **Backups**: state the retention window if backups are taken, since deletion cannot
  reach into an existing backup. The live policy promises only "while your account
  exists" and then that deletion removes things from the database — it does not mention
  backups at all. That is an omission rather than a falsehood, but it is the kind of
  omission to close with one sentence: "deleted data may persist in encrypted backups for
  up to N days."
- **Point at the file that proves it.** `server/CODE-AUDIT.md` maps these claims to
  `server/src/accounts.ts` (`deleteAccount`), `server/schema.sql` (`deletion_log`,
  `auth_events`) and the deletion test that asserts each table empty.

---

## 8. Rights

List the rights that apply where you operate: access, correction, deletion, export,
objection. Two of these are self-service today, and both are client-side:

- **Export** — the app exports the account's records as JSON, CSV and PDF
  (`src/components/ExportSection.tsx`, `src/services/export.ts`: `exportToCSV`,
  `exportToPDF`, plus a JSON export that can be written out encrypted). State how, in
  user terms, and do not name internal routes.
- **Correction** — users edit their records directly in the app.

**Access** is served by that same export; **deletion** is served by
`POST /hrt/auth/account/delete` from Settings. State that both are self-service, and
give the contact address as a fallback for anyone who cannot sign in.

If you want to cite a server route for the export payload, use the current one:
`GET /hrt/api/records` returns the account's sealed records for the client to reassemble
(`server/src/http.ts`; `RecordService.list`). `/api/sync` still exists but is the *legacy
migration* path for pre-record-store data, reconstructed by `buildExportPayload` in
`server/src/records.ts` — it is not the export contract, and the old guide's habit of
offering it as "the full record set" is what sent an earlier draft to the wrong endpoint.

---

## 9. Children

X requires that you do not knowingly collect data from children under 13, and
COPPA/GDPR set the same floor. State the minimum age (13, or higher where local law
requires) and give the contact address for removal requests.

There is a specific nuance worth one sentence, and it is now more accurate rather than
less: an underage user's record *contents* are ciphertext, but the account itself is
deletable in full, cascading to everything that names it. Do not claim the records are
unreadable to us — see §2.

---

## 10. Security

State what you actually do, briefly:

- records encrypted at rest under `ENCRYPTION_KEY`, which is held outside the database,
  and decrypted server-side on read
- passwords stored only as salted scrypt hashes (`hashPassword`, `server/src/accounts.ts`)
- rate limiting and per-account lockout on sign-in, and on the delete endpoint
  (`noteFailedUnlock`; `MAX_FAILED_UNLOCKS` / `LOCKOUT_MS`)
- agent tokens stored as hashes, shown once, and deleted when the password changes
  (`changePassword` deletes every token for the account). Two things to state honestly
  alongside it: a token reads records without a live unlock, and signing out does not
  stop it — see §4
- sessions revoked on sign-out-everywhere, and the device list names devices without
  returning any token or key (`listUserSessions` in `server/src/session.ts`)

Do **not** write "mandatory second factor", "TOTP secrets encrypted...", or any sentence
offering passkeys as a sign-in method: that list was the old one and it is gone from the
software. There is no list of "security features" that may include either.

Do not claim certifications you do not hold (SOC 2, ISO 27001, HIPAA). Saying
"HIPAA compliant" would be both false and dangerous here — this is not a covered
entity's system, and the phrase invites a standard you are not meeting.

---

## 11. Do NOT put the medical disclaimer in the Privacy Policy

An earlier draft of this guide said the disclaimer "belongs in both documents". That was
wrong, and so was the reasoning: it argued from where users *look* ("a privacy policy is
where people look before trusting health software") to where a contractual term should
*live*. That is a category error. A disclaimer is a limitation of liability — a term of
the agreement — and the **Terms of Service** is the document that carries terms. The
Privacy Policy describes data handling.

There is also a concrete cost to mixing them. A privacy policy answers one question:
*what do you do with my data?* Add unrelated contractual terms and it stops answering
that clearly, which is the only thing it is for. Someone reading it to understand data
handling should not have to skip past liability language.

So the disclaimer lives in exactly one written document, and appears in one other place
for a different reason:

| Where | What | Why there |
|---|---|---|
| **Terms of Service** | the full disclaimer, as its own numbered section (section 3) | it is a term of the agreement, and the liability section refers back to it |
| **In the app** | `DisclaimerModal`, already present and translated | it reaches the user at the moment they read an estimate, which no policy page does |
| **Share pages** | `src/i18n/share.ts`, a line under the shared chart | a shared chart is read by someone who never agreed to anything |
| **Privacy Policy** | **nothing** — at most one line pointing at the terms | it describes data handling, not risk |

If you want a single sentence in the privacy policy for orientation, this is the safe
form — a pointer, not a disclaimer:

> This policy covers how your data is handled. See the Terms of Service for the medical
> disclaimer and the limits of the service.

Note what that is not doing: it does not restate the disclaimer, so the two documents
cannot drift apart, and it does not ask the reader to treat a privacy policy as a source
of medical warnings.

---

## 12. Practical checklist before publishing

1. Fill in: **who operates the service**, a contact address, jurisdiction, effective
   date, retention periods for backups and audit logs, minimum age.

   **An individual operator needs no company, and no legal entity.** This guide used to
   say "legal entity", and the ToS skeleton's placeholder was `[[OPERATOR_LEGAL_NAME]]`,
   which together read as though a registered entity were required to publish terms.
   It is not: the field exists so a reader knows who they are dealing with, and for one
   person running a project that is a name or a handle. Where the operator is
   deliberately pseudonymous — as here, for a service handling trans health data —
   signing as a project name is the more accurate choice, not a lesser one, because it
   avoids publishing a real name that the operator has good reason to keep private.
   What the terms must not do is *leave it blank*: an agreement that does not say who
   is bound by it is not doing its job.
2. **Confirm every claim against the code**, and refuse to publish a row you cannot
   confirm. `server/CODE-AUDIT.md` is the claim-to-code table, and every row in it names
   a file and symbol that exists — the rows for the mode-conditional agent token were
   reworded to what the code now does rather than deleted, because the behaviour they
   describe is real and is the opposite of what they used to say.
3. Check the one claim this guide could not re-verify: **no third-party analytics or
   tracking scripts** in the app bundle.
4. Add the policy link in the app's footer, and in the sign-in and signup screens. X
   checks that the policy is *linked from* the app, not merely reachable. The sign-up
   form already links `/privacy` (`src/components/CoreAuthForm.tsx`). This pass found no
   footer privacy link anywhere under `src/`, so verify it before ticking this box, and
   note that there is no `/terms` page in the repository at all — the disclaimer's home
   is still described as the ToS, so decide where that document actually lives.
5. Keep the medical disclaimer out of the policy, per §11. The ToS carries it.
6. Include the date of last material change, and keep the changelog.
7. Get it reviewed by a lawyer qualified where you are. This guide covers what the
   system does; it cannot cover what your jurisdiction requires.

---

## How to say these things to a reader, in their own words

This is the *language* to use in the published policy — the voice, the plain wording,
the absence of file paths and function names. A reader cannot check a path, and a claim
they cannot check is one they have to take on trust, which is the opposite of what a
privacy policy is for.

**It is not a section to paste in.** This was tried, as a closing "in one sentence"
recap after the per-topic sections, and it was wrong: a second voice restating the
whole document is not what a privacy policy is, and two places saying the same thing
is how they drift apart — the recap does not get updated when a detail changes, and
then it contradicts the section above it. The paragraphs below are the register to
write §0–§10 in, each fact living in exactly one place.

> **Getting in.** Your account name and password are how you sign in. We do not ask for
> an email address and there is no email-based password reset. You can also sign in with
> X or Google; if you do, we ask you to set an account name and password before we store
> any records, so that losing access to that provider never costs you your history.
>
> **What we can see.** Your dose records, lab results, notes and settings are encrypted
> before they are written to disk, with AES-256-GCM, under a key kept outside the
> database. A stolen database dump is not readable on its own. We can see when each
> record was taken, what kind of record it is, and your account name.
>
> **This is not end-to-end encryption.** The server holds the key and decrypts your
> records in order to send them back to you. We are not claiming we never see your data,
> and you should not read any part of this policy as saying that.
>
> **If you forget your password.** There is no email address on file, so we cannot email
> you a reset link. Contact us: because we hold a copy of the key that protects your
> records, we can help you set a new password rather than losing the history. There is no
> recovery code or recovery key to keep — nothing you need to write down in advance.
>
> **Agents and AI assistants.** You can connect an AI assistant with an access token.
> Anything it reads is sent to that assistant's provider and is governed by that
> provider's privacy policy, not ours. The token can read and write your records without
> you signing in, so treat it exactly as you treat your password, and revoke it in
> Settings when you are finished. Once records reach the assistant's provider, we cannot
> delete them from there.
>
> **Deleting things.** Deleting a record removes it. Deleting your account removes your
> account, your records, your settings, your access tokens and your connected logins
> from our database. One anonymous counter row survives with no identifier attached, so
> we can still answer "how many accounts were deleted" without knowing whose.

For an engineer's audit trail of these claims, see `CODE-AUDIT.md`. It is an internal
document and is not part of the policy.
