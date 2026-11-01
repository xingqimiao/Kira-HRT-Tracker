# Cloudflare IP allowlist refresh

Keeps the `@not_cloudflare not remote_ip …` matcher of the api site current.

- The allowlist lives between `# BEGIN CLOUDFLARE-IPS` / `# END CLOUDFLARE-IPS`
  in `/etc/caddy/Caddyfile`. The script rewrites only that line.
- Fetch failure, a malformed/truncated list, or a non-public range changes nothing.
- Additions apply automatically. Removals are held for review for
  `--removal-grace-days` (default 7) and then applied, so a decommissioned
  range does not stay trusted forever; each run logs the pending diff.
- Before writing: backup under `/srv/hrt-backup-caddy/cloudflare-ips/`, candidate
  validated with the binary the unit runs, atomic rename. After reload: the live
  config, the origin gate and health are checked; any failure restores the backup.

Install (only after the marker block exists and a manual run reports `no change`):

    install -m 755 cloudflare-ips-update /usr/local/sbin/
    install -m 644 cloudflare-ips-update.service cloudflare-ips-update.timer /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now cloudflare-ips-update.timer

Test without touching production: run with `--caddyfile <copy>` (a non-default
path forces `--no-reload`) and `--source-dir <fixtures>`.
