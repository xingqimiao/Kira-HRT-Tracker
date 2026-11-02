# Post-release follow-ups — 2.5.0

Items found during the post-release observation window (2026-11-02) that are **not**
fixed yet. Nothing here has been applied to production.

## 1. The SPA shell has no cache policy (recommended next)

Measured: `GET /` and `GET /index.html` return `Last-Modified` and no `Cache-Control`,
no `ETag`; Cloudflare answers `cf-cache-status: DYNAMIC` (it does not cache them).
Browsers therefore apply heuristic freshness, and a shell that survives in a browser
cache still references chunk filenames that the newer release deleted. `assets/*`
requests for a deleted chunk are a correct 404 (the `@static_assets` branch), so the
failure mode is a blank app, not a wrong-API app.

Proposed change, shell paths only:

```caddy
@shell path / /index.html /share /share/* /auth/x/callback /auth/x/setup /auth/google/callback
header @shell Cache-Control "no-cache, must-revalidate"
header @shell Expires "0"
```

Scope and impact if applied:

- Affects only SPA-shell responses (navigations). Hashed assets, `/ocr/*`, `/android/*`,
  `/about/*` and the worker are untouched.
- Revalidation is cheap: the origin answers `304` to `If-Modified-Since` (verified).
- `no-cache` (not `no-store`) keeps back/forward-cache eligibility; offline first load
  is unaffected because the service worker precaches the shell.
- Blast radius of a mistake: one `handle` block in the `hrt.kiramyao.com` site, with
  `caddy validate` + reload and a one-line revert.

Deliberately **not** proposed now: `public, max-age=31536000, immutable` on `/assets/*`.
It would stop Cloudflare's 2 h default, but it makes a bad chunk unrevokable without a
purge, so it is a separate decision.

## 2. `ERR_HTTP_HEADERS_SENT` on client abort

One occurrence on the host at 07:37:14 UTC (test-account deletion, client hung up).
The central catch calls `fail()` after the response was already committed. Fix: guard
the error path with `res.headersSent` (destroy the socket / return) and add a test that
aborts mid-handler. Cosmetic until then — the request had already been served.

## 3. Old-client end-to-end compatibility

Not yet exercised as a real client matrix. Still to run, against the new server with
`RESTORE_ENABLED` unset and generation 0: 2.4.0 web and PWA (install + update path),
Android 2.3.x, MCP streaming, then the same set after a synthetic generation bump on an
isolated account (expect `409`, re-pull, adoption, no data loss).

## 4. No HTTP access log

The Caddyfile has no `log` directive, so only error-level lines reach the journal —
401/403/5xx rates cannot be measured or alerted on. A per-site JSON access log for
`api.kiramyao.com` (with rotation) would close this; it needs its own review for
retention, disk growth and query-string exposure.

## 5. Updater alerts are inert

`cloudflare-ips-update` calls `notify()`, which returns silently unless
`/etc/cloudflare-ips/webhook-url` exists. It does not exist on the host. The timer runs
clean (last run 2026-11-02 04:20:31 UTC, `no change: 22 ranges already current`, next
2026-11-03 04:36:20 UTC), but a removal or a fetch failure would only be visible in
`/var/log/cloudflare-ips/updates.log` and `last-result.json`. Provision the webhook or
add `OnFailure=` to the unit.

## 6. Deferred cleanups (owner's call, nothing deleted)

- `/srv/hrt/releases/2.5.0-rc1.052263b` and `/srv/hrt-web-releases/2.5.0-rc1.052263b`
  are superseded but harmless; `2.4.0` is the rollback target.
- `/tmp/hrt-server-2.5.0-rc1.052263b.tgz`, `/tmp/hrt-web-*.tgz` are the artifacts listed
  in `MANIFEST-2.5.0.md`; they live in `/tmp` and will not survive a reboot.
- Cloudflare may still hold rc1 chunks until their 2 h TTL expires; a purge is optional.
