# Self-hosting Kira HRT

[中文](README.md)

The complete Web/PWA application shares the main project's code: accounts, sync, sharing, MCP and on-device OCR. No Oracle, Firebase, Cloudflare or OAuth account is required by default. GPL and upstream attribution continue to apply.

## Start

Install Docker Engine/Desktop and Compose v2 with `up --wait` support. Use Linux containers (amd64 or arm64). Download `kira-hrt-self-host-VERSION.tar.gz` from a completed **self-host-vVERSION** release. A source checkout does not imply that its images have been published.

Extract the archive and open its directory. For a public domain, configure DNS and allow TCP ports 80/443. For a NAS, reserve a fixed LAN address and ensure those ports are free.

```sh
sh hrt.sh init https://hrt.example.com
sh hrt.sh start
sh hrt.sh check
```

On Windows use `./hrt.ps1 init https://hrt.example.com`, then `./hrt.ps1 start` and `./hrt.ps1 check`. Initialization creates `.env`, `secrets/master.key` and `Caddyfile` without overwriting an existing installation. Register through the website. Multiple accounts and existing rate limits remain enabled. Only Caddy publishes ports; API and PostgreSQL stay on an internal Docker network. URL subpaths and custom public ports are not supported in this initial package.

## LAN certificates and PWA

Use an address such as `https://192.168.1.20` or `https://hrt.local` during initialization. Fixed IPs, single-label names and `.local/.lan/.home/.internal/.test` names use Caddy's local CA. Ensure the name resolves from every client.

Run `sh hrt.sh cert` (Windows: `./hrt.ps1 cert`) after startup to export **only the public** `local-root.crt`. Transfer it through a trusted local channel. Install it as a trusted CA on each device: on iOS install the profile and enable full trust under About → Certificate Trust Settings; Android provides CA installation under system security settings. Windows uses Trusted Root Certification Authorities; macOS uses Keychain Access. Browsers with separate certificate stores may need a separate import.

Trust only your own verified CA. After HTTPS validates normally, install the PWA using the browser's installation or Add to Home Screen menu. Bypassing a certificate warning is insufficient. Public domains use automatic public certificates and need no CA import. Background notification support depends on the browser; supplementary FCM push is disabled.

## Operations and recovery

Replace `sh hrt.sh` with `./hrt.ps1` on Windows.

| Command | Result |
|---|---|
| `status`, `logs`, `check` | Inspect containers, follow logs, wait for healthy services |
| `stop`, `start` | Stop/start without deleting volumes |
| `backup` | Pause the API, dump PostgreSQL, back up configuration/key/CA, resume the API |
| `restore BACKUP_NAME` | Restore `backups/BACKUP_NAME` into an uninitialized directory and new volumes |
| `upgrade 2.2.2` | Pull a specific version, back up, upgrade, then require healthy services |

Backups contain separate `database.dump`, `master.key`, `config.env`, Caddy certificates/private keys, and a checksum manifest. They are **not additionally encrypted**. Keep them in restricted encrypted storage; keep independent key and database copies separately. Shell tooling restricts POSIX permissions; Windows users must restrict NTFS ACLs to their account and administrators.

To restore, extract a fresh deployment package and copy the entire backup directory under `backups/`. Do not initialize first. Run `restore NAME`. The tool verifies checksums, refuses existing configuration, creates a separate Compose project, and requires a database with no public tables. Keep the original address reachable. Restoring the CA retains LAN device trust. Accounts, sessions and MCP tokens retain their original lifecycle. If import fails, preserve the directory for diagnosis and retry in a different empty directory.

No `latest` upgrades or automatic PostgreSQL major upgrades. Failed upgrades exit nonzero and preserve backups. Incompatible database changes require restoring the previous backup into a new instance; reverting only the image is insufficient. Never use `docker compose down -v` unless intentionally deleting data and certificates.

## Security, migration and optional integrations

The explicit local provider uses a persistent random 32-byte key, AES-256-GCM and account/purpose binding to protect per-account key envelopes and pads. Records remain encrypted in PostgreSQL. This does **not** offer independent cloud HSM isolation or end-to-end encryption. A missing/invalid/mismatched master key prevents startup. Never regenerate the key of an existing installation.

This edition starts with a new database. Migrate from the official service through application export/import, then verify your records. Direct OCI database copies and in-place provider changes are unsupported.

OAuth, Turnstile, FCM and sponsor integrations are off. Advanced operators may use a separate Compose override; include it in every maintenance command and back it up separately. OAuth/FCM require API outbound connectivity without publishing its port. See the source repository's `server/.env.example`. Turnstile/FCM also require rebuilding the matching frontend/worker; default images omit them. Official-site builds must now set `VITE_TURNSTILE_SITE_KEY` explicitly. The official Android APK still uses the official server; self-hosting on phones uses Web/PWA. Attribution and external source links remain visible.

## Build and release

From `deploy/self-host/` in a full source checkout, initialize then run `sh hrt.sh build` and `start`. Building uses `compose.build.yaml` and requires no host Node installation. The deployment-only archive cannot build from source.

Maintainers run `node scripts/package-self-host.mjs` to produce a whitelist-only archive, using `package.json` for its version. A matching `self-host-vVERSION` tag triggers amd64/arm64 validation, GHCR publication and a release archive. Forks must set `IMAGE_PREFIX` in `.env` to their own registry namespace and make their GHCR packages public; the default is `ghcr.io/xingqimiao/kira-hrt`.

CI does not replace real-device validation: verify public HTTPS, phone CA trust/PWA installation, backup recovery and one version upgrade before declaring a release ready.
