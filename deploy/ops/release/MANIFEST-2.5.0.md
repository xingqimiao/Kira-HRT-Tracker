# Release manifest — 2.5.0-rc1 / 2.5.0-rc2

Released and observed on 2026-11-02. Both candidates come from one source commit;
the only difference between them is a web build-time variable.

| Field | Value |
| --- | --- |
| Branch | `rewrite` |
| Source commit | `052263be894d061030fd4a070fca18981b459275` (`052263b`) |
| Commit time | 2026-11-02 14:34:12 +0800 |
| Release host | `ubuntu@161.33.157.62` |

## Build environment

| Tool | Version |
| --- | --- |
| Node | v24.22.1 (`/opt/node-v24.22.1-linux-arm64/bin/node` on the host) |
| npm | 12.0.2 |
| Vite | 8.3.5 |
| React | 19.3.1 |
| esbuild (server bundle) | 0.28.2 |
| Web build env | `VITE_API_ORIGIN=https://api.kiramyao.com/hrt` for rc2; **unset** for rc1 |
| Runtime target | linux/arm64, Node 24 |

## Artifacts

| Release | Role | Tarball on host | Tarball SHA-256 | Contents SHA-256 | Live window (UTC) |
| --- | --- | --- | --- | --- | --- |
| `2.5.0-rc1.052263b` | server | `/tmp/hrt-server-2.5.0-rc1.052263b.tgz` | `f064b30f2bcdcc596236c1d9632f2a3dac5433801746802a05f7c4ad5c6cf328` | `dist/index.cjs` `14246eedb180979e09dfa40eabd75846861ade0daea7b8d4f18d2684b1e0bb16` | 06:56 → auto-rolled back (health race) |
| `2.5.0-rc2.052263b` | server | `/tmp/hrt-server-2.5.0-rc1.052263b.tgz` (same file) | as above | `14246eed…` | 06:58 → current |
| `2.5.0-rc1.052263b` | web | `/tmp/hrt-web-2.5.0-rc1.052263b.tgz` | `a0c2909a005e1102e24c7f51e28c03b80af29e7f4ad2f0e19b17456e51522ff6` | `index.html` `18af0ecd854e9c204f5d9635741c24a0260ac03df68c7477106e2eec581f0652` | 06:55 → rolled back (login 404, wrong API origin) |
| `2.5.0-rc2.052263b` | web | `/tmp/hrt-web-2.5.0-rc2.052263b.tgz` | `f0cea5d7390a7ac7f14d564bb53244342191038fa3b19872e5e542640ddde520` | `index.html` `f57ed2b908750aefd6e8a40ebf1382d91af521047b492a237371ce0be06b9c5b`; `sw.js` `566af5b62e2c1ebaaf48fcb7f9bd48850771abfa8ac7aadff19a82b4d18942f9` | 07:22 → current |

Retained predecessor (still on disk, not live): server `2.4.0` `dist/index.cjs`
`d662a6153bd04e589945a848cfd8801d546deeee55a4db155969154be78c058c`; web `2.4.0`
`index.html` `2b7639d5a9ebd1a738c6bf88ca3cbbf78042a44f2fa152733661ff6ac836e9ec`.

Live layout: `/srv/hrt/current` → `releases/2.5.0-rc2.052263b`;
`/srv/hrt-web` → `/srv/hrt-web-releases/2.5.0-rc2.052263b`. Both rc1 directories stay
on disk (a rollback to a same-commit server build is harmless; see the gate note).

## Version difference rc1 → rc2

- Source: identical (`052263b`). Server artifact: byte-identical between the two
  directories, so rc1's failure was the release script, not the build
  (`wait_health` was added afterwards).
- Web: rebuilt with `VITE_API_ORIGIN` set. 15 files differ — `index.html`, `sw.js`,
  and 13 chunks (the changed entry cascades into every chunk that imports it).
- Proof of the rc1 defect: the rc1 entry chunk contains no `api.kiramyao.com` string
  at all, so its `fetch` calls went to `https://hrt.kiramyao.com/...` and hit the SPA
  shell. The rc2 entry chunk contains `https://api.kiramyao.com/hrt` three times.

## Change set since the previous live build (2.4.0)

```
bd0e4c7 feat(server): restore generation protocol for whole-account replacement
02ced53 feat(server): put whole-account restore behind an explicit opt-in
7f9692c feat(web): merge by default, or replace the cloud, on import
82f8e10 feat(web): hide replace-cloud unless the server accepts it
c5d4c4c fix(server): bound the migration's lock wait
5597606 fix(server): make the trusted client IP source explicit
6cda174 fix(import): bound decompressed backup size
f82341b fix(share): renew an expired live viewer pass instead of freezing
5bd1a8e feat(web): show package measurements for gel products
5585061 ops: add the Cloudflare IP allowlist refresher
3065b46 ops: make the updater's rollback-failure path testable
052263b ops: versioned release switches for the API and the web build
ffe946a fix(ops): wait for the listener and read the epoch before it exists
```

## Deployment state at hand-over

- `RESTORE_ENABLED` unset on the host; `POST /api/restore` is refused (403 for an
  authenticated caller, 401 unauthenticated) and the web build does not offer the
  overwrite action.
- `users.restore_generation` exists, max = 0, no account has been restored.
- Database: 97 users, 7176 records, 40 live sessions, 0 records with a NULL payload.
- Ops tooling on the host: `/opt/hrt-ops/release/release-hrt.sh`
  (`ddd8ba9b3d5b531308f079f9085d84c47cfb444b3474f2cb4d708b375ff8608b`, from
  `deploy/ops/release/release-hrt.sh` at `ffe946a`), reachable as
  `/usr/local/sbin/release-hrt`; metadata in `VERSION` and `release-hrt.sh.sha256`.
  `/usr/local/sbin/cloudflare-ips-update`
  (`9a6c037bac0f989c2dc3ba9b85a8d434d6e48199154f31a1bdd01fd3c9a2949d`).
- Backups: `/srv/hrt-backup-bootstrap-20261102T065338Z`,
  `/srv/hrt-backup-postgres-20261102T061726Z` (dump SHA-256
  `b38fe9f934c7103495dac6285b9e481797afdfe915842c2fcd27ad34f0afe1af`), plus the
  Caddy/IP backups under `/srv/hrt-backup-caddy/`.

## Rollback rules in force

`release-hrt server rollback <version>` checks the target for the generation gate.
A target without the gate is refused while any account has `restore_generation > 0`;
an unreadable generation refuses as well. Server `2.4.0` is therefore allowed today
(generation 0) and would be refused after the first real restore. Verified with the
installed copy: five cases (pre-gate @1 refuse, pre-gate @0 allow, unreadable refuse,
gated @5 allow, missing target refuse) all behaved as specified.
