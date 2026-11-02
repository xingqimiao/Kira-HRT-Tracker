# Post-release follow-ups — 2.5.0

Items found during the post-release observation window (2026-11-02). Updated after
the two approved low-risk operations.

## 1. SPA shell cache policy — done (2026-11-02 08:41 UTC)

Applied to the `hrt.kiramyao.com` site only: `@spa_routes` now also matches
`/index.html`, and the branch sets `Cache-Control: no-cache, must-revalidate` +
`Expires: 0` before `rewrite`/`file_server`. Proven in the adapted config that the
header handler sorts ahead of the rewrite and the file server in the same branch.
Cloudflare passes those values through unchanged (`cf-cache-status: DYNAMIC`), so
its Browser Cache TTL does not override them. Assets, the worker, `/ocr/*`,
`/android/*` and `/about/*` keep their previous policy; `/index.html` revalidates
with a 304. Backup: `/srv/hrt-backup-caddy/20261102T084152Z/Caddyfile`.

Still open, separate decision: `public, max-age=31536000, immutable` on `/assets/*`
would stop Cloudflare's 2 h default, but makes a bad chunk unrevokable without a
purge.

## 2. `ERR_HTTP_HEADERS_SENT` on client abort

One occurrence at 07:37:14 UTC (test-account deletion, client hung up). The central
catch calls `fail()` after the response was already committed. Fix: guard the error
path with `res.headersSent` (destroy the socket / return) and add a test that aborts
mid-handler. Cosmetic until then — the request had already been served.

## 3. Old-client end-to-end compatibility

Not yet exercised as a real client matrix. Still to run, against the new server with
`RESTORE_ENABLED` unset and generation 0: 2.4.0 web and PWA (install + update path),
Android 2.3.x, MCP streaming, then the same set after a synthetic generation bump on
an isolated account (expect `409`, re-pull, adoption, no data loss).

## 4. API status and latency observability — designed, not implemented

See `deploy/ops/observability/README.md`. The Caddyfile still has no `log`
directive, so 401/403/429/5xx rates remain unmeasurable until that plan is applied.

## 5. Updater alerts — connected (2026-11-02)

Telegram bot `@NuclearSharkBot`, credentials in `/etc/cloudflare-ips/telegram-token`
and `telegram-chat-id` (0600, root). Delivery verified end to end (`ok:true`).
Events: removal held for review, reminders at half the grace window and one day
before expiry, "about to apply", "applied", and every failure path including a
failed rollback. `OnFailure=` is a supplement only, and `SuccessExitStatus=2 3`
keeps a normal "held for review" from being reported as a crash.

Remaining operational dependency: the bot must stay reachable and the chat must not
block it. If the token is revoked, the helper logs `NOT SENT` and the update logic
still runs — alerts go quiet rather than the updater breaking.

## 6. Deferred cleanups (owner's call, nothing deleted)

- `/srv/hrt/releases/2.5.0-rc1.052263b` and `/srv/hrt-web-releases/2.5.0-rc1.052263b`
  are superseded but harmless; `2.4.0` is the rollback target.
- `/tmp/hrt-server-2.5.0-rc1.052263b.tgz`, `/tmp/hrt-web-*.tgz` are the artifacts listed
  in `MANIFEST-2.5.0.md`; they live in `/tmp` and will not survive a reboot.
- Cloudflare may still hold rc1 chunks until their 2 h TTL expires; a purge is optional.

## 7. `hrt-server` hardening drop-in — two ignored lines fixed (2026-11-02 09:02 UTC)

`systemd-analyze verify` reported two problems in
`/etc/systemd/system/hrt-server.service.d/hardening.conf`:

- `ProtectKernelImage` is not a systemd property. It was removed and replaced by a
  comment pointing at `ProtectKernelModules`/`ProtectKernelTunables`/`ProtectKernelLogs`,
  which already cover the intent.
- `MemoryDenyWriteExecute=false  # V8 JIT …` failed to parse because systemd has no
  inline comments, so the whole assignment was ignored (the base unit sets the same
  value, so the effective value never differed). The note moved to its own lines and
  the assignment is now explicit.

Proof: a 32-property snapshot taken before and after `daemon-reload` is byte-identical,
`systemd-analyze verify` no longer mentions the drop-in, and the service kept the same
PID with `NRestarts=0` — no restart was needed or performed. Backup:
`/srv/hrt-backup-systemd-20261102T090237Z/hardening.conf`.


## 8. The web origin is reachable directly

`https://hrt.kiramyao.com` answers on `161.33.157.62:443` without going through
Cloudflare; only the api site carries the `remote_ip` gate. That was the agreed scope
of the origin-protection change, and this release did not alter it. It means the site
itself has no WAF in front of it, only the API does.
