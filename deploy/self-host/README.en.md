# Self-host Kira HRT: from download to your first record

[中文](README.md) · [Project](https://github.com/xingqimiao/Kira-HRT-Tracker)

This guide assumes no Docker experience. You will run your own Web/PWA service with accounts, sync, sharing, MCP and offline lab-report recognition. **No Oracle, Firebase, Cloudflare or third-party sign-in account, host Node installation, compilation or hand-written database password is required.**

Prepare a Docker-capable device, choose an address, download the deployment archive and run the installation command. LAN access also requires trusting your certificate once on each client device.

## Why are there two GitHub packages?

They are Docker images: ready-made programs for Docker. **You do not choose between them or download them manually.**

| Package | Purpose | Your action |
|---|---|---|
| [`kira-hrt-web`](https://github.com/users/xingqimiao/packages/container/package/kira-hrt-web) | Website and Caddy HTTPS entry point | Downloaded automatically |
| [`kira-hrt-api`](https://github.com/users/xingqimiao/packages/container/package/kira-hrt-api) | Accounts, sync, sharing and MCP backend | Downloaded automatically |
| PostgreSQL | Database, from the official PostgreSQL image | Also downloaded automatically |

Docker selects amd64 or arm64 automatically. **Download the deployment archive in step 3**, which contains the instructions Docker uses to run these programs together.

## Step 1: install Docker on the device that will run the website

Run every command **on the device that will store your data and run the service**. For a NAS, open its SSH terminal. For a cloud server, SSH into the server first. Commands run on your laptop will not install anything on a remote server.

| Device | Preparation |
|---|---|
| Windows | Install and open [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), use Linux containers and wait for the engine to start |
| macOS | Install and open [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) and wait for the engine |
| Ubuntu server | Follow [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/) for Engine and the Compose plugin; use the matching official instructions for other distributions |
| Synology / QNAP / other NAS | Install Container Manager / Container Station / Docker, enable SSH; the device must support Linux amd64 or arm64 containers |

On Windows open PowerShell from the Start menu. On macOS open Terminal. On a NAS/server use its SSH terminal.

To connect from your computer, use SSH, for example `ssh kira@192.168.1.20`, replacing both the username and IP with your device's actual login and address. This is not a project-provided account. Password characters do not appear while typing. Once signed in, commands execute remotely. Enable SSH in the NAS control panel first, or use your cloud provider's server console. Then verify Docker:

```sh
docker info
docker compose version
```

The first command must show `Server` information; the second must report Compose v2 with `up --wait` support. **Both must work before you continue.** A client version alone does not prove that the engine is running.

For `permission denied`, configure your user's Docker access using the device documentation or [Docker's permission instructions](https://docs.docker.com/engine/install/linux-postinstall/). Use the same user throughout; do not alternate between normal and `sudo` commands. A missing `compose` command requires the Compose v2 plugin, not legacy `docker-compose` v1.

## Step 2: choose the address you will open in a browser

Choose before installing. **Replace examples with your actual address.**

| Scenario | Example | Required preparation |
|---|---|---|
| Home NAS / computer, local access | `https://192.168.1.20` | Reserve a fixed IP for the Docker device in your router; use its actual IP |
| An existing LAN domain | `https://hrt.local` | Make the name resolve to the server on all client devices; the script does not create DNS records |
| A public domain | `https://hrt.example.com` | Use your own domain, point its DNS A record at the public server and allow TCP 80/443 in firewalls/security groups |

For a first home installation, a fixed LAN IP avoids DNS setup. Phones must be on a reachable local network or your separately configured VPN. A private IP does not become publicly reachable automatically.

This package occupies **ports 80 and 443**. Resolve conflicts with NAS web servers or other proxies before installing, or have an experienced operator customize the deployment. Adding `:8443` to the address is unsupported, as are URL subpaths such as `/hrt`. For a public installation, make the domain reach Caddy directly first, before adding an outer proxy/CDN.

## Step 3: download, extract and enter the script directory

This guide uses **2.2.2 setup revision setup.1**. Application images remain pinned to 2.2.2; the suffix only identifies updated scripts and documentation. Existing installations do not need reinitialization.

**[Download kira-hrt-self-host-2.2.2-setup.1.tar.gz](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.2.2/kira-hrt-self-host-2.2.2-setup.1.tar.gz)**

Alternatively open the [self-hosted Release](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/tag/self-host-v2.2.2), expand Assets and select that file. Do not select an APK, Source code or a Packages image. A `.sha256` file contains optional checksum information, not the installer.

### Windows

Save the file to Downloads, open PowerShell and run these lines one at a time:

```powershell
cd "$HOME\Downloads"
tar -xzf .\kira-hrt-self-host-2.2.2-setup.1.tar.gz
cd .\kira-hrt-self-host-2.2.2
Get-ChildItem
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

You should see `hrt.ps1`, `hrt.sh`, `compose.yaml`, `manage.mjs` and `VERSION`. The last line permits scripts in **this PowerShell process only**, without changing global policy. Read and confirm any prompt. If organizational policy prohibits scripts, contact the device administrator.

### Linux / macOS / NAS

First enter a writable directory that you will keep. A NAS Docker shared folder is suitable; **do not use a temporary directory erased on reboot**. Run:

```sh
curl -fL --retry 3 -o kira-hrt-self-host-2.2.2-setup.1.tar.gz https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.2.2/kira-hrt-self-host-2.2.2-setup.1.tar.gz
tar -xzf kira-hrt-self-host-2.2.2-setup.1.tar.gz
cd kira-hrt-self-host-2.2.2
ls
```

You should see `hrt.sh`, `compose.yaml`, `manage.mjs` and `VERSION`. If the NAS lacks curl, download on your computer, upload/extract through the NAS file manager, then `cd` into the directory containing `hrt.sh` over SSH.

**If that directory already exists, stop and check whether it is a previous installation. Do not extract over, reinstall or delete an existing instance.**

## Step 4: run one installation command

Choose **one** command, replacing the example with the real address chosen in step 2:

| Scenario | Linux / macOS / NAS | Windows PowerShell |
|---|---|---|
| Home / NAS | `sh hrt.sh install https://192.168.1.20` | `./hrt.ps1 install https://192.168.1.20` |
| Public server | `sh hrt.sh install https://hrt.example.com` | `./hrt.ps1 install https://hrt.example.com` |

The command creates a random password and master key, downloads images, creates the database, starts three services and waits for health checks. The first download may take several minutes. `Pulling`, `Downloading` and `Starting` are normal progress; **do not repeatedly run install**.

On normal completion you will see:

```text
[1/3] Creating configuration and encryption key...
[2/3] Downloading images and starting services ...
[3/3] Preparing your access instructions...
Services are running. Open https://YOUR-ADDRESS
```

LAN installs also create `local-root.crt`: continue to step 5. For public HTTPS, open the address; certificate issuance may still be in progress, so retry shortly. **Healthy containers do not prove public HTTPS issuance; confirm the certificate in your browser.**

The original `kira-hrt-self-host-2.2.2.tar.gz` does not contain `install`. Use setup.1, or run `sh hrt.sh init YOUR-ADDRESS`, then `sh hrt.sh start`, then `sh hrt.sh cert` for LAN access in an uninitialized old-package directory. Replace `sh hrt.sh` with `./hrt.ps1` on Windows. If configuration already exists, use `start`, not `init`.

## Step 5: trust the LAN certificate, then open the website

**Skip certificate installation if public HTTPS already works.** Each LAN client must trust your own root certificate once. Clicking through an unsafe-site warning does not replace trust installation.

Find `local-root.crt` in the deployment directory. For a NAS, copy it through the NAS file manager. Transfer only this public certificate through a trusted channel; **do not transfer `secrets/master.key` or the entire Caddy volume**.

| Client device | Trust steps |
|---|---|
| Windows | Double-click certificate → Install Certificate → Current User → Place all certificates in the following store → Browse → **Trusted Root Certification Authorities** → Finish; reopen browser |
| macOS | Import using Keychain Access → open certificate → Trust → Always Trust; reopen browser |
| iPhone / iPad | Open certificate in Files → Settings → General → VPN & Device Management → install profile; then General → About → **Certificate Trust Settings**, enable full trust for this root |
| Android | Search Settings for CA certificate / Install certificate → install a CA certificate → select `local-root.crt`; reopen browser. Vendor menus differ |
| Firefox / Linux desktop | If trust is still missing, import under browser Settings → Privacy & Security → Certificates → View Certificates → Authorities, allowing website identification; labels vary |

Trust only the certificate generated by your own deployment. Open **the same HTTPS address used during installation**, without changing the domain or switching to HTTP. There must be no certificate error.

Click Register to create your own account. Official-service accounts are not automatically present. Multiple registrations and existing registration/login rate limits remain enabled.

To install as an app: use Install app / Add to Home screen in Android or desktop Chrome/Edge; on iPhone/iPad use Safari → Share → Add to Home Screen. **The official Android APK still connects to the official service; use this PWA for self-hosting.**

## What counts as success?

1. The installation command finishes without an error.
2. Your chosen HTTPS address opens with no certificate error.
3. Registration/login works, and a record remains after refreshing.
4. If you need phone access, the same address works there; install the PWA afterwards if desired.

`sh hrt.sh status` (Windows: `./hrt.ps1 status`) should show web, api and db running and healthy. No public API/database ports is intentional; do not open 8788 or 5432.

## Troubleshooting: match the symptom to the next action

| Symptom | Action |
|---|---|
| docker command not found | Return to step 1, install Docker and reopen the terminal |
| Cannot connect to the Docker daemon | Open Docker Desktop or start the server's Docker service, then retry `docker info` |
| permission denied / Docker socket unavailable | Fix the current user's Docker permissions; do not delete configuration |
| hrt.sh / hrt.ps1 not found | Use `ls` / `Get-ChildItem`, then enter the directory containing the script |
| PowerShell prohibits scripts | Apply step 3's process-scoped policy in the same window |

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
| Certificate untrusted | Repeat step 5, including iOS full trust |
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
| Export public certificate again | `sh hrt.sh cert` | `./hrt.ps1 cert` |
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

Maintainers: `node scripts/package-self-host.mjs` builds the standard archive; `node scripts/package-self-host.mjs setup.1` builds this script revision. The application version comes from package.json; revision suffixes do not change image versions. Matching `self-host-vVERSION` tags trigger dual-architecture releases. Forks must publish public images and configure IMAGE_PREFIX. See the [verification record](https://github.com/xingqimiao/Kira-HRT-Tracker/blob/rewrite/deploy/self-host/VERIFICATION.md) for actual public ACME and phone certificate/PWA acceptance scope.
