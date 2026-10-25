# Public-server deployment: domain and automatic HTTPS

[Deployment index](README.en.md) · [LAN / NAS](LAN.en.md) · [中文](SERVER.md)

For an internet-facing Linux server and a domain you control. This guide uses Ubuntu; amd64 and arm64 are supported. Complete five steps: domain → SSH → Docker → download/install → open and verify.

**Public HTTPS uses automatically issued trusted certificates. Do not import a local root certificate.** Accounts, sync, sharing, MCP and offline recognition remain available, without Oracle/Firebase/OAuth accounts.

## Step 1: prepare DNS and ports

Examples below use `https://hrt.example.com` and server IP `203.0.113.10`. **Replace both with your actual domain/IP.**

| Where | Action | Expected result |
|---|---|---|
| Domain DNS settings | Add an A record for `hrt` pointing to the server’s public IPv4 | The domain resolves to this server |
| Cloud security group / firewall | Allow inbound TCP 80 and 443 | Browsers and certificate issuance can reach Caddy |
| Existing server websites/containers | Free ports 80 and 443 | Both ports available to this package |

Any AAAA record must also route correctly to this server over IPv6. Remove incorrect AAAA records when IPv6 is unavailable. Start with direct DNS rather than an outer proxy/CDN, then consider customization after the site works.

Custom entry ports such as `:8443` and URL subpaths are unsupported. Do not expose API port 8788 or database port 5432.

## Step 2: connect to the server

Open PowerShell on Windows or Terminal on macOS/Linux. On your computer run:

```sh
ssh ubuntu@203.0.113.10
```

Replace the username and IP with those supplied by your provider. Use its password/key login instructions; password characters do not appear while typing. The provider’s web console is another option.

**Run all remaining installation commands in this server terminal.** Your laptop does not need Docker Desktop. Closing SSH does not stop an already running website.

## Step 3: prepare Docker on the server

If installed, verify:

```sh
docker info
docker compose version
```

The first command must include Server information; the second must report Compose v2 with `up --wait` support. If both work, continue to step 4.

Otherwise follow **Install using the apt repository** in [Docker’s official Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/) to install Engine and the Compose plugin. Use the corresponding official guide for other distributions, then verify again.

For permission denied, follow [Docker user permissions](https://docs.docker.com/engine/install/linux-postinstall/) and reconnect SSH. Keep using the same user rather than alternating with sudo. For Cannot connect to the Docker daemon, start the Docker service first.

## Step 4: download, extract and install

This guide downloads the **2.3.1 archive**. Existing instances need no reinstall; use the [maintenance guide](MAINTENANCE.en.md) to upgrade.

Use a writable persistent directory, such as your home. If the extraction directory exists, first check whether it is an old instance; do not overwrite it. Execute one line at a time in the server terminal. **Stop and resolve any error before proceeding.**

```sh
cd ~
curl -fL --retry 3 -o kira-hrt-self-host-2.3.1.tar.gz https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.3.1/kira-hrt-self-host-2.3.1.tar.gz
tar -xzf kira-hrt-self-host-2.3.1.tar.gz
cd kira-hrt-self-host-2.3.1
ls
```

Expect hrt.sh, compose.yaml, manage.mjs, VERSION and the guides. Do not download an APK, Source code or individual Packages images. The installer pulls web, API and PostgreSQL automatically, without GitHub login.

Substitute your actual configured domain:

```sh
sh hrt.sh install https://hrt.example.com
```

The script generates passwords/keys, pulls images, creates the database, starts three services and waits for health checks. Pulling/Downloading/Starting are normal progress; the first run may take minutes. Do not repeat install.

Expect `[1/3]`, `[2/3]`, `[3/3]`, then `Services are running. Open https://YOUR-DOMAIN`. No local-root.crt is expected: Caddy requests a public certificate automatically.

For existing/partial configuration, **keep .env and the master key**, resolve the error, then run `sh hrt.sh start` in the same directory instead of install/init.

## Step 5: open, register and verify

Open the original HTTPS address on your computer/phone. Certificate issuance may finish after container startup; retry shortly. Do not bypass certificate errors or import a local CA.

1. Confirm the correct address and no HTTPS certificate error.
2. Register an account on your own instance; official-service accounts do not migrate automatically.
3. Create a record, refresh and check it remains.
4. Open the same domain on your phone and sign in. Install the PWA through the browser’s Install app / Add to Home Screen menu if desired.
5. Create your first backup using [maintenance](MAINTENANCE.en.md), preserving configuration, key and database.

Healthy containers alone do not prove public certificate issuance. The browser must validate HTTPS. Official Android APKs use the official service; use this Web/PWA for self-hosting.

## Troubleshooting public access

| Symptom | Action |
|---|---|
| Domain unavailable / timeout | Check A/AAAA records, security group, server firewall and TCP 80/443 |
| Certificate errors / issuance failures | Check the domain reaches Caddy and inspect web logs; do not use LAN trust installation to bypass a public HTTPS issue |
| Port already allocated | Resolve existing web/proxy/container conflicts on 80/443, then run start |
| Already initialized | Keep configuration and keys; use start, never regenerate the key |
| Docker / image pull / health errors | Follow [common troubleshooting](MAINTENANCE.en.md) |

From the original deployment directory:

```sh
sh hrt.sh status
sh hrt.sh logs
```

Ctrl+C exits log viewing without stopping the site. Redact passwords/tokens/personal data before sharing logs. Backup, upgrade and recovery are in [maintenance](MAINTENANCE.en.md).
