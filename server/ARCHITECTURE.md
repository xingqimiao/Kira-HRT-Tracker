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

### Records are encrypted at rest, and the key is session-scoped

The product's headline claim is that the operator cannot read your hormone record.
Answering `hrt.list_medications` from the server while keeping that claim true
needs a specific shape:

- The **KEK** comes from the account password and user id — the same derivation
  the web app already uses for its cloud backups. The server sees the password
  only during an unlock request and stores only a scrypt hash, which derives
  nothing.
- The **DEK** is random per account and is what actually encrypts records. It is
  stored server-side only as a ciphertext wrapped under the KEK, so the stored
  material reveals nothing.
- An **unlocked** session holds the DEK in memory for 30 minutes of idle time.
  That window is when the server can read the account's data.

That last point is the honest description of the tradeoff, and it is worth stating
plainly rather than glossing: **this is not "the server never sees the data".** It
is "the server holds no key at rest, and only in memory while the user has
explicitly unlocked". An agent connecting with a durable token gets no separate
key — the token proves identity, and it only works while the user has an unlock
open.

Two consequences follow, both accepted deliberately:

1. **The README's E2E claim needs revising.** Once an LLM is in the data path, the
   model provider holds plaintext in its context. End-to-end encryption in the
   strict sense is not preservable through an agent, and claiming otherwise would
   be false.
2. **No SQL-level reporting over health data.** The server cannot aggregate doses
   or labs, because it cannot read them. `user_id` and `occurred_at` are the only
   cleartext columns; everything clinical is inside the envelope.

Password change re-wraps the DEK rather than re-encrypting records, so it is one
row and cannot half-fail.

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
| TOTP 2FA + backup codes | yes | no |
| Passkeys / WebAuthn | yes | no |
| Session list & revoke | yes | no (unlock TTL only) |
| Admin | yes | no |
| Unlock token | n/a | yes (`ks_…`) |
| Agent API token | n/a | yes (`hrt_…`) |

So "migrate the app to the Core" cannot be finished by wiring a hook: the app's
`token` is a Worker JWT, while `/api/sync` needs a Core unlock token, and the two
systems issue credentials independently. Three ways forward, and they differ enough
that this should not be chosen by accident:

1. **Port TOTP to the Core, drop passkeys.** TOTP is genuinely small — the
   `totp_secret` and `backup_codes` columns already exist in `schema.sql`
   (inherited from the original design), and verification is an HMAC over a time
   step in `node:crypto`. Dropping passkeys is a security *regression*, so this
   needs an explicit yes.
2. **Port both.** TOTP plus a WebAuthn library and the passkey tables. The most
   complete, and the most work.
3. **Keep the Worker as the identity provider and let the Core trust it.** Smallest
   change to the app, but it moves where the DEK can be unwrapped: the Core would
   have to accept identity asserted by another service, which weakens the "the
   operator holds no key at rest" property unless the DEK wrapping moves with it.
   This is the option to choose if the priority is shipping rather than purity —
   but it should be chosen knowingly.

Until this is settled, the app keeps its current path and the Core is reached
either by an agent (MCP) or by an import/sync, which is already enough to move a
real history across today.

### A trap worth knowing before running tsc on both trees

`tsc -p tsconfig.json` at the repo root reports **26 errors in the server** that
are all false. The cause is not the code: the root config has no `strict`, so
`strictNullChecks` is off and a `union` discriminated by a boolean cannot narrow
at all, which turns every early `return fail(...)` in `domain.ts` and `core.ts`
into an apparent type mismatch. Under `server/tsconfig.json` (which sets
`strict: true` and `lib: [ES2023, DOM]`) the server's `src/` is clean, and the same
code passing under a looser config is not evidence of a real defect.

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

## Authentication: password + mandatory TOTP, X as an assist

The decision was made, so this section replaces the "blocked" one: **password plus
mandatory TOTP is the only way in, and X OAuth2 can create and identify an account
but never produce a usable one by itself.**

### The rule, and why it is structural rather than policy

An account is usable only when it has **both** a password and a confirmed TOTP
enrolment. Registration does not return a session; it returns enrolment material and
a single-use token that can only finish setup. This is not a policy that a future
change could loosen by accident — it falls out of the key design:

- The DEK is wrapped under a password-derived KEK.
- An account with no password therefore has **no key**, and so no readable records.

So an X-only account cannot hold data, which is exactly what was asked for: if an X
account is banned, the user signs in with their password and unlinks it. Nothing to
migrate, nothing to lose. `password_set_at IS NULL` is the machine-checkable form of
"this account cannot hold data yet".

### X login cannot skip the password, and that is correct

X proves *identity*. It cannot supply the password, and the password is what unwraps
the key. So an X sign-in verifies the person, then still needs the password before any
record is readable. `POST /api/auth/x/exchange` reports this honestly:

- `token: null` — X verified you; the data key needs your password. The client
  pre-fills the username and runs the normal sign-in.
- `token: "<ks_…>"` — the account already had a live unlock on this server, so it is
  reused. This is what makes X sign-in feel like one click in the common case.

The alternative — wrapping the DEK under something X can supply — would make the key
recoverable from the X account, which is precisely the dependency the requirement
rules out, and would hand X a path to the encryption key.

### Second-factor specifics

- **Replay protection.** `users.totp_last_step` must strictly increase, enforced in
  the `UPDATE`'s `WHERE` so two concurrent submissions of one code cannot both
  succeed. Verified: the same code fails on second use, and the next step works.
- **Enrolment does not spend the step.** Deliberate, and the reason is usability
  rather than security: spending it would reject a user who finishes signup and then
  signs in on a second device within the same 30-second window, which reads as
  "setup failed". Nothing weakens — confirming requires the single-use enrolment
  token, and the step is spent the first time a code actually opens access.
- **TOTP secrets are encrypted at rest** under `TOTP_ENC_KEY`. A database dump that
  carried secrets in the clear would silently remove the second factor for every
  account, which is worse than not offering 2FA. Losing this key invalidates
  enrolments but not recovery codes.
- **Recovery codes** are hashed with scrypt (they are passwords in effect), single-use
  (`used_at IS NULL` in the `WHERE` guard), and normalised for case, spacing and the
  hyphen.
- **Two independent throttles.** Per-account lockout (5 failures → 15 min) and a
  per-IP window. Per-IP alone loses to a botnet; per-account alone lets an attacker
  spray. Limits are configurable because households and offices share an IP.

### Verified against the standard, not against itself

`test/totp.test.ts` asserts **RFC 6238's published vectors**, not values this code
produced. A round-trip test ("the code I generated verifies") passes just as happily
for a wrong algorithm — which is the failure that would ship, since correct-looking
codes that no authenticator accepts are invisible to a self-consistent test.

`test/accounts.test.ts` covers the whole flow with X's endpoints stubbed: where a
request must NOT issue a token, that a link cannot be rebound to a second account,
that unlinking cannot lock a user out, and that CORS refuses a list of hostile origins
(including `hrt.kirayao.com.evil.test` and `null`).

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
   as the user row, which is also what prevents an account with no recovery codes.

## Not yet done

- **The web app's UI for the auth flow.** The API is complete and tested; the React
  screens that call it (enrolment with a QR code, recovery-code display, the X
  callback landing routes) are not written. The routes the server redirects to are
  `/auth/x/callback` and `/auth/x/setup`.
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

The agent token works only while the account has an unlock open — locking the
account stops agent access without revoking the token.
