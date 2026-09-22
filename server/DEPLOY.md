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
    ├── /hrt/auth/register, /hrt/auth/login, /hrt/auth/logout
    ├── /hrt/auth/x/*, /hrt/auth/google/*, /hrt/auth/credentials/bind
    ├── /hrt/auth/sessions, /hrt/auth/account, /hrt/auth/account/delete
    ├── /hrt/api/settings, /hrt/api/records, /hrt/api/tokens
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
| **Privacy Policy** | `https://kiramyao.com/privacy` |

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

The Privacy Policy lives at `https://kiramyao.com/privacy` — the wider KiraMyao Equal
policy, whose §26 covers Kira HRT Tracker. The app subdomain used to serve its own copy at
`hrt.kiramyao.com/privacy`, added for Google's brand verification because the policy
must be "hosted within the same domain as your application's home page"; that page and
its `public/privacy/` source have been **removed on purpose**. The same-domain
condition is therefore no longer met, so a future verification attempt can fail on it —
that is a known, accepted trade, not a regression. Google also requires the home page to
describe the app and link to the policy, which is why `index.html` carries real content
inside `#root` (`index.tsx` clears it before the first render), and that link now points
at the absolute policy URL.

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
  dist/index.cjs     # built bundle (npm run build)
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

# Wraps each account's data key, alongside the password wrapper. Every account carries
# it, which is what lets provider sign-in finish in one round-trip and lets a durable
# `hrt_` agent token read records with no live unlock. Required in production: the
# server refuses to boot without it.
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
  node /srv/hrt/dist/index.cjs migrate
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
ExecStart=/usr/bin/node /srv/hrt/dist/index.cjs http
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

    # The SPA shell belongs to a *navigation*, never to a missing asset.
    #
    # A site-level `try_files {path} /index.html` answers every unmatched path with
    # the shell, and Caddy's static handler reports that as a 200 `text/html`. For
    # `/ocr/*` that is worse than a 404: those files are cached by URL (the service
    # worker's `ocr-assets` cache in `vite.config.ts`, plus the browser's own
    # cache), so a single missing language file is stored *as* the language file and
    # served for a year. tesseract.js then initialised without Chinese, read a
    # Chinese label as noise, and reported "no usable values" on a perfectly legible
    # report — and no redeploy could clear it, because the poisoned copy is in the
    # client. A local `vite preview` cannot reproduce this, because it answers the
    # same missing path with a real 404. The engine is PP-OCRv6 now and the failure
    # mode is unchanged: a 2 KB HTML page handed to `InferenceSession.create` is
    # either an opaque protobuf error or, worse, a model that loads and reads noise.
    #
    # `file_server` alone returns 404 for anything not on disk, so the asset paths
    # are matched without the fallback. `/sw-*.js` is here for the same reason: a
    # stale service worker's script URL must 404 (which makes the browser drop the
    # registration) rather than be answered with an HTML document that cannot parse
    # as a worker, which would pin the client to the old build.
    @asset path /assets/* /ocr/* /sw-*.js
    handle @asset {
        file_server
    }

    # Everything else is the SPA.
    handle {
        try_files {path} /index.html
        file_server
    }

    # The account avatar, proxied to the API and **rewritten onto this origin**.
    #
    # Two things are happening here and both are needed. The picture is copied from
    # Google or X once, at sign-in, into `oauth_accounts.avatar_image`, and
    # `GET /hrt/auth/avatar/<id>` on the API serves it back. But `img-src 'self'` does not
    # allow `api.kiramyao.com`, so loading it from there is blocked by the browser — which
    # is the very bug this feature exists to fix, and it would look identical to "we never
    # stored a picture".
    #
    # So the app's **own** origin proxies it, and the proxied response names this origin in
    # `Content-Location`. That header is not decoration: the API reports the absolute
    # URL in `/auth/account`, and this is what makes the browser resolve that URL
    # against `hrt.kiramyao.com`. Leave the block out and avatars disappear, with a CSP
    # error in the console and nothing in the server log.
    #
    # Two details the 2026-09-22 deployment got wrong, both worth stating because each
    # fails as "a 404 that looks like a working response":
    #
    #   1. This service is mounted at `/hrt` on 8788, so the upstream needs the prefix
    #      the app's own URL does not have. Without the `rewrite` the proxy asks the API
    #      for `/auth/avatar/<id>`, which is outside the mount and 404s.
    #   2. Caddy 2.6 has **no** `http.reverse_proxy.upstream.uri.path.file` placeholder —
    #      writing one emits it verbatim, and a literal `{…}` in `Content-Location`
    #      resolves to nothing. The value is the request's own path, captured before the
    #      rewrite adds the prefix. (`Content-Location` is not decoration: the API reports
    #      the avatar as an absolute `api.kiramyao.com` URL, and this header is what makes
    #      the browser resolve it against the app's origin, which `img-src 'self'` allows.)
    handle /auth/avatar/* {
        header Content-Location {http.request.uri.path}
        rewrite * /hrt{uri}
        reverse_proxy 127.0.0.1:8788 {
            header_up Host {upstream_hostport}
        }
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        # `connect-src` gained the app's own origin. The CSP in this header (and the
        # equivalent one on the API host) is delivered as a response header, but the
        # browser enforces it against the document's *own* origin, so every fetch the
        # bundle makes to `hrt.kiramyao.com/auth/avatar/...` had to be allowed here.
        # Nothing external was added: `img-src` stays `self`, which is the point — a
        # provider CDN in that list is what this design exists to avoid.
        #
        # `'wasm-unsafe-eval'` is the one keyword the scan feature needs and cannot work
        # without. ONNX Runtime Web compiles its WebAssembly module with
        # `WebAssembly.instantiate`, and a bare `script-src 'self'` blocks that in every
        # current browser — the scan fails with a CSP violation and nothing in the
        # server log. The keyword re-enables *only* WebAssembly compilation: unlike
        # `'unsafe-eval'` it does not allow `eval()` or `new Function()` for JavaScript,
        # and it does not widen `connect-src`, so the runtime and the models are still
        # fetched from this origin and nowhere else. Do not substitute the broader
        # keyword for it.
        Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://hrt.kiramyao.com https://api.kiramyao.com; frame-ancestors 'none'; base-uri 'self'"
        -Server
    }
}
```

**What the scan needs from the policy.** The lab-report scan runs PP-OCRv6 through ONNX
Runtime Web, which is WebAssembly, so `script-src` must carry `'wasm-unsafe-eval'` — see
the note in the block above. Nothing else changes: the runtime, both models and the
character dictionary are served from `/ocr/*` on this host, which `default-src 'self'`
already allows; they load on the main thread with a single thread, so no `worker-src` and
no COOP/COEP (`crossOriginIsolated`) headers are needed; and the ONNX Runtime WASM
binary is fetched with `fetch()`, which `connect-src 'self'` covers. The `@asset` block
above must keep matching `/ocr/*`: a model answered with the SPA shell instead of a
404 is a 200 the client would otherwise cache *as* a model.

**The avatar relies on the CSP being on this host, not on Cloudflare's default.** As of the
`2026-09-21` check, `hrt.kiramyao.com` returns **no** `Content-Security-Policy` header at
all — the block above is documented but not live. That was verified from a real browser:
a cross-origin image loads fine on the deployed site today (`lh3.googleusercontent.com`
answers 200 and the image paints), so the policy is not currently what blocks an avatar.
It will start blocking one the moment this block is deployed, which is why the proxy and
the `connect-src` entry above ship in the same change as the feature.

**What that means for the trade.** The plan is still to store the picture rather than
hotlink it, for the reason that survives either way: a hotlinked avatar is a request to
Google or X on every visit to the account page, which names the visitor to the provider
for no benefit. Storing plus re-serving also means the picture survives Google rotating
its CDN URL. So if anyone is tempted to "simplify" this back to hotlinking once the CSP is
live — don't; and if the CSP is never deployed, the arrangement costs nothing but the
proxy block above.

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
# The prefix is part of the API base URL the app calls, so it belongs in this value.
# `npm run build` refuses to finish without it, so a bare `vite build` cannot ship a
# signed-out app by accident — see the note below.
VITE_API_ORIGIN=https://api.kiramyao.com/hrt npm run build
# NOT `--delete`: the build does not contain public/ocr/ (that directory is generated
# by the asset script, and this build skips it), so deleting would take the live OCR
# models with it. Copy over the top instead.
sudo rsync -a dist/ /srv/hrt-web/

# Copying over the top means nothing is ever *removed*, so the service-worker files
# accumulate: every deploy leaves its `sw-<sha>.js` behind, and by 2026-09-23 the web
# root held 47 of them. They are tiny (188 KB total) and stale ones are harmless —
# a browser only fetches the one its `index.html` names — but the directory stops
# being readable at a glance. Prune to the current one after deploying:
cd /srv/hrt-web
KEEP=$(grep -o 'sw-[a-f0-9]*\.js' index.html | head -1)
for f in sw-*.js; do [ "$f" = "$KEEP" ] || rm -f "$f"; done

# Keep the BARE `/sw.js` alive, and refresh its contents rather than deleting it.
# Clients from before commit 01366ea registered that path; deleting the file does not
# retire them, it strands them — Caddy's `@static_assets` regex is `sw-[\w]+\.js`,
# which does not match `sw.js`, so the request falls through to the SPA and the client
# receives `index.html` where it expected a worker. A worker that cannot parse is a
# client stuck on its old build forever. Overwriting it with the current worker is what
# lets those clients update: the bytes change, the browser installs it, and every later
# deploy reaches them through the hashed name.
cp "$KEEP" sw.js
```

**Take a rollback copy of both halves before you replace them.** The web root is
cheap (`tar -czf /srv/backup/hrt-web-$(date -u +%Y%m%d-%H%M%S).tar.gz -C /srv/hrt-web .`)
and so is the server bundle, but only if you make it *first* — and the bundle is the
one that gets forgotten, because `/srv/hrt/dist/` already looks like it is full of
backups. It is: the convention is `index.cjs.bak-<label>-<timestamp>`, written before
the install that replaced it. Overwriting `index.cjs` without adding one leaves no
staged way back, and rebuilding an old commit is a slower path than a `cp`.

**The server bundle is CommonJS, and one flag in it is load-bearing.** `npm run build`
runs esbuild with `--format=cjs` and `--define:import.meta.url=__filename`, because
`src/db.ts` reads `import.meta.url` and a CJS output has no such thing. Drop the
`--define` and the bundle still builds without a word, then dies at startup inside
`path.isAbsolute(undefined)` with `ERR_INVALID_ARG_TYPE` and crash-loops the unit — so a
routine `systemctl restart` turns into a 502 that reads like a database or ownership
problem. `npm run build` therefore ends in `scripts/check-bundle.mjs`, which fails if
`dist/index.cjs` emits `import_meta` or has lost `var modulePath = __filename;`.

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

**The web build now checks its own output too**, mirroring the server's
`check-bundle.mjs`. `npm run build` ends in `scripts/check-web-bundle.mjs`, which fails
if `dist/assets/index-*.js` has no absolute `VITE_API_ORIGIN`. This is not belt-and-
braces: on 2026-09-22 three deploys went out built with a bare `npx vite build`, the
variable was left off each time, and the live app asked the web host for its own API —
so **the whole app behaved as signed out** while the site loaded perfectly. A missing
flag and a broken deployment are indistinguishable from the outside, which is exactly
why the build has to say so rather than the reader having to notice.

There is deliberately **no way to opt out**. An app and its API on one origin still call
`/hrt/auth/account`, and that `/hrt` lives *inside this value* — so omitting the variable
drops the prefix as well, and the app asks its own host for its API and receives the SPA
shell. That is the same outage arriving through the flag that was supposed to prevent it.

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

# 7. The Privacy Policy link resolves to a real document, and the home page still links
#    it. This is what a URL checker sees: the app subdomain has a shell that returns 200
#    for anything, so a 200 from it proves nothing — the policy is on kiramyao.com now.
curl -sI https://kiramyao.com/privacy | head -1                     # expect 200
curl -s https://hrt.kiramyao.com/ | grep -c "Kira HRT Tracker"      # >= 1
curl -s https://hrt.kiramyao.com/ | grep -c "kiramyao.com/privacy"  # >= 1, the link

# 8. One provider sign-in still ends in a session, not a dead URL: the callback hands
#    the browser a one-time code, and the exchange turns it into a session.
curl -s https://api.kiramyao.com/hrt/auth/google/start | head -c 120

# 9. The avatar route is proxied on the WEB host, not answered by the SPA shell.
#
#    This is the check the 2026-09-22 migration went without, and the one that fails
#    silently: `img-src 'self'` means the app can only load a picture from its own
#    origin, so `/auth/avatar/*` on `hrt.kiramyao.com` must reverse-proxy to the API.
#    Drop the block and every avatar disappears with nothing in any log — the request
#    is answered by `try_files … /index.html`, a 200 `text/html`, which is a valid
#    response to everything and therefore proves nothing on its own. The content type
#    is what distinguishes them: a working proxy answers `image/*` (or 404 JSON for an
#    unknown id), the broken one answers `text/html`.
#
#    Use a real uuid of an account that has a picture — the route only matches the
#    36-character form, so a made-up id 404s for a second reason.
curl -sI https://hrt.kiramyao.com/auth/avatar/<a-uuid-with-an-avatar> \
  | grep -iE 'HTTP/|content-type|content-location'
#  -> 200, image/*, and content-location naming /auth/avatar/<id>
#     `content-location` containing a literal `{…}` means the placeholder did not
#     resolve (pre-2.7 Caddy); the picture would load from the API host instead and be
#     blocked by `img-src 'self'`.

# 10. Turnstile is wired at BOTH ends, if the deployment asks for it.
#
#     Two independent settings have to agree, and each one failing looks like the
#     other from the browser: the sitekey's Hostname Management list in the Cloudflare
#     dashboard must contain this app's hostname, and `TURNSTILE_HOSTNAMES` in the
#     server `.env` must contain it too. If the dashboard omits it the widget renders
#     an empty box, issues no token, and the register button stays disabled forever
#     with no error shown — which is exactly "the button greys out and nothing
#     happens". The server half is invisible until a token is actually presented.
#
#     The sitekey is public and ships in the web build; only the secret lives here.
#     `/hrt/health` does not report Turnstile either way, so this one is on the
#     deployer: after moving hosts, open the dashboard and add the new hostname.
#     A registration with no token must be refused when it is on:
curl -s -o /dev/null -w '%{http_code}\n' https://api.kiramyao.com/hrt/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"smoketest2","password":"a-smoke-test-password"}'
#  -> 403 (Turnstile on and a token is required)   201 (Turnstile off — both ends must agree)
```

For step 8, the browser half needs a real Google account: sign in with Google, confirm
you land back in the app signed in, then `POST /hrt/auth/google/exchange` is what the
app calls with the `code` from the URL.

---

## 6. Operations

**Backups.** Two keys, not one. `ENCRYPTION_KEY` opens every record payload, and
`SERVER_DEK_KEY` unwraps every account's data key. A database restore without both is a
database full of ciphertext. Store both off the database host.

**Rotating either key is destructive.** `ENCRYPTION_KEY` has no re-wrap path: rotating
it makes every existing `payload_encrypted` unreadable. `SERVER_DEK_KEY` can be
rotated only by re-wrapping each account's DEK with the password in hand, so in
practice it is not rotatable either. Treat both as permanent.

**A lost password.** There is no recovery key, no self-service reset, and no admin
endpoint. What makes it survivable is the server wrapper: the deployment holds a copy of
every account's data key, so a forgotten password is a credentials problem rather than a
data problem. The route back runs through the provider legs rather than through a
break-glass endpoint:

1. **A linked provider.** Sign in with X or Google. `completeProviderSignIn` opens a real
   session from the server wrapper, and `POST /auth/credentials/bind` then sets a new
   account name and password. The records open throughout; nothing is re-encrypted.
2. **A password-only account.** The operator inserts an `oauth_accounts` row naming a
   provider identity the operator controls — `(user_id, provider, provider_user_id)` — then
   signs in through that provider's normal leg. The `login` purpose in
   `completeXCallback` / `completeGoogleCallback` looks the link up and does not check for
   a password, `completeProviderSignIn` opens a session from the server wrapper, and
   `POST /auth/credentials/bind` then sets a new password. That is a deliberate act with
   database access, and it is worth saying out loud what it implies: **anyone who can
   write to the database can add a provider link and take the account over.** That is the
   same property as the wrapper itself — the server holds a key that opens every account —
   not a separate weakness.
3. **What does not work.** Changing `users.password_hash` by hand leaves the account
   broken rather than recovered: the DEK is wrapped under a key derived from the password,
   so a new hash with an old wrapper opens nothing.

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

**Provider avatars.** The picture is copied from the provider once, at link/sign-in
time, into `oauth_accounts.avatar_image` (png/jpeg/webp, capped at 256 KiB, plus
`avatar_content_type` and `avatar_fetched_at`). `avatar_url` is kept alongside it as the
record of where the copy came from, and is never rendered. `GET /auth/avatar/:userId`
on this service re-serves the bytes; the web app's Caddy block proxies that route onto
`hrt.kiramyao.com` so the browser's `img-src 'self'` permits it — see §3.

The route is **unauthenticated by design**: an `<img src>` cannot carry an
`Authorization` header, and the id in the URL is an opaque uuid. The consequence is worth
stating plainly rather than discovering: anyone who knows a user's id can fetch that
user's picture. It is a picture the user chose to publish on X or Google, so the exposure
is small but not zero. Closing it means signing each image URL and rotating that
signature, which costs a request per rotation — do it if avatars ever need to be private.
Avatars are included in account deletion by the existing `ON DELETE CASCADE`; there is no
second store to clean up.

A failed fetch is never allowed to fail a sign-in: a 404, a timeout, an HTML error page
or a body over the cap all leave the account with no picture, which is the state it was
in before this feature existed. To audit what was actually captured:

```sql
SELECT provider, count(*) FILTER (WHERE avatar_image IS NOT NULL) AS with_picture,
       count(*) AS links
  FROM oauth_accounts GROUP BY provider;
-- A picture whose source URL is gone is a copy we can no longer refresh.
SELECT user_id, provider, avatar_url FROM oauth_accounts
 WHERE avatar_image IS NULL AND avatar_url IS NOT NULL;
```

**Retired tables and columns.** Five tables have been dropped and `schema.sql` carries
the `DROP`s: `medication_events` and `lab_results` (replaced by `records`, and read by
nothing since MCP moved onto it), `totp_backup_codes` plus the three `users.totp_*`
columns (no second factor), and `webauthn_credentials` / `webauthn_challenges` (no
passkeys). They applied on the deploy that removed their last reader, so there is
nothing left to do by hand — `scripts/check-table-ownership.sql` prints any that are
still present, and expects none. If you ever need to drop one by hand, a `DROP` on a
table `hrt` already owns needs no ownership fix, but run the probe afterwards anyway.

The same drop ran for **one column**, and it is worth checking separately because it
lived on `users` rather than in a table of its own: `users.privacy_mode` and its
`users_privacy_mode_check` constraint. The column chose between the two privacy modes,
and there is one arrangement now — every account carries the server wrapper. It is
dropped unconditionally, so an upgrade needs no step here. Confirm afterwards with

```sql
SELECT count(*) FROM users WHERE encryption_metadata -> 'wrappers' -> 'server' IS NULL;
-- 0 for every account created since registration started writing the wrapper.
-- A non-zero count is accounts that predate it: a password unlock adds the wrapper,
-- and until then such an account cannot be read through a durable `hrt_` token.
SELECT count(*) FROM information_schema.columns
 WHERE table_name = 'users' AND column_name = 'privacy_mode';
-- 0. Any other value means this migration did not run.
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
