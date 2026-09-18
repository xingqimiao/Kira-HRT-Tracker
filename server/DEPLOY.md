# Deployment

Target: the web app at `hrt.kiramyao.com`, this service on `api.kiramyao.com`
**under the `/hrt` prefix**, alongside an existing comment service that owns
`/comments/*` on the same API host.

The host shares one origin, so every service gets a prefix. That is not a
preference — without it, both services would want `/auth/x/callback`, and a
collision between two OAuth callbacks does not fail loudly. It silently redeems one
app's authorization codes against the other app's state table.

```
https://api.kiramyao.com
├── /comments/*      ← the existing comment service (health, api, auth/x, admin)
└── /hrt/*           ← this service
    ├── /hrt/health
    ├── /hrt/stats            ← public aggregate counts, no identifiers
    ├── /hrt/auth/register, /hrt/auth/login, /hrt/auth/unlock
    ├── /hrt/auth/x/*, /hrt/auth/google/*, /hrt/auth/credentials/bind
    ├── /hrt/api/settings, /hrt/api/medications, /hrt/api/labs, /hrt/api/timeline,
    │   /hrt/api/predict, /hrt/api/sync, /hrt/api/tokens, /hrt/api/records
    └── /hrt/mcp
```

Note the shape: `/<service>/auth/...` and `/<service>/api/...`, with no bare
`/healthz`. That mirrors the comment service's own layout, so the two read the same
way. `/hrt/stats` is deliberately outside `/api/`: it takes no token and belongs
with `/health` as a public read.

---

## 1. Values for the X developer portal

Register at <https://developer.x.com>. Three fields are required before a client id
and secret are issued, and all three must be filled even though only the first is
used by the login flow.

| Portal field | Value |
|---|---|
| **Callback URI / Redirect URL** (required) | `https://api.kiramyao.com/hrt/auth/x/callback` |
| **Website URL** (required) | `https://hrt.kiramyao.com` |
| **Organization name** | your real name or org — shown on the consent screen |
| **Organization URL** | `https://kiramyao.com` |
| **Terms of Service** | leave empty (see below) |
| **Privacy Policy** | `https://hrt.kiramyao.com/privacy` |

The callback **must** match `X_REDIRECT_URI` byte for byte, prefix included.

**Leave Terms of Service empty.** It is optional: X only requires the Terms and
Privacy Policy URLs when the app requests users' email addresses, and this app has
`requestEmailAddress: false`. The field is in the portal, but filling it is not a
condition of the app working.

This project used to publish one at `/terms`. It was removed: it duplicated the app's
own disclaimer, and the parts that were not duplication — governing law, jurisdiction,
liability cap — were guesses about an operator that does not exist as an entity. The
medical disclaimer belongs where the reader is about to act on an estimate, which is
the in-app `DisclaimerModal` and the line under a shared chart
(`src/i18n/share.ts`), both already present.

The Privacy Policy now lives on the **app subdomain**, `hrt.kiramyao.com/privacy`,
because that is where Google's brand verification requires it: the policy must be
"hosted within the same domain as your application's home page". It is a real static
file (`public/privacy/index.html`), so it survives the SPA fallback — the same trick,
and the same trap, as the paragraph below. `kiramyao.com/privacy` is still the wider
KiraMyao Equal policy and is linked from it; the app-specific page takes precedence
for anything about Kira Tracker. Google also requires the home page to describe the
app and link to the policy, which is why `index.html` carries real content inside
`#root` (`index.tsx` clears it before the first render).

Account deletion is implemented, so its deletion promise can be made honestly.

### Serving anything static on this host (the lesson the Terms page left behind)

There is no Terms page any more, but the trap it was built to avoid still applies to
any future static document under `hrt.kiramyao.com` (a licence page, an imprint, a
notice): **URL checkers do not execute JavaScript**, so an SPA route returns an empty
application shell that reads as a broken link.

Two things are needed, and both are in place:

1. The document must be a **real file** copied to the web root at build time, not a
   route — anything in `public/` is, e.g. `public/x/index.html -> dist/x/index.html
   -> https://hrt.kiramyao.com/x`.
2. Caddy must reach a directory's `index.html`. It uses
   `try_files {path} {path}/index.html /index.html`; the middle term is the one that
   matters. Without it `/x` falls through to the SPA shell while `/x/index.html` works,
   which passes a manual check and fails an automated one — exactly the bug `/terms`
   had before it was fixed, and it was live for a while because a person sees a
   working page (the shell loads the app).

Verify with JavaScript **disabled**, which is the only way to see what a checker sees:

```bash
curl -s https://hrt.kiramyao.com/<path> | wc -c        # a shell is ~2 KB, real content is much more
```

### Attribution is a requirement, not a courtesy

The upstream project's README asks that a public deployment **visibly link back to the
algorithm repository** and respect its licence terms. This is wired in three places:

| Where | What |
|---|---|
| App → Settings → About | a row titled "Algorithm & model credits", describing the source and linking to the repo |
| `THIRD-PARTY-LICENSES.md` | the model grant in full, plus the MIT copyright notice of the app code it is built from |
| `README.md` | the upstream project's own attribution section, untouched |

A link nobody can find does not satisfy "visibly", which is why the app row carries a
description line rather than being a bare icon.

**One thing to be aware of before deploying publicly** — see the licence note at the
end of this file. The algorithm repository does not declare a licence.

The two policy URLs must resolve. X checks them, and this app stores health data, so
a privacy policy is not paperwork here. The page needs at least:

- records are encrypted with AES-256-GCM and the key is held separately from the database,
- an X or Google account is only used to identify you, and never yields the record key,
- what is stored: dose logs, lab results, body weight.

Until a provider is configured the service runs normally on username + password,
`/hrt/health` reports `"x_login": false` / `"google_login": false`, and the sign-in
screen hides that button.

---

## 1b. The credentials you already have

`oauth2.0.txt` in the repo root holds the X client id and secret. They are now:

- **gitignored** (`.gitignore` has `oauth*.txt`, verified with `git check-ignore`), so
  `git add .` cannot commit them. This matters: an OAuth client secret in a public
  repository is a credential leak, and rotating it invalidates every stored login.
- **loaded into `server/.env`** for local development, which is itself gitignored.

Verified working end to end — the server boots with them and reports X login enabled:

```
boot    -> hrt-server: public=... x_login=on
health  -> {"ok":true,"service":"hrt","mount":"/","x_login":true}
/auth/x/start -> 200, authorize URL at https://twitter.com/i/oauth2/authorize
             client_id matches .env, scope=users.read tweet.read, PKCE=S256, secret not in the URL
```

**For production, change `X_REDIRECT_URI`** in `/srv/hrt/.env`:

```ini
X_REDIRECT_URI=https://api.kiramyao.com/hrt/auth/x/callback
```

X compares the callback byte for byte against the portal value. The local `.env` uses
`http://127.0.0.1:8788/auth/x/callback`, which X only accepts for `localhost` — and it
must be listed in the portal's Callback URI field if you want to test the flow locally.

---

## 2. Server setup

### 2.1 Layout

```
/srv/hrt/
  dist/index.js      # built bundle (npm run build)
  package.json
  node_modules/      # npm ci --omit=dev
  schema.sql
  .env               # chmod 600, owned by the service user
```

### 2.2 Database

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE hrt WITH LOGIN PASSWORD 'CHANGE_ME_STRONG';
CREATE DATABASE hrt OWNER hrt;
SQL
```

### 2.3 Environment

```bash
sudo install -d -o hrt -g hrt -m 750 /srv/hrt
sudo install -o hrt -g hrt -m 600 /dev/null /srv/hrt/.env
```

```ini
NODE_ENV=production

DATABASE_URL=postgres://hrt:CHANGE_ME_STRONG@127.0.0.1:5432/hrt

# The web app's origin: the only origin CORS allows, and where the OAuth callback
# sends the browser back to.
PUBLIC_ORIGIN=https://hrt.kiramyao.com

# This service's host and mount prefix. The prefix must match the reverse proxy's
# routing and the X Callback URI.
API_ORIGIN=https://api.kiramyao.com
BASE_PATH=/hrt

PORT=8788
BIND_HOST=127.0.0.1

# Encrypts record payloads at rest (AES-256-GCM). Back this up separately from the
# database: a dump without it is unreadable, and losing it makes every stored record
# unreadable too. Rotating it has the same effect — there is no re-wrap path.
ENCRYPTION_KEY=<openssl rand -base64 32>

# Wraps each account's data key for standard-mode accounts, so the server can serve
# their records without asking for a password. Without it every account behaves as
# advanced mode: identity still signs you in, but the key needs a credential.
SERVER_DEK_KEY=<openssl rand -base64 48>

SESSION_TTL_MINUTES=10080

# Per-IP budgets. Raise if a shared NAT hits them. Defaults: 5 / 10 / 5 per minute.
# RATE_LIMIT_LOGIN=10
# RATE_LIMIT_REGISTER=5
# RATE_LIMIT_WINDOW_MS=60000

# Provider login. Omit a provider's pair to run without it; the app then reports it
# as unconfigured and hides the button. Half-configured is refused at boot.
X_CLIENT_ID=<from the portal>
X_CLIENT_SECRET=<from the portal>
X_REDIRECT_URI=https://api.kiramyao.com/hrt/auth/x/callback

GOOGLE_CLIENT_ID=<from the Google Cloud console>
GOOGLE_CLIENT_SECRET=<from the Google Cloud console>
GOOGLE_REDIRECT_URI=https://api.kiramyao.com/hrt/auth/google/callback
```

`TOTP_ENC_KEY` is gone: it sealed second-factor secrets, and there is no second
factor any more. Leaving it in `.env` is harmless — nothing reads it.

Leave `PORT` at 8788 — the comment service is on its own port, and nothing here
depends on which.

### 2.4 Migrate

```bash
sudo -u hrt env $(sudo grep -v '^#' /srv/hrt/.env | xargs) \
  node /srv/hrt/dist/index.js migrate
```

Idempotent, and includes `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for columns added
after the first release, so re-running against an existing database is safe.

### 2.5 systemd

`/etc/systemd/system/hrt-server.service`:

```ini
[Unit]
Description=HRT tracker API and MCP server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=hrt
Group=hrt
WorkingDirectory=/srv/hrt
EnvironmentFile=/srv/hrt/.env
ExecStart=/usr/bin/node /srv/hrt/dist/index.js http
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
# Left false on purpose: V8 needs writable-executable memory for JIT, and enabling
# this makes Node die at startup with an unhelpful signal.
MemoryDenyWriteExecute=false
ReadWritePaths=/srv/hrt

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hrt-server
curl -s localhost:8788/hrt/health
```

Note the prefix even on loopback: the service expects it on every request, since
stripping happens at the router.

---

## 3. Reverse proxy

**Append** to the existing Caddyfile. The comment service's blocks are untouched.

The ordering rule that matters: the `/hrt/*` block must come before any catch-all,
and `/hrt/mcp` needs buffering off or tool calls appear to hang.

```caddyfile
# --- HRT API, mounted at /hrt on the shared API host ---------------------
# Caddy matches most-specific-first, so /hrt/* wins without disturbing /comments/*.
api.kiramyao.com {
    encode zstd gzip

    # The MCP endpoint is a streaming JSON-RPC transport. Flushing must not wait for
    # a full buffer.
    handle /hrt/mcp {
        reverse_proxy 127.0.0.1:8788 {
            flush_interval -1
            transport http {
                read_timeout 0
                write_timeout 0
            }
        }
    }

    handle /hrt/* {
        reverse_proxy 127.0.0.1:8788
    }

    # Everything else on this host belongs to the comment service. If its block is
    # already defined for this hostname, leave it alone; this one only claims /hrt.
    log {
        # Never log bodies: they contain doses and lab values.
        output file /var/log/caddy/hrt-api.log
        format json
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        -Server
    }
}

# --- HRT web app ---------------------------------------------------------
hrt.kiramyao.com {
    encode zstd gzip
    root * /srv/hrt-web
    try_files {path} /index.html
    file_server

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.kiramyao.com; frame-ancestors 'none'; base-uri 'self'"
        -Server
    }
}
```

`style-src 'unsafe-inline'` is there because Tailwind + React inject style
attributes. Drop it if you can build without that.

If the comment service's block for `api.kiramyao.com` uses a bare `handle { ... }`
catch-all, **you must merge rather than add**: Caddy refuses two blocks for the same
hostname with overlapping matchers, and the HRT block has to sit alongside it in the
same site block. Check with:

```bash
grep -n "api.kiramyao.com" /etc/caddy/Caddyfile
```

Then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

---

## 4. Build and deploy the web app

```bash
cd /path/to/repo
# The prefix is part of the API base URL the app calls.
VITE_API_ORIGIN=https://api.kiramyao.com/hrt npm run build
sudo rsync -a --delete dist/ /srv/hrt-web/
```

**Take a rollback copy of both halves before you replace them.** The web root is
cheap (`tar -czf /srv/backup/hrt-web-$(date -u +%Y%m%d-%H%M%S).tar.gz -C /srv/hrt-web .`)
and so is the server bundle, but only if you make it *first* — and the bundle is the
one that gets forgotten, because `/srv/hrt/dist/` already looks like it is full of
backups. It is: the convention is `index.cjs.bak-<label>-<timestamp>`, written before
the install that replaced it. Overwriting `index.cjs` without adding one leaves no
staged way back, and rebuilding an old commit is a slower path than a `cp`.

`VITE_API_ORIGIN` is read by `src/services/apiClient.ts`. Without it the requests go
same-origin and every API call from `hrt.` would 404 against the static host.

**Do not skip that variable, and do not trust a green build to tell you.** It is the
one setting whose failure is silent in a way that looks like something else entirely.
Build without it and the site still loads and still looks right; the only symptom is
behavioural — **the「使用 X 继续」button disappears, with no error anywhere.** That is
because `CoreAuthForm` decides whether to offer X by fetching `/health` and reading
`x_login`; against the static host that request 404s, an unreadable answer is treated
as "not configured", and the button is simply not rendered. Every other route keeps
working, so it reads as a broken X app rather than a build mistake.

If you are unsure how a bundle was built:

```bash
grep -l 'api\.kiramyao\.com/hrt' dist/assets/*.js   # must print at least one file
```

No output means it was built without the origin. `dist/` is not tracked, so this
never appears as a diff — there is no commit to review that would catch it. It was
missed once during the 2026-09-18 deployment for exactly that reason.

---

## 5. Verifying a deployment

```bash
# 1. Liveness, mount, and whether X login is configured.
curl -s https://api.kiramyao.com/hrt/health
#  -> {"ok":true,"service":"hrt","mount":"/hrt","x_login":false}

# 2. The prefix is enforced: the same paths outside it must NOT be served.
curl -s -o /dev/null -w '%{http_code}\n' https://api.kiramyao.com/health   # not 200
curl -s -o /dev/null -w '%{http_code}\n' https://api.kiramyao.com/hrtx/health  # not 200

# 3. The comment service still works (nothing here shadowed it).
curl -s https://api.kiramyao.com/comments/health

# 4. CORS allows exactly the app origin.
curl -sI https://api.kiramyao.com/hrt/health -H 'Origin: https://hrt.kiramyao.com' | grep -i access-control-allow-origin
curl -sI https://api.kiramyao.com/hrt/health -H 'Origin: https://evil.example' | grep -i access-control-allow-origin || echo "correctly refused"

# 5. Registration returns a session at once — there is no second factor to confirm.
curl -s https://api.kiramyao.com/hrt/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"smoketest","password":"a-smoke-test-password"}'
#  -> 201 {"user_id":"…","username":"smoketest","token":"ks_…"}

# 6. The public aggregate. Needs no token, and the body must be counts only —
#    no ids, no usernames, nothing per-account. If this ever returns a row-shaped
#    value, the privacy claim in ARCHITECTURE.md is false.
curl -s https://api.kiramyao.com/hrt/stats
#  -> {"ok":true,"users":{...},"records":{...},"deletions":{...},"generated_at":"..."}

# 6. The callback path reaches this service, not the comment service.
curl -sI 'https://api.kiramyao.com/hrt/auth/x/callback?code=x&state=y' | head -3

# 7. The Privacy Policy returns a real document, not an app shell. This is what a URL
#    checker sees, and it is the difference between a working policy link and a blank
#    page. Look for the text, not just the status code — and remember the app
#    subdomain has a shell that returns 200 for anything, so a 200 proves nothing.
#    Google's verifier does not run JavaScript, so both of these matter.
curl -s https://hrt.kiramyao.com/privacy | grep -c "openid"          # >= 1
curl -s https://hrt.kiramyao.com/ | grep -c "Kira Tracker"          # >= 1
curl -s https://hrt.kiramyao.com/privacy | wc -c                    # ~12k, not ~2.8k

# 8. One provider sign-in still ends in a session, not a dead URL: the callback hands
#    the browser a one-time code, and the exchange turns it into a session.
curl -s https://api.kiramyao.com/hrt/auth/google/start | head -c 120
```

For step 8, the browser half needs a real Google account: sign in with Google, confirm
you land back in the app signed in, then `POST /hrt/auth/google/exchange` is what the
app calls with the `code` from the URL.

---

## 6. Operations

**Backups.** Two keys, not one. `ENCRYPTION_KEY` opens every record payload, and
`SERVER_DEK_KEY` unwraps the per-account data keys of standard-mode accounts. A
database restore without both is a database full of ciphertext. Store both off the
database host.

**Rotating either key is destructive.** `ENCRYPTION_KEY` has no re-wrap path: rotating
it makes every existing `payload_encrypted` unreadable. `SERVER_DEK_KEY` can be
rotated only by re-wrapping each account's DEK with the password in hand, so in
practice it is not rotatable either. Treat both as permanent.

**A lost password on an advanced-mode account.** Advanced mode has no server wrapper,
so the operator cannot open the account's records. The self-service path is the
recovery key (`/auth/recovery-key`, set from Settings before it is needed); with
neither, the data is unrecoverable by design. A standard-mode account can be reached
with the server key.

**An X or Google ban.** The user signs in with their username and password; the
provider link is one row in `oauth_accounts` and can be removed from the account page.
This is why a provider-created account is forced to bind a fallback credential before
it can store anything — records calls answer `403 account_incomplete` until it does.

**Audit queries:**

```sql
SELECT kind, count(*) FROM auth_events GROUP BY kind ORDER BY 2 DESC;
-- Locked accounts: an attack in progress, or a user who mistyped.
SELECT username, failed_unlocks, locked_until FROM users WHERE locked_until > now();
-- Accounts created through a provider that never bound a fallback credential.
SELECT u.username, o.provider, u.created_at
  FROM users u JOIN oauth_accounts o ON o.user_id = u.id
 WHERE u.password_hash IS NULL ORDER BY u.created_at;
```

**Dropping the old second-factor columns.** `users.totp_secret_sealed`,
`users.totp_enabled_at`, `users.totp_last_step` and the `totp_backup_codes` table are
still in `schema.sql` and still in the production database. Nothing reads or writes
them since TOTP was removed, and all three columns are nullable, so leaving them costs
nothing but a little confusion. Drop them only *after* the code change is live and
verified, so a rollback to the previous release still boots; and if you drop them by
hand, remember `ALTER TABLE users OWNER TO hrt` is not needed for a `DROP COLUMN` on a
table `hrt` already owns, but the ownership probe below is.

---

## 7. Changing the prefix later

`BASE_PATH` is the only place the prefix lives, but changing it is not free:

1. Stop the service.
2. Update `BASE_PATH`, `X_REDIRECT_URI`, the proxy routes, and `VITE_API_ORIGIN`.
3. Update the portal's Callback URI — X rejects a mismatch with `redirect_uri`
   errors that do not name the field.
4. Rebuild the web app.

`X_REDIRECT_URI` and the portal value must agree exactly, so change both in the same
step. There is no migration needed for stored data; no row records a URL.

---

## 8. Licence status of the algorithm code — read before deploying publicly

This is a factual finding, not legal advice. It needs a decision from you, and it is
the one thing in this deployment that I cannot resolve from the code.

### What I checked

| Repository | Role | Declared licence |
|---|---|---|
| `LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test` | **the algorithm this app computes with** | **none** |
| `LaoZhong-Mihari/HRT-Recorder-online` | the original web app (upstream of the fork below) | none |
| `xunxunProjects/Oyama-s-HRT-Tracker` | the app code you are building on | MIT |

Verified against the GitHub API (`/license` returns 404 and the repo metadata's
`license` field is `null` for the first two). There is no `LICENSE` file and the README
states no terms.

### What this means

**A repository with no licence is not public-domain software.** Under the Berne
Convention, copyright attaches automatically on creation. Absent a licence, the default
position is *all rights reserved*: you have no granted right to copy, modify, or
redistribute that code, however publicly visible it is on GitHub.

This app uses that model in two forms:

- `logic.ts` in this repository, inherited from the MIT-licensed fork, is a port of its
  `PKcore.swift` / `PKparameter.swift` logic and includes its parameter tables.
- The parameters and model structure are the substance of the app, not incidental.

So "respect the licence" in the upstream README is doing real work: the MIT licence
covers the app code, but **the algorithm those parameters came from carries no licence
grant at all**.

### Your options, in the order I would consider them

1. **Ask the author.** Open an issue or contact `@LaoZhong-Mihari` and request a licence
   (MIT, or explicit written permission to reuse the model). This is the clean fix, and
   for a personal, non-commercial HRT tool it is likely to be granted quickly. It also
   resolves the ambiguity permanently rather than trading on it.
2. **Deploy privately and non-commercially** while you wait. The practical risk of a
   dispute over a personal, unmonetised health tool is low, and the attribution
   requirement is already satisfied. This is a risk posture, not a legal position.
3. **Accept the risk knowingly.** Reasonable for private use, indefensible for anything
   commercial or promotional.

### If you want to deploy without depending on that grant

Reimplementing the model from published literature is a genuinely different route —
pharmacokinetic parameters for estradiol esters are documented in the literature and in
FDA labels (the code's own comments cite several). A clean implementation from primary
sources avoids the uncopyrightable-parameters question entirely, because it does not
copy that code. It is also a substantial piece of work, and the existing parameters are
calibrated against stated steady-state targets, so a reimplementation needs its own
validation.

**Recommendation: option 1.** Ask, and deploy personally in the meantime. It costs one
issue and removes the only unresolved legal question in this deployment.
