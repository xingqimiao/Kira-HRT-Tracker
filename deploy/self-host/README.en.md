# Self-host Kira HRT: choose your installation scenario

[中文](README.md) · [Project](https://github.com/xingqimiao/Kira-HRT-Tracker)

Accounts, sync, sharing, MCP and offline lab-report recognition are included. No Oracle/Firebase/Cloudflare/OAuth account, host Node installation, compilation or manual database password is required.

**Choose one guide and follow it from step 1. You do not need to switch between installation guides.**

| Your situation | Guide |
|---|---|
| Public Linux server and your own domain, accessible over the internet | **[Public-server deployment](SERVER.en.md)**: DNS, server terminal and automatic HTTPS |
| Home NAS or Windows/macOS/Linux computer | **[LAN / NAS deployment](LAN.en.md)**: fixed IP and certificate trust on each client |
| Already installed; backup, upgrade, recovery or common errors | [Maintenance and troubleshooting](MAINTENANCE.en.md) |

## What should I download?

**[Download the 2.2.2 setup.2 deployment archive](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.2.2/kira-hrt-self-host-2.2.2-setup.2.tar.gz)**

Both scenarios use this archive. Each guide provides its own download, extraction and installation commands. After extracting, read this index, then SERVER.en.md or LAN.en.md. English/Chinese installation and maintenance guides are all bundled.

setup.2 splits and bundles documentation. Application images remain at 2.2.2 and commands are unchanged. The previous setup.1 asset remains available. **Existing instances need no reinstall, reinitialization or database upgrade.**

## What are the two GitHub packages?

| Package | Purpose | Manual download? |
|---|---|---|
| [`kira-hrt-web`](https://github.com/users/xingqimiao/packages/container/package/kira-hrt-web) | Website and HTTPS entry point | No, automatic |
| [`kira-hrt-api`](https://github.com/users/xingqimiao/packages/container/package/kira-hrt-api) | Accounts, sync, sharing and MCP backend | No, automatic |
| Official PostgreSQL image | Database | Also automatic; no separate installation |

You do not choose between them or install them individually. Docker selects Linux amd64/arm64 automatically; no GitHub login is needed. Download the deployment archive and follow your chosen guide.

See [maintenance](MAINTENANCE.en.md) for backups, key protection, source builds, optional integrations and encryption boundaries. The [verification record](https://github.com/xingqimiao/Kira-HRT-Tracker/blob/rewrite/deploy/self-host/VERIFICATION.md) distinguishes completed checks from real-device acceptance still required. GPL and attribution remain.
