# Architecture

A multi-user, agent-native HRT record service. The web app and the MCP server are
two interfaces over one Application Core; the pharmacokinetic model is the
upstream `logic.ts` at the repo root, used unmodified.

```
        Agent (ChatGPT / Claude)              Web / Mobile
                 │                                  │
                 │  MCP over Streamable HTTP        │  REST
                 └──────────────┬───────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │  Application Core     │   server/src/
                    │  AccountService       │   accounts.ts
                    │  MedicationService    │   core.ts
                    │  LabService           │   core.ts
                    │  TimelineService      │   core.ts
                    │  PKSimulationService  │   core.ts
                    └────┬─────────────┬────┘
                         ▼             ▼
                 ┌──────────────┐  ┌──────────────────┐
                 │  PostgreSQL  │  │    PK engine     │
                 │  (ciphertext)│  │  upstream        │
                 └──────────────┘  │  logic.ts        │
                                   └──────────────────┘
```

## The rule this design exists to enforce

**MCP is not the backend.** It is one adapter over the Application Core, and so is
the REST API. Both resolve a credential into an `AuthContext` and call the same
service functions, so there is exactly one implementation of what logging a dose
means. The failure this avoids is the obvious one: a web path and an agent path
that validate differently, compute differently, and drift apart until a bug exists
on one side only.

Concretely, `server/src/http.ts` and `server/src/mcp.ts` contain no business rules.
If either needs to know how a record is validated or how a curve is computed, that
logic belongs in `core.ts`.

## Decisions, and what they cost

### Records are encrypted at rest, and the server holds a copy of the key

The product's headline claim is that the operator cannot read your hormone record.
Answering `hrt.list_medications` from the server while keeping that claim true
needs a specific shape:

- The **KEK** comes from the account password and user id — the same derivation
  the web app already uses for its cloud backups. The server sees the password
  only during an unlock request and stores only a scrypt hash, which derives
  nothing.
- The **DEK** is random per account and is what actually encrypts records. It is
  stored server-side only as a ciphertext, wrapped once per credential that can
  open it: under the password's KEK, and under the deployment's own key
  (`SERVER_DEK_KEY`).
- An **unlocked** session holds the DEK in memory for `SESSION_TTL_MINUTES` of
  idle time. That window is when a request carries the key directly. It is not the
  only way in, because the server wrapper opens the same DEK.

**There used to be two privacy modes, and there is one arrangement now.**
`users.privacy_mode` chose between a `standard` account (password wrapper *and*
server wrapper) and an `advanced` one (password wrapper only, no server wrapper).
The choice was the last piece of the zero-knowledge design this service abandoned:
it only meant anything while `advanced` could be enforced, and it could not be,
because the same deployment already held `ENCRYPTION_KEY` and decrypted every
record on read. An account whose wrapper set promises the operator cannot open it,
on a server that opens it anyway, is a claim in the database that nothing checks.
So the column and its check are dropped, every account is written with the server
wrapper from its first request, and a password unlock adds the wrapper to an
account that predates the change.

Both wrappers live in `users.encryption_metadata` (versioned jsonb, `version: 2`),
with `users.wrapped_dek` mirroring `wrappers.password` byte for byte so a reader that
predates this release still works. **A password change rewraps the DEK and never
touches a record** — one row changes, so it cannot half-fail. `test/keyMaterial.test.ts`
pins the arrangement: both wrappers are present on a new account, both open the same
DEK, and `wrapped_dek` stays identical to the password wrapper.

The honest description was never **"the server never sees the data"**, and one
arrangement makes that easier to state rather than harder: there is no longer a
mode in which it is even arguably true. What the arrangement does deliver is the
bound `payloadCrypto.ts` states — **a stolen database dump is unreadable without
`ENCRYPTION_KEY`**, a key kept outside the database. Nobody should read the
encryption and conclude the operator cannot see the data.

Two consequences follow, both accepted deliberately:

1. **The README's E2E claim needs revising.** Once an LLM is in the data path, the
   model provider holds plaintext in its context. End-to-end encryption in the
   strict sense is not preservable through an agent, and claiming otherwise would
   be false.
2. **No SQL-level reporting over health data.** The server cannot aggregate doses
   or labs from ciphertext. `user_id` and `occurred_at` are the only cleartext
   columns; everything clinical is inside the envelope.

One consequence is worth naming separately because it is a capability, not a
disclosure: **a durable `hrt_` agent token is now a full credential.** It resolves
to a user, the server wrapper supplies the key, and the request needs no live
unlock and no user presence. `/auth/logout` does not stop it, because a durable
token is not a session; revoking the token or changing the password does. That was
the old standard-mode behaviour and it is now the only behaviour, so the honest
instruction to a user is "treat an agent token as a password".

**Passkeys were removed, and why they could not simply stay.** The feature was built to
protect the data key: a credential's **PRF extension output** derived the KEK that
wrapped the DEK, registration refused any credential that did not return a PRF output,
and the UI hid the whole thing on a browser that could not do PRF. That is the
zero-knowledge design this service abandoned. Once the server holds `ENCRYPTION_KEY`
and decrypts on read, a passkey that no longer derives anything is a button whose
description is a lie — so it is gone, along with `webauthn_credentials` and
`webauthn_challenges`.

**Step-up for agents went with it.** An account that had a passkey used to refuse a
durable `hrt_` token unless a passkey-proven unlock was live
(`session.passkeyVerifiedAt`), because an agent should not act on the strength of a
stored token. With passkeys gone there is no assertion that can prove presence, so
the denial had become unreachable and was removed rather than left as a state no
caller can receive. The step-up would have been aimed at the wrong target anyway:
the token path no longer consults a live unlock at all, so presence is not part of
what it checks. What remains is `'locked'`, and it means one specific thing — the
account carries no server wrapper, or the deployment has no `SERVER_DEK_KEY`, so
there is no key to hand over. A password unlock adds the wrapper.

### Record ids are opaque client strings, scoped per account

Ids are `text`, and the primary key is `(user_id, id)`. Two constraints, both
learned from testing rather than assumed:

- Declaring ids `uuid` rejected real imports. The app generates uuid v4 but its own
  reader accepts any string id, and hand-written exports carry ids like
  `dose-2024-01-01`.
- A *global* id primary key made importing the same export into a second account
  fail on a duplicate key. Importing one export twice is legitimate.

Record identity belongs to its owner; nothing about it is global.

### Validation rejects rather than clamps

The upstream `sanitizePKParams` clamps out-of-range values, which is right for a
settings screen a user is typing into and wrong for an API. Measured:
`{e2_kClear: -99}` clamps to the range floor `0.001` — near-frozen clearance,
unbounded accumulation, and a curve that reads as a catastrophic overdose. Someone
who made a unit error must be told, not handed a plausible wrong number.

Unknown parameter keys are errors too. A caller who typos `e2_kClearInj` as
`e2_kclear_inj` should hear about it rather than silently getting the default model
while believing their override applied.

### The PK engine is isolated structurally, not by a mutex

`logic.ts` keeps its active parameter set in module state (18 read sites). Every
server call goes through `engine.ts`, whose whole job is to make the unsafe pattern
unreachable:

- `simulateWithParams` sets, runs and restores parameters **without yielding**, so
  even 20 unqueued concurrent callers get correct, independent curves. Verified.
- The raw stateful functions (`runSimulation`, `applyPKOverrides`) are
  deliberately **not re-exported**, and `export *` is avoided precisely so they
  stay that way. The broken pattern — set parameters, `await`, then run — cannot be
  written.

That second point is load-bearing, and it is not theoretical. Measured, the broken
pattern corrupts silently: two interleaved requests both returned 291.5 pg/mL
where one account's correct answer was 35.5 — an 8.2x error with no warning
anywhere. A test asserts the raw functions stay unexported, so this cannot regress
quietly.

An earlier draft wrapped every call in a process-wide mutex. Testing showed it
defended nothing: it wrapped the *run*, while the corruption happens in the
*set-then-run* pair it cannot see. It was deleted rather than kept as reassurance.

### The upstream engine is vendored, not rewritten

`logic.ts` is 2,032 lines and every line works: 3-compartment kinetics, two-part
depot models, sublingual absorption tiers, and three calibration estimators (EKF,
OU-Kalman, hybrid MIPD). Its comments carry load — the gel bioavailability block
is a small literature review with NDA numbers, and the testosterone parameters are
calibrated against stated steady-state targets. Rewriting it would be a second
Swift→TS port of a clinical model, where only bit-identical output is acceptable.

The server imports it directly. `resolve-hook.mjs` exists only because the repo's
TypeScript uses Vite-style extensionless imports, which Node's ESM resolver
rejects; it retries with `.ts` so no upstream file needs patching and a `git pull`
stays clean.

One module-level alias is required: `logic.ts` reaches for `window.crypto`, and
the cloud-crypto helpers are the only browser dependency. Node has WebCrypto as
`globalThis.crypto`, so `globalThis.window ??= globalThis` is the entire fix.

### Deps are kept minimal

`node:crypto` for password hashing (scrypt) and token hashing, rather than bcrypt —
one less dependency, and scrypt is memory-hard. Hand-written validation rather than
a schema library, because the ranges and enum members already come from the
upstream file and a dependency would only make the checks harder to audit.
Postgres via `pg`. `rrule`-style libraries are not needed; the model takes explicit
event lists.

## Known ceilings

Marked in code as `ponytail:` where they appear. The ones that matter operationally:

- **Unlock sessions are in-memory and per-process.** A restart revokes every
  unlock (the conservative direction). Multi-instance deployments need a shared
  session store or sticky routing.
- **Rate limiting is in-memory and per-process.** Fine for one instance against
  credential stuffing; it does not coordinate across instances.
- **Import decrypts and writes record by record.** A five-year history imports in
  a few seconds. A bulk path would be the fix if this ever needs to be fast.
- **`stats.trough` is the minimum over the requested window, which includes any
  pre-dose idle stretch.** For a window reaching back before the first logged dose
  it reads ~0 rather than the cycle trough, which is arithmetically correct and
  misleading to read. An agent asked "what is my trough" should be given the
  minimum *between doses*, not of the whole window. Not yet implemented — noted
  because it is the kind of number an LLM will repeat verbatim.

## Testing

`npm test`. 85 tests, no external services (verified stable over 5 consecutive runs):

- **Isolation** — concurrent callers, and that the unsafe functions stay unreachable.
- **Key handling** — the privacy boundary: wrapping, wrong password, scoping,
  password rotation, session revocation.
- **End-to-end** — a real Postgres (embedded, no Docker) driving register → log →
  predict → timeline, plus a direct query asserting the dose values are *not*
  readable in the stored rows.
- **Protocol** — a real MCP client against the real transport, including that a
  locked account gets a readable message rather than a protocol failure.
- **Import** — plaintext, compressed and encrypted exports, idempotency, and that
  invalid records are reported without aborting the rest.

Bootstrapping is shared (`test/pg.ts`) and retries the Postgres start. Three test
files booting a cluster in parallel contend during `initdb`, which failed once
under load; a flaky test is not a test, so the boot retries rather than the suite
serialising (parallel 7s vs serial 17s).

## Migrating the web app — data path done, auth path blocked on a decision

The data half is built and tested end to end; the auth half is not started, because
it is not an implementation detail but a product decision.

### What is done

- **`src/services/coreSync.ts`** — the client. Speaks `/api/sync`, reports a locked
  account distinctly from a failure (the UI needs "unlock", not "retry").
- **`src/hooks/useCoreSync.ts`** — a sibling of `useCloudSync` with the same
  contract (`buildPayload` / `applyRemote` / `status` / `syncNow`), so the two are
  interchangeable for the app.
- **`POST /api/sync`** — push-and-receive-state in one call, plus `hrt_sync_state`
  over MCP from the same service.
- **Records travel as the app's own format**, with tombstones. The app's own
  `mergeSyncStates` does the merging on the client; the Core supplies records and
  deletions. There is deliberately no second merge implementation server-side —
  two implementations that must agree forever is the failure this avoids.
- **`useCoreSync` is simpler than `useCloudSync`.** The byte-for-byte reason is
  worth recording: the blob store has no compare-and-swap, so `useCloudSync`
  carries a revision-id dance (remember the newest backup reconciled with, probe up
  to three) to avoid overwriting another device's write and undoing its deletions.
  The Core enforces per-record optimistic locking server-side, so that machinery
  has no counterpart here.

Verified by `test/coreSync.test.ts` against a real Postgres and the real HTTP
surface: push/read round trip, the app's merge engine converging with Core state,
a deletion surviving a round trip without resurrection, and a locked account
reported as locked.

### What is blocked, and why

The app authenticates against **its own Worker** (`src/services/auth.ts`, 338
lines) and the Core has its own model. They do not overlap:

| Feature | App (Worker/D1) | Core |
|---|---|---|
| Password login | yes | yes (scrypt) |
| TOTP 2FA + backup codes | removed | removed |
| Passkeys / WebAuthn | removed | removed |
| Session list & revoke | yes | no (unlock TTL only) |
| Admin | yes | no |
| Unlock token | n/a | yes (`ks_…`) |
| Agent API token | n/a | yes (`hrt_…`) |

This section used to describe two systems that both existed — a Worker authenticating
the app and a Core holding the data — and set out three ways to reconcile them. There is
only one system now: the Worker, its D1 schema, its Docker image and its whole frontend
auth stack have been deleted, and the Core issues every credential. Two consequences are
worth keeping written down, because both were decisions rather than accidents:

- **The Core holds no second factor.** A mandatory one made every provider-created
  account unusable until enrolment, and TOTP was removed rather than made optional. The
  fallback that keeps records reachable when a provider account is lost is the bound
  account name and password, enforced by the `403 account_incomplete` gate.
- **Nothing asserts identity on the Core's behalf.** The Core does not accept identity
  from another service, which is what keeps the DEK wrapping — and the honest bound on
  it — in one place.

### A trap worth knowing before running tsc on both trees

`tsc -p tsconfig.json` at the repo root reports **dozens of errors in the server that
are all false**. The cause is not the code: the root config has no `strict`, so
`strictNullChecks` is off and a union discriminated by a boolean cannot narrow at all,
which turns every early `return fail(...)` in `domain.ts` and `core.ts` into an apparent
type mismatch (`TS2322`/`TS2339` on `Result<T>`, hundreds of lines apart from the
mistake they claim). Under `server/tsconfig.json` — which sets `strict: true` and
`lib: [ES2023, DOM]` — the server's `src/` is clean, and the same code passing under a
looser config is not evidence of a real defect. Do not quote a number here: it changes
with every commit, and the tell is the shape of the error, not the count.

`server/tsconfig.json` includes `DOM` on purpose: the cross-boundary tests import
the app's browser-side modules. The server's own sources use no DOM at runtime —
the single browser global upstream needs (`window.crypto` inside `logic.ts`) is
aliased to `globalThis` in `src/engine.ts`.

### The 5 remaining strict errors in upstream `logic.ts`

Both `logic.ts` and `syncMerge.ts` are untouched upstream files, and `logic.ts`
emits 5 `TS7053` errors under `strict` at its injection branch: `TwoPartDepotPK`
/ `EsterPK` tables lack `CPA` and testosterone keys, so indexing them with the
full `Ester` enum warns. Every read there has a `?? fallback`, so the errors are
type looseness rather than defects — verified by running CPA, E2 and EV injections
through the engine, all finite (CPA 12.5 mg → 0.215 ng/mL CPA, 0 E2, as expected;
a CPA injection must not produce estradiol). The files stay unmodified so upstream
pulls remain clean; fixing them would be an upstream change, not ours.

## Authentication: username + password, X and Google as equals

**There is no second factor.** TOTP, its enrolment leg, its replay-safety bookkeeping
and the recovery-code set were removed. Identity is proven one of three ways — the
account name and password, X, or Google — and all three end at the same place: a
session carrying the record key.

The history is worth one line, because the shape of the code still shows it: the
design used to make TOTP mandatory, so an OAuth signup produced an account that could
not be used or even store anything until a code had been confirmed. That made a
provider-created account a trap — and once the provider account was the only way in
and it was banned, the records went with it. The gate below replaces it.

**Registration requires human verification** (Cloudflare Turnstile) when
`TURNSTILE_SECRET` is configured: `/auth/register` checks the widget token at the
door, requiring `success`, a matching `action`, and an allowlisted `hostname`.
Unconfigured means skipped, so a self-hosted instance without a widget is not blocked.
There used to be a second widget action (`x_setup`) for the X setup leg; that leg is
gone with TOTP, so `register` is the only action left.

**Registration mints both wrappers**, so the account's key material is complete from
its first request: the password wrapper under the KEK just chosen, and the server
wrapper under `SERVER_DEK_KEY`. There is no mode to choose, and no second step.

That also collapses two ideas the design used to keep apart — **authentication** (who
you are) and **data unlock** (the key). They were separate states while an account
could exist with no server wrapper, and `isAuthenticated = true, isDataUnlocked =
false` was a legitimate one the UI showed rather than treating as failure. With the
wrapper on every account, holding a session means holding the key, so the client no
longer has an "authenticated but locked" state to represent. The only remaining
version of the split is on the *server* side, for an account that predates the
wrapper: `resolveApiContext` returns `{ denied: 'locked' }` and the MCP adapter turns
that into a readable message.

### The rule: a provider account must bind a fallback credential before it holds data

An account created through X or Google has no password, so there is no credential that
survives losing that provider account. Records calls therefore answer
`403 account_incomplete` until a name and password are bound
(`POST /auth/credentials/bind`), and the app routes to the binding screen. Sign-out
would be the wrong response: the session is valid, and it is exactly what the user
needs in order to bind.

This is deliberate and it is the anti-ban property: **if the X or Google account is
lost or suspended, the user signs in with the name and password they bound, and the
records are still there.** Nothing to migrate, nothing to lose.

The gate is on *records*, not on the account. A freshly created provider account can
sign in, read its login methods and bind a credential — which is what makes the gate a
prompt rather than a deadlock. `password_hash IS NULL` is the machine-checkable form of
"this account has no fallback yet".

### Provider login ends in a real session, always

A provider proves *identity*. It cannot supply the password, but with the server
wrapper on every account it does not need to: the deployment holds its own copy of
the record key. `POST /auth/{x,google}/exchange` therefore has exactly two
outcomes, and neither of them is "verified but not unlocked":

- `token: "<ks_…>"` — a live unlock already existed (another tab), and it is reused.
  `completeProviderSignIn` checks `findUserSession` first so a second round-trip does
  not open a second session for the same account.
- `token: "<ks_…>"`, from the server wrapper — no live unlock, so the deployment's
  copy of the key opens one. This is what makes provider sign-in feel like one click,
  and it is why the flow needs no return trip to a browser tab that is already open.

The route never returns `token: null` and has no `locked_token` field to return.
`server/test/accounts.test.ts` asserts exactly that, against an exchange made with no
live unlock.

The alternative — wrapping the DEK under something the provider can supply — would make
the key recoverable from the provider account, which is precisely the dependency this
rules out, and would hand that provider a path to the encryption key. The server
wrapper is *not* that: it is wrapped under a deployment secret (`SERVER_DEK_KEY`), not
anything the provider controls.

### What a provider is allowed to tell us

- **X** returns the numeric user id, username, display name and avatar. `provider_user_id`
  is the key; the handle is decoration and is allowed to change.
- **Google** returns exactly one thing: the `sub` claim of the ID token. The scope is
  `openid` alone, so there is no email, no name and no picture — `handle`, `displayName`
  and `avatarUrl` are all `null` by construction, and the page must render that absence
  rather than invent a glyph. The privacy policy states this, and
  `test/accounts.test.ts` asserts it against a token that *does* carry `email`/`name`/
  `picture`, because the risk is a later change quietly starting to use them.
- **Neither** provider is asked for `access_type=offline`, and no refresh token is
  stored: we read the identity once, at sign-in, and never call the provider again on
  the user's behalf. One fewer long-lived credential.

### Throttles and lockout

**Two independent throttles.** Per-account lockout (5 failures → 15 min) and a per-IP
window. Per-IP alone loses to a botnet; per-account alone lets an attacker spray.
Limits are configurable because households and offices share an IP. They exist on
`/auth/login`, `/auth/register` and account deletion; a failed sign-in does not spend
the session the caller already holds.

### Verified against the standard, not against itself

`test/accounts.test.ts` covers the flow with X's endpoints stubbed: where a request must
NOT issue a token, that a one-time code is single-use, that a link cannot be rebound to
a second account, that unlinking cannot lock a user out, that Google identity is read
from the ID token and its code is redeemable, and that CORS refuses a list of hostile
origins (including `hrt.kirayao.com.evil.test` and `null`). `test/recordsMigration.test.ts`
covers the binding gate itself, including that binding unlocks it.

### The service is mounted under a prefix, not at the host root

`api.kiramyao.com` already serves a comment service at `/comments/*`, so this service
lives at `/hrt/*` — one prefix per service. `BASE_PATH` is the only place that
appears; the router strips it once at dispatch, so no route below knows it is mounted.

The reason this matters is not tidiness. Both services have their own `/health` and
their own `auth/x/callback`, and a collision between two OAuth callbacks fails in the
worst possible way: silently, by redeeming one app's authorization codes against the
other's `oauth_states` table. The prefix makes that impossible, and two tests pin it —
requests outside the prefix get 404, and a near-miss (`/hrtx/health`) is refused
rather than matching a naive `startsWith`.

Route shapes follow the host convention: `/<service>/health`,
`/<service>/auth/...`, `/<service>/api/...`, `/<service>/mcp`. Note there is no bare
`/healthz` — that was this service's own invention and it is gone.

`BASE_PATH` is validated, and `.`/`..` segments are refused explicitly because they
pass a straightforward character class. A `..` segment would let the prefix match
paths outside its own subtree, which defeats the point of having a prefix.

### CORS is an exact-match allowlist

The site and API are on different hosts, so `Access-Control-Allow-Origin` must name
the one allowed origin rather than reflecting whatever arrives. Reflecting an origin
while allowing credentials lets any website issue authenticated requests as the user,
and that is why the spec forbids `*` with credentials. A hostile origin gets no CORS
header at all and fails the preflight with 403.

### Two bugs this work surfaced, both now pinned by tests

1. **The DEK arrived as `undefined`.** `const { dek } = await currentDekForEnrollment(…)`
   destructured a property off a **string**, which a primitive silently yields as
   `undefined` — so a session was opened with no key, and every encrypted read failed
   later with a confusing base64 error far from the cause. Fixed, and a `requireKey`
   guard now fails at the point a key enters a session.
2. **Recovery codes were written before the user row existed**, violating the foreign
   key, so every registration 500'd. The writes now happen inside the same transaction
   as the user row. The codes themselves are gone with the second factor, but the
   lesson is why the account row and its key material are written together.

## The public aggregate (`GET /stats`)

`GET /stats` is unauthenticated, because the status page that consumes it has no
account. It returns counts and one timestamp:

```json
{ "ok": true,
  "users":     { "total": 12, "new_24h": 1, "new_7d": 3 },
  "records":   { "doses": 410, "labs": 22 },
  "deletions": { "self": 2, "admin": 0 },
  "generated_at": "2026-09-17T12:00:00.000Z" }
```

**The privacy boundary, stated honestly.** This publishes the same *class* of
aggregate the app's own Transparency Centre used to publish, and no more. Every
figure is a `COUNT(*)` over a table the server cannot read: `medication_events`
and `lab_results` hold ciphertext (see "Records are encrypted at rest" above), so
a count says how many rows exist and nothing about their values. The `deletion_log`
is included because it is built to name nobody — no id, no username, no IP, no
timestamp tied to an account.

What is absent is the part worth asserting, and `test/stats.test.ts` does assert
it: it registers a real, identifiable account, walks every leaf of the live
response against an allow-list of count-shaped fields, and fails on any value that
is not a number or the timestamp. It also checks the serialised body contains
neither the username nor a UUID. A screenshot cannot show a leak in a payload, so
the check is on the bytes.

Two operational properties: the route is rate-limited per IP (60/min) because an
unauthenticated endpoint that counts every row is a cheap way to load the
database, and it sends `Cache-Control: max-age=60` so a status page polling it
does not scan the tables on every request.

## Not yet done

- **The web app's UI for the auth flow.** The API is complete and tested; the React
  screens that call it (the sign-in and registration form, the binding screen, the X
  callback landing routes) are not written. The routes the server redirects to are
  `/auth/x/callback` and `/auth/google/callback`.
- **The README's privacy claim** needs updating, per the section above.

## Deployment

See `DEPLOY.md`: the X developer-portal values, systemd unit, Caddy blocks for
`hrt.` and `api.`, and the checks that verify a deployment. It is written to be
additive to an existing service on the same host.


## Running it

```bash
cd server
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/hrt
npm run build && node dist/index.js migrate
node dist/index.js http        # REST + MCP at /mcp
node dist/index.js stdio       # local MCP on stdin/stdout
```

Connecting an agent:

```bash
# 1. Create an account and unlock it (returns an unlock token).
curl -s localhost:8788/api/register -H 'Content-Type: application/json' \
  -d '{"username":"me","password":"a-strong-password"}'

# 2. Mint a durable token for the agent.
curl -s localhost:8788/api/tokens -H "Authorization: Bearer $UNLOCK_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"claude"}'

# 3. Point the agent at http://localhost:8788/mcp with that token as a bearer.
```

The agent token works on its own: the server opens the account's records from its own
copy of the key, so the token does not need a live unlock and `/auth/logout` does not
stop it. Revoke the token or change the password to end it.
