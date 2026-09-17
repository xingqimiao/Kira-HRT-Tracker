# Writing the Privacy Policy

Published at `https://kiramyao.com/privacy` (X's portal field), covering the HRT
service specifically.

This is a **structural and factual guide, not legal advice.** It tells you what you
must say because of how this system actually works, and which claims would be false.
Have the result reviewed by someone qualified in your jurisdiction before relying on it.

---

## 0. Deletion is implemented — the policy can promise it

A privacy policy must say how a user deletes their data, and this was the one gap:
the Core had no delete-account endpoint, so the promise could not be kept. It is now
built and tested, and the deletion section can be written truthfully.

**`POST /hrt/auth/account/delete`** — requires the password **and** a TOTP code (or a
single-use recovery code). A session alone is refused, because this is the most
destructive action the service offers and the one an attacker with a stolen session
would most want.

What it does, verified per table rather than assumed from the cascade:

- deletes the account row, cascading to dose records, lab results, settings, recovery
  codes, API tokens and OAuth links;
- deletes `auth_events` explicitly — that table's foreign key is `ON DELETE SET NULL`,
  so a cascade would have left rows behind still holding **IP addresses**, which is
  exactly what deletion is meant to remove;
- revokes every unlocked session for the account, which the cascade cannot do because
  sessions live in process memory;
- writes one `deletion_log` row carrying **no identifier** — a reason, the account's
  creation time, and when it was deleted. Counts and timings stay answerable; nobody
  can be identified from it.

`GET /hrt/auth/account` reports what would be removed (record counts, recovery codes
remaining, creation date), so a client can show the user what they are about to
delete.

Three details worth knowing, because they are deliberate rather than incidental:

- **The lockout applies here too.** Without it, someone locked out of `/auth/login`
  could keep guessing the password on the delete endpoint — the more damaging target.
  There is a test for exactly that.
- **A missing second factor does not count as a failed attempt.** The password is
  already proven at that point, so a client asking for the code on a second screen is
  mid-flow, not guessing. Counting it would let an honest user lock themselves out of
  deleting their own account.
- **A recovery code works.** Someone whose authenticator is lost must still be able to
  exercise their right to erasure; refusing would make the account undeletable exactly
  when they most want it gone.

**Still a soft delete for individual records**: deleting one dose marks the row
deleted and excludes it from the app, but the row stays until the account is deleted.
Say that plainly in the policy — users reasonably assume a delete is a delete, and
implying otherwise would be the kind of small inaccuracy that costs trust.

---

## 1. What you can and cannot see — get this right first

This is the section people get wrong, in one of two directions: they claim total
blindness (false), or they omit the encryption entirely (understates a real protection).

**Encrypted — you cannot read it:**
- dose records: route, ester, dose in mg, and the per-route extras
- lab results: the measured value and its unit
- body weight, HRT mode, calibration settings, PK parameter overrides

These are sealed with AES-GCM under a per-account key (a DEK). The DEK is itself
stored only as ciphertext wrapped under a key derived from the user's password
(PBKDF2, 600k iterations, SHA-256). The password is never stored — only a scrypt hash,
which derives nothing.

**In the clear — you can read it, and you must say so:**
- **username**
- **account creation and last-update times**
- **the timestamp of every dose and every lab result.** The schema keeps
  `occurred_at` unencrypted on purpose, so the server can order and paginate a
  timeline without decrypting every row. This is a real disclosure: a database dump
  reveals *when* someone logs medication and how often, without revealing what.
- **IP addresses** of sign-in and registration attempts, in `auth_events`
- **whether a second factor is enabled**, and when it was
- **a linked X handle and X user id**, if X sign-in was used
- counts, and the fact an account exists at all

Write the honest version: *"the values you record are encrypted and we hold no key for
them; we can see the times at which records were created and your username."*
Do not write *"we cannot access your data"* — the timestamps above make that false,
and it is the kind of claim that becomes a problem precisely when it matters.

---

## 2. The encryption's exact limit — and why the wording matters

The accurate statement is:

> Your records are stored encrypted. We hold no key to them at rest. When you sign in,
> the key is held in the server's memory for up to 30 minutes of inactivity so the
> service can read and update your records; when that expires, or when you sign out,
> the key is discarded and the records become unreadable to the server again.

Two things to avoid:

- **Do not say "end-to-end encrypted."** It is not: your browser talks to our server
  over TLS, and the server decrypts while unlocked. E2EE means only the endpoints hold
  keys, which is not this design.
- **Do not copy the wording from the upstream project's README.** It describes a
  browser-only model where the server never sees plaintext. That was true before this
  rewrite and is not true now, because the server answers API and agent requests.

If in doubt, the honest phrasing is "encrypted at rest, decrypted in server memory
while you have an active session."

---

## 3. The disclosure almost everyone forgets: connected AI agents

This must be in the policy. Not optional, and not buried.

If a user connects an AI assistant through MCP, or pastes their records into any chat
service, **their records leave this system and are processed by that provider under
that provider's terms.** Plaintext. You have no control over it.

Suggested wording:

> You can connect an AI assistant to your account using a protocol called MCP. If you
> do, the records you access through it are transmitted to that assistant's provider
> and are governed by that provider's privacy policy, not ours.
>
> The connection works only while you have an active session. Connecting an assistant
> does not give you remote access to your records, and it does not let the assistant
> open your account: the key is only held in memory after you unlock with your
> password. If your session has expired, the assistant is told the account is locked
> and you must unlock it here first.
>
> Agent tokens are long-lived by design, so treat one as a password. A leaked token
> cannot unlock your account on its own — it proves identity but carries no decryption
> key. It can, however, read your records during any period when you already have an
> active session, and each read extends that session, so an attacker holding your
> token while you are signed in can keep the window open. Revoke the token in
> Settings to end this immediately.
>
> Once records reach the assistant's provider, they are outside our control and we
> cannot delete them there.

That last paragraph is the part most policies get wrong. The token is **not** safe
merely because it needs an unlock: `findUserSession` refreshes the idle timer on every
token read, and the default token never expires. So "an unlocked session is required"
and "a leaked token is harmless" are not the same claim. If you only state the first,
the policy reads as a reassurance the code does not support. The code paths and the
tests that pin this are in `CODE-AUDIT.md`.

This matters legally (it is a disclosure of onward transfer) and practically (users
genuinely do not expect the button to do this). An agent-connected account is
materially different from one that is not, and the policy is where that becomes
visible.

---

## 4. What to say you collect, and why

Structure it as a table; it is easier to keep accurate.

| What | Why | Encrypted? |
|---|---|---|
| Username | to identify your account | no |
| Password | sign-in; stored only as a salted hash, never readable | n/a |
| Second-factor secret | to verify your authenticator codes | yes, sealed separately |
| Recovery codes | to regain access if the authenticator is lost | hashed with scrypt |
| Dose records | the core function | yes |
| Lab results | the core function; used to personalise level estimates | yes |
| Body weight | the model needs it to compute distribution volume | yes |
| IP address | abuse prevention and rate limiting | no |
| X user id and handle | only if you connect X, to identify you at sign-in | no |

Also state, because they are true and reassuring:

- **No analytics, no tracking scripts, no third-party advertising.** (Verified: the
  bundle makes no third-party requests. Keep it that way, or update this policy.)
- **No email address is required** to use the service.
- **No real name is required.**
- **Nothing is sold or shared for advertising.**
- **Share links** (if enabled) contain only the dosage history and modelled curve —
  never lab results, weight, or profile details — and expire.

---

## 5. Third parties you must name

- **X (Twitter)** — only if the user connects it. Say what you receive (numeric user
  id, handle, display name) and what you do not receive (password, ability to post or
  read their timeline). Say that X's own privacy policy governs their use of X.
- **Your hosting provider** — say that it stores the database, and that it holds only
  ciphertext for records. Name it if you can; vagueness here is a common complaint.
- **AI providers** — see section 3. Do not fold this into a general "third parties"
  sentence; it deserves its own paragraph.
- **No one else.** If that is true, say it explicitly. "We do not share your data with
  anyone else" is a strong statement when it is accurate.

---

## 6. Retention and deletion

Now writable as stated. Cover each of these:

- **Active accounts**: records are kept until you delete them.
- **Deleted records**: deletes are soft — the row is marked deleted and excluded from
  the app, and remains in the database until account deletion. Say this honestly
  rather than implying a delete is immediate and total.
- **Account deletion**: immediate and complete, via the app (or by email at your
  contact address). Records, lab results, settings, recovery codes, API tokens and
  OAuth links are all removed. One anonymised counter row survives, with no account
  identifier — state that, so the policy matches the software.
- **Backups**: state the retention window if you take database backups, since
  deletion cannot reach into an existing backup. Something like "deleted data may
  persist in encrypted backups for up to N days."
- **Audit records**: `auth_events` keeps sign-in and registration events with IP
  addresses, and they are deleted along with the account. State that.
- **Keep the two losses apart** — this is a trap, and an earlier version of this
  guide fell into it by writing "if a user loses their authenticator and recovery
  codes, neither you nor they can recover the account". That sentence is true but it
  teaches the wrong lesson, because it pairs the two as though either one mattered to
  the data:
  - **Losing the authenticator** locks you out of the *login*, not of the data. A
    recovery code covers it. If the codes are gone as well there is **no reset route
    at all** — `/auth/login` accepts a TOTP code or a recovery code and nothing else,
    so neither the user nor you can get past the second factor. What survives is the
    data: the account is still there and still decryptable, so finding a saved code
    later restores access. It costs access, not history.
  - **Losing the password** is the irreversible one. The data key is derived from it,
    you hold no copy, and there is no reset route — `changePassword` requires the
    current password precisely because re-wrapping the key needs it in hand. Recovery
    codes are no substitute: the server stores only a hash of each, so they carry no
    key material and cannot decrypt anything. The records are gone for good, whatever
    else the user still holds.

  Say both, and say which is which. A user who reads only the first version may keep
  their recovery codes and believe their history is safe from a forgotten password,
  which is backwards. Users need to know this *before* it happens, not after.

---

## 7. Rights

List the rights that apply where you operate: access, correction, deletion, export,
objection. Two of these you can genuinely support today:

- **Export** — the app has CSV, PDF and JSON export, and the server has
  `/api/sync` returning the full record set. Say how.
- **Correction** — users edit records directly in the app.

**Access** is served by the app's own export (CSV, PDF, JSON) and by
`GET /hrt/api/timeline`; **deletion** is served by `POST /hrt/auth/account/delete`.
State that both are self-service, and give the email address as a fallback for anyone
who cannot sign in.

---

## 8. Children

X requires that you do not knowingly collect data from children under 13, and
COPPA/GDPR set the same floor. State the minimum age (13, or higher where local law
requires) and give the contact address for removal requests.

There is a specific nuance worth one sentence: an underage user's records would still
be encrypted and unreadable to you, but you can delete the account, which cascades.

---

## 9. Security

State what you actually do, briefly:

- records encrypted at rest, key not held at rest
- passwords stored only as salted scrypt hashes
- second factor mandatory for all accounts
- TOTP secrets encrypted under a key kept outside the database
- rate limiting and per-account lockout on sign-in
- deletion of API tokens on password change

Do not claim certifications you do not hold (SOC 2, ISO 27001, HIPAA). Saying
"HIPAA compliant" would be both false and dangerous here — this is not a covered
entity's system, and the phrase invites a standard you are not meeting.

---

## 10. Do NOT put the medical disclaimer in the Privacy Policy

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

The app-side modal is worth checking against the ToS wording. The ToS is the binding
text; the modal is a summary. If they say different things, the ToS governs — but a
user-facing summary that overstates safety is the kind of mismatch a regulator reads
badly.

---

## 11. Practical checklist before publishing

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
2. Confirm every claim against the code. The encryption claims, the "no analytics"
   claim, and the share-link exclusions are all verifiable — see `ARCHITECTURE.md`.
4. Add the policy link in the app's footer, and in the sign-in and signup screens. X
   checks that the policy is *linked from* the app, not merely reachable.
5. Keep the medical disclaimer out of the policy, per section 10. The ToS carries it.
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
write §1–§9 in, each fact living in exactly one place.

> **What we can see.** Your dose records and lab results are stored encrypted. We hold
> no key to them at rest, so a stolen database does not expose them.
>
> **When we can read them.** When you sign in, the key is held in the server's memory
> for up to 30 minutes of inactivity so the service can read and update your records.
> During that window we can read your records. When it expires, or when you sign out,
> the key is discarded and we cannot read them again.
>
> **This is not end-to-end encryption.** Your browser talks to our server over TLS, and
> the server decrypts while you are unlocked. We are not claiming we never see your
> data — we are claiming we hold no key to it when you are away.
>
> **Your password is the one thing we cannot replace.** It derives the key. We keep only
> a hash, which cannot be turned back into the key. If you lose your password, your
> records are unrecoverable, by you or by us. Your recovery codes protect your *login*,
> not your data — they cannot decrypt anything. Keep both somewhere you will not lose
> them.
>
> **Agents and AI assistants.** You can connect an AI assistant by pasting an access
> token into it. That token works only while you have an active session, and it cannot
> unlock your account on its own. Treat it as a password: while you are signed in, a
> leaked token can read your records and keep that session alive. Revoke it in Settings
> to stop this. Once your records reach the assistant's provider, they are governed by
> that provider's policy and we cannot delete them from there.
>
> **Deleting your account** removes your records, lab results, settings, recovery codes,
> tokens and connected logins immediately and completely. One anonymised counter row
> survives with no identifier attached. Records you delete individually are marked
> deleted and hidden, but remain stored until you delete the account.

For an engineer's audit trail of these claims, see `CODE-AUDIT.md`. It is an internal
document and is not part of the policy.
