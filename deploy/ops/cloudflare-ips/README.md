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

## Install

    install -m 755 cloudflare-ips-update cloudflare-ips-notify /usr/local/sbin/
    install -m 644 cloudflare-ips-update.service cloudflare-ips-update.timer \
                   'cloudflare-ips-alert@.service' /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now cloudflare-ips-update.timer

## Alerts

`cloudflare-ips-notify` delivers one Telegram message per event. It is a separate
program on purpose: it always exits 0, so a broken or slow channel can never change
the updater's decision, exit status or exit code.

Events: a removal held for review (once), reminders at half the grace window and
one day before expiry, "about to apply", "applied", and failures (fetch, list
validation, candidate validation, install, post-reload check, rollback, failed
rollback). `OnFailure=` on the unit is a supplement for exits the script did not
expect — it is not what reports a pending removal.

Dedup lives in `/var/lib/cloudflare-ips/alerts.state` (`key<TAB>epoch`). One-shot
keys (`--once`) are never repeated; recurring keys use `--window` (default 1 day),
so a persistent failure nags once a day instead of once per run.

### Telegram setup

1. Create the bot with @BotFather (`/newbot`) and keep the token.
2. Open the bot in Telegram and send `/start` — a bot cannot write to a chat that
   has not spoken to it first.
3. Store both values root-only, never in this repository:

       install -d -m 700 -o root -g root /etc/cloudflare-ips
       install -m 600 -o root -g root /dev/stdin /etc/cloudflare-ips/telegram-token
       install -m 600 -o root -g root /dev/stdin /etc/cloudflare-ips/telegram-chat-id

   The chat id comes from `getUpdates` after step 2 (`result[].message.chat.id`).
4. Verify both the credential and the delivery path:

       /usr/local/sbin/cloudflare-ips-notify --level info --key install-check --window 0 \
         -- "alert channel test"

   The log line must read `sent: key=install-check attempt=1 …`. If it reads
   `NOT SENT`, the token/chat files are missing or unreadable.

The token is never printed and never appears on a command line: the request URL is
handed to curl through a 0600 config file in a private temp dir. Only the HTTP
status and Telegram's `description` are logged. Rotate by re-running step 3 — no
code change.

## Test without touching production

    sudo ./selftest.sh

Runs the updater against a fixture Caddyfile (a non-default path forces
`--no-reload`) with a stub `caddy` and a local fake Telegram endpoint, and asserts
every event, the dedup behaviour, the retry budget, the no-retry-on-4xx path and
that the token never reaches a log.
