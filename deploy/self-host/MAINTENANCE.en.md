# Self-hosting maintenance

[Deployment index](README.en.md) · [Public server](SERVER.en.md) · [LAN / NAS](LAN.en.md) · [中文](MAINTENANCE.md)

## Troubleshooting: match the symptom to the next action

| Symptom | Action |
|---|---|
| docker command not found | Install Docker using your [server](SERVER.en.md) or [LAN](LAN.en.md) guide, then reopen the terminal |
| Cannot connect to the Docker daemon | Open Docker Desktop or start the server's Docker service, then retry `docker info` |
| permission denied / Docker socket unavailable | Fix the current user's Docker permissions; do not delete configuration |
| hrt.sh / hrt.ps1 not found | Use `ls` / `Get-ChildItem`, then enter the directory containing the script |
| PowerShell prohibits scripts | Apply the [LAN guide](LAN.en.md) step 3 process-scoped policy in the same window |

| Installation symptom | Action |
|---|---|
| Already initialized / refusing to overwrite | Configuration exists. **Keep the key**; run `start`, then `cert` for LAN |
| port already allocated / address already in use | Resolve conflicts on 80/443 with NAS web services, proxies or containers |
| denied / unauthorized / manifest unknown while pulling | Official images are public, no GitHub login needed. Check connectivity and the version/image prefix in `.env`; use published versions, not `latest` |
| Timeout / connection reset / TLS errors | Check this device's access to GitHub, GHCR and Docker Hub and its Docker proxy configuration; retry `start` after fixing connectivity, without disabling TLS |
| Startup timeout / unhealthy | Run `status` and `logs` below to identify the failing service; do not delete volumes or regenerate the key |

For `unknown flag: --wait`, update Docker/Compose v2, then run `start` without reinitializing.

| Browser symptom | Action |
|---|---|
| Public site unavailable / certificate issuance fails | Check DNS, 80/443, security groups and web logs. If AAAA exists, IPv6 must also reach this server |
| NAS works, phone cannot connect | Check home Wi-Fi, address and network reachability/guest isolation, then certificate trust |
| LAN certificate untrusted | Repeat [LAN guide](LAN.en.md) step 5, including iOS full trust; use the [public-server guide](SERVER.en.md) for public HTTPS errors |
| No Install app menu | Verify trusted HTTPS and browser PWA support; the website can be used directly. Background reminders vary by browser |
| Accounts/data differ from the official site | Expected. Export in the original app, import into this instance and inspect records. Do not copy an OCI database and switch key providers |

Run from the deployment directory; Windows substitutes `./hrt.ps1` for `sh hrt.sh`:

```sh
sh hrt.sh status
sh hrt.sh logs
```

**Ctrl+C exits the log viewer without stopping the service.** Include status, errors and relevant logs when asking for help, after removing tokens, passwords, keys and personal data.

## After installation: keep using the original deployment directory

The website goes offline when the host sleeps/shuts down or Docker stops. Containers have an automatic restart policy when the host and Docker are running again. Do not run install in a different directory.

| Purpose | Linux / macOS / NAS | Windows PowerShell |
|---|---|---|
| Status / health | `sh hrt.sh status` / `sh hrt.sh check` | `./hrt.ps1 status` / `./hrt.ps1 check` |
| Stop / start | `sh hrt.sh stop` / `sh hrt.sh start` | `./hrt.ps1 stop` / `./hrt.ps1 start` |
| Export root certificate again (LAN only) | `sh hrt.sh cert` | `./hrt.ps1 cert` |
| Backup | `sh hrt.sh backup` | `./hrt.ps1 backup` |

### Back up after first saving important data

`backup` briefly stops web/API, takes a consistent snapshot and resumes them. Wait for completion. The output names `backups/NAME`, containing `database.dump`, `master.key`, `config.env`, `Caddyfile`, `caddy/` and `manifest.json`.

Keep the **whole set**, including the CA. Backup files have no additional encryption: store securely in encrypted storage, keep key copies separate from database copies and reunite the complete set for recovery. Linux tooling restricts permissions. On Windows restrict directory NTFS permissions to your user and administrators. A database dump without the master key cannot be recovered.

### Upgrade only to an explicitly published version

If a future 2.2.3 release is published, use `sh hrt.sh upgrade 2.2.3` or `./hrt.ps1 upgrade 2.2.3`. **This illustrates syntax, not an assertion that 2.2.3 exists.** The command pulls images, backs up current data, updates the version and waits for health checks. Only success prints `Upgrade healthy`.

No `latest` tracking or automatic PostgreSQL major upgrades. Preserve logs/backups on failure. Incompatible database changes require recovery from the pre-upgrade backup; changing back only the image is not guaranteed to work.

### Restore only into a new empty deployment directory

1. Keep the old instance and backup. Extract a version-matched deployment package into another empty directory. **Do not run install or init.**
2. Create `backups` there and copy in the complete set, giving paths such as `backups/YOUR-NAME/database.dump`.
3. In the new directory run `sh hrt.sh restore YOUR-NAME`, or `./hrt.ps1 restore YOUR-NAME`. Supply the directory name, not a full path.
4. The tool checks files, paired keys and an empty target database. The original address remains in use; keep it reachable and avoid port conflicts with the old instance.
5. Verify old accounts, records and unexpired tokens. LAN CA trust is retained. On failure keep the directory for diagnosis and retry in a different empty directory, without clearing an existing database.

**Do not use `docker compose down -v` as a repair command: `-v` deletes database and certificate volumes. Do not edit, delete or regenerate an existing `secrets/master.key`.**

## Optional: customization and source builds

Normal users do not need these steps. Source builds require the complete repository, not the deployment archive. In its `deploy/self-host/` directory run `sh hrt.sh init YOUR-ADDRESS`, then `sh hrt.sh build`, then `sh hrt.sh start`; Windows uses the same subcommands with `./hrt.ps1`. Do not run install first, which uses published images. Compilation happens in containers, without host Node.

OAuth, Turnstile, FCM, sponsor integrations and official-site updates are disabled by default. See [server/.env.example](https://github.com/xingqimiao/Kira-HRT-Tracker/blob/rewrite/server/.env.example) for advanced configuration; CAPTCHA/push also require a matching frontend/worker build. Scripts explicitly load `compose.yaml` and **do not automatically load compose.override.yaml**. Custom operators must consistently change all maintenance command file lists, back up overrides and test recovery. OAuth/FCM require API egress without publishing API/database ports.

The local provider uses a random 32-byte master key and AES-256-GCM to wrap account keys and pads, binding account and purpose. The database stores ciphertext, but the key file shares the server's administrative boundary: **no OCI HSM isolation and no end-to-end encryption claim**. Missing/mismatched keys stop API startup. Server administrators with the key remain inside the trust boundary.

GPL and attribution remain. Default operation does not require official-site APIs, CAPTCHA or Firebase; deliberately opening source/attribution links visits those external sites.

Maintainers: `node scripts/package-self-host.mjs` builds the standard archive; `node scripts/package-self-host.mjs setup.2` builds this script revision. The application version comes from package.json; revision suffixes do not change image versions. Matching `self-host-vVERSION` tags trigger dual-architecture releases. Forks must publish public images and configure IMAGE_PREFIX. See the [verification record](https://github.com/xingqimiao/Kira-HRT-Tracker/blob/rewrite/deploy/self-host/VERIFICATION.md) for actual public ACME and phone certificate/PWA acceptance scope.
