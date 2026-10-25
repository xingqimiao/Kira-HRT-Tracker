# LAN / NAS deployment: fixed IP and local certificates

[Deployment index](README.en.md) · [Public server](SERVER.en.md) · [中文](LAN.md)

For a home NAS or Windows/macOS/Linux computer. This guide covers LAN access: Docker → fixed IP → download → install → trust on each device.

## Step 1: install Docker on the device that will run the website

Run every command **on the device that will store your data and run the service**. For a NAS, open its SSH terminal. For a home computer, use that computer’s terminal.

| Device | Preparation |
|---|---|
| Windows | Install and open [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), use Linux containers and wait for the engine to start |
| macOS | Install and open [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) and wait for the engine |
| Home Linux computer | Select your distribution in [Docker installation](https://docs.docker.com/engine/install/) and install Engine plus the Compose v2 plugin |
| Synology / QNAP / other NAS | Install Container Manager / Container Station / Docker, enable SSH; the device must support Linux amd64 or arm64 containers |

On Windows open PowerShell from the Start menu. On macOS open Terminal. On a NAS use its SSH terminal.

To connect from your computer, use SSH, for example `ssh kira@192.168.1.20`, replacing both the username and IP with your device's actual login and address. This is not a project-provided account. Password characters do not appear while typing. Once signed in, commands execute remotely. Enable SSH in the NAS control panel first. Then verify Docker:

```sh
docker info
docker compose version
```

The first command must show `Server` information; the second must report Compose v2 with `up --wait` support. **Both must work before you continue.** A client version alone does not prove that the engine is running.

For `permission denied`, configure your user's Docker access using the device documentation or [Docker's permission instructions](https://docs.docker.com/engine/install/linux-postinstall/). Use the same user throughout; do not alternate between normal and `sudo` commands. A missing `compose` command requires the Compose v2 plugin, not legacy `docker-compose` v1.


## Step 2: reserve a fixed LAN IP

In the router’s DHCP/address-reservation settings, find the Docker host and reserve its current IP, for example `192.168.1.20`. Replace this with your actual NAS/computer IP, not your phone’s IP.

The browser address is `https://192.168.1.20`. Clients need a reachable home network; guest Wi-Fi isolation can block access. No purchased domain, public DNS or router port forwarding is needed.

Host ports 80/443 must be free. Resolve NAS web-server/proxy/container conflicts first. Adding `:8443` or a URL subpath is unsupported. An existing LAN name such as `hrt.local` is optional, but you must make it resolve on all clients yourself.

## Step 3: download, extract and enter the script directory

This guide uses the **2.3.2 archive**. Existing installations need no reinitialization; use the [maintenance guide](MAINTENANCE.en.md) to upgrade.

**[Download kira-hrt-self-host-2.3.2.tar.gz](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.3.2/kira-hrt-self-host-2.3.2.tar.gz)**

Alternatively open the [self-hosted Release](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/tag/self-host-v2.3.2), expand Assets and select that file. Do not select an APK, Source code or a Packages image. A `.sha256` file contains optional checksum information, not the installer.

### Windows

Save the file to Downloads, open PowerShell and run these lines one at a time:

```powershell
cd "$HOME\Downloads"
tar -xzf .\kira-hrt-self-host-2.3.2.tar.gz
cd .\kira-hrt-self-host-2.3.2
Get-ChildItem
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

You should see `hrt.ps1`, `hrt.sh`, `compose.yaml`, `manage.mjs` and `VERSION`. The last line permits scripts in **this PowerShell process only**, without changing global policy. Read and confirm any prompt. If organizational policy prohibits scripts, contact the device administrator.

### Linux / macOS / NAS

First enter a writable directory that you will keep. A NAS Docker shared folder is suitable; **do not use a temporary directory erased on reboot**. Run:

```sh
curl -fL --retry 3 -o kira-hrt-self-host-2.3.2.tar.gz https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.3.2/kira-hrt-self-host-2.3.2.tar.gz
tar -xzf kira-hrt-self-host-2.3.2.tar.gz
cd kira-hrt-self-host-2.3.2
ls
```

You should see `hrt.sh`, `compose.yaml`, `manage.mjs` and `VERSION`. If the NAS lacks curl, download on your computer, upload/extract through the NAS file manager, then `cd` into the directory containing `hrt.sh` over SSH.

**If that directory already exists, stop and check whether it is a previous installation. Do not extract over, reinstall or delete an existing instance.**

## Step 4: install

Assuming your actual fixed IP is 192.168.1.20, choose one command in the extracted script directory.

Linux / macOS / NAS:

```sh
sh hrt.sh install https://192.168.1.20
```

Windows PowerShell:

```powershell
./hrt.ps1 install https://192.168.1.20
```

The script generates configuration/keys, pulls images, creates the database and waits for three healthy services. The first download may take minutes. Pulling/Downloading/Starting are normal; do not repeat install.

Expect `[1/3]`, `[2/3]`, `[3/3]`, then `Services are running. Open https://192.168.1.20`, and a `local-root.crt` file. Continue to step 5 instead of bypassing browser warnings.

For existing configuration, keep the key and run `sh hrt.sh start` (Windows: `./hrt.ps1 start`), then `cert`. New installations use the current archive; existing instances must never be reinitialized.

## Step 5: trust the LAN certificate, then open the website

Each LAN client must trust your own root certificate once. Clicking through an unsafe-site warning does not replace trust installation.

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

## If something fails

For phone connection failures check Wi-Fi, address and guest isolation. For trust errors repeat step 5, including iOS full trust. For Docker, download, port or health errors see [troubleshooting and maintenance](MAINTENANCE.en.md).

After success, create your first backup using [maintenance](MAINTENANCE.en.md). Migrate official-service data with export/import.
