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
    ├── /hrt/auth/register, /hrt/auth/login, /hrt/auth/totp/*, /hrt/auth/x/*
    ├── /hrt/api/settings, /hrt/api/medications, /hrt/api/labs, /hrt/api/timeline,
    │   /hrt/api/predict, /hrt/api/sync, /hrt/api/tokens
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
| **Terms of Service** | `https://hrt.kiramyao.com/terms` |
| **Privacy Policy** | `https://kiramyao.com/privacy` |

The callback **must** match `X_REDIRECT_URI` byte for byte, prefix included.

**Both policy URLs must resolve before you submit**, and X checks that they are
*linked from* the app, not merely reachable. The Terms URL is already wired: it is a
static file at `public/terms/index.html`, served with real content (verified — see
below). The Privacy Policy lives on the main domain and is yours to write; the guide
is in `PRIVACY-POLICY-GUIDE.md`. Account deletion is implemented, so its deletion
promise can be made honestly — the guide says what to claim and which claims would be
false.

### Why the Terms page is a static file and not an app route

URL checkers do not execute JavaScript. An SPA route would return the empty
application shell — a blank document that reads as a broken policy link. So the page
is a real file, copied verbatim to the web root at build time:

```
public/terms/index.html  ->  dist/terms/index.html  ->  https://hrt.kiramyao.com/terms
```

`/terms` and `/terms/` both resolve, because Caddy's `try_files` + `file_server`
already serves a directory's `index.html`. No Caddy change is needed.

Verified against a server configured the same way:

```
/terms            -> 200  bytes=8786  real content, not an SPA shell
/terms/           -> 200  bytes=8786
/terms/index.html -> 200  bytes=8786
```

Find the values still to fill in:

```bash
grep -o '\[\[[A-Z_]*\]\]' dist/terms/index.html | sort -u
```

Served as a directory index, so the page inherits `hrt.kiramyao.com`'s security
headers — including `frame-ancestors 'none'`, which keeps the document from being
embedded somewhere it could be misrepresented.

**Scopes:** `users.read tweet.read`, set in code (`src/oauth.ts`), not in the portal.

`tweet.read` is not used to read a post — this app never fetches one — but
`GET /2/users/me` answers **403** without it, so sign-in completes at X and then
fails at the profile fetch. The pair is the minimum that actually works, verified
against a real login on 2026-09-18. Do not narrow it on the reasoning that a login
only needs an identity: the authorize step still succeeds, so the failure appears
one call later and reads as a broken credential.

**Permissions:** "Read" is enough. Login never needs write access.

### Attribution is a requirement, not a courtesy

The upstream project's README asks that a public deployment **visibly link back to the
algorithm repository** and respect its licence terms. This is wired in three places:

| Where | What |
|---|---|
| App → Settings → About | a row titled "Algorithm & model credits", describing the source and linking to the repo |
| `hrt.kiramyao.com/terms` section 2 | the same attribution, plus the MIT copyright notice of the app code it is built from |
| `README.md` | the upstream project's own attribution section, untouched |

A link nobody can find does not satisfy "visibly", which is why the app row carries a
description line rather than being a bare icon.

**One thing to be aware of before deploying publicly** — see the licence note at the
end of this file. The algorithm repository does not declare a licence.

The two policy URLs must resolve. X checks them, and this app stores health data, so
a privacy policy is not paperwork here. Each page needs at least:

- records are encrypted and the operator holds no key at rest (see `ARCHITECTURE.md`),
- an X account is only used to identify you and never gets access to your key,
- what is stored: dose logs, lab results, body weight.

Until X is configured the service runs normally on password + TOTP, `/hrt/health`
reports `"x_login": false`, and the sign-in screen should hide the button.

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

# Encrypts TOTP secrets at rest. Back this up separately from the database: a dump
# without it cannot mint second-factor codes, but losing it invalidates enrolments.
TOTP_ENC_KEY=<openssl rand -base64 48>

SESSION_TTL_MINUTES=30

# Per-IP budgets. Raise if a shared NAT hits them. Defaults: 5 / 10 / 5 per minute.
# RATE_LIMIT_LOGIN=10
# RATE_LIMIT_REGISTER=5
# RATE_LIMIT_RESUME=5
# RATE_LIMIT_WINDOW_MS=60000

# X login. Omit all three to run on password + TOTP only.
X_CLIENT_ID=<from the portal>
X_CLIENT_SECRET=<from the portal>
X_REDIRECT_URI=https://api.kiramyao.com/hrt/auth/x/callback
```

```bash
echo "TOTP_ENC_KEY=$(openssl rand -base64 48)"
```

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

# 5. Registration must NOT return a session token — TOTP is mandatory.
curl -s https://api.kiramyao.com/hrt/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"smoketest","password":"a-smoke-test-password"}'

# 6. The public aggregate. Needs no token, and the body must be counts only —
#    no ids, no usernames, nothing per-account. If this ever returns a row-shaped
#    value, the privacy claim in ARCHITECTURE.md is false.
curl -s https://api.kiramyao.com/hrt/stats
#  -> {"ok":true,"users":{...},"records":{...},"deletions":{...},"generated_at":"..."}

# 6. The callback path reaches this service, not the comment service.
curl -sI 'https://api.kiramyao.com/hrt/auth/x/callback?code=x&state=y' | head -3

# 7. The Terms URL returns a real document, not the app shell. This is what a URL
#    checker sees, and it is the difference between a working policy link and a blank
#    page. Look for the text, not just the status code.
curl -s https://hrt.kiramyao.com/terms | grep -c "Terms of Service"

# 8. And the Privacy Policy, once written, must resolve too — it lives on the main
#    domain, not on the app subdomain.
curl -sI https://kiramyao.com/privacy | head -1
```

For step 5: scan `totp.otpauth_uri` with an authenticator, then
`POST /hrt/auth/totp/confirm`, then `POST /hrt/auth/login` with a code. That is the
whole mandatory-2FA path in four requests.

---

## 6. Operations

**Backups.** The database alone is not sufficient. `TOTP_ENC_KEY` seals the
second-factor secrets, so a restore without it locks every user out of 2FA (recovery
codes still work, and a user can regenerate). Store the key off the database host.

**Rotating `TOTP_ENC_KEY`** invalidates every enrolment. Recovery codes survive —
they are hashed independently — but expect support load. Prefer not to rotate.

**Lost authenticator.** A recovery code signs in and reports how many remain. With
none left there is no self-service path: the account is password-wrapped, so the
operator cannot reset it without the password. That is the intended trade.

**An X ban.** The user signs in with password + TOTP and unlinks X on the account
page. No data is involved — an X-created account cannot store a single record until a
password exists.

**Audit queries:**

```sql
SELECT kind, count(*) FROM auth_events GROUP BY kind ORDER BY 2 DESC;
-- Locked accounts: an attack in progress, or a user who mistyped.
SELECT username, failed_unlocks, locked_until FROM users WHERE locked_until > now();
-- Accounts that never finished setup.
SELECT username, created_at FROM users WHERE totp_enabled_at IS NULL ORDER BY created_at;
```

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
