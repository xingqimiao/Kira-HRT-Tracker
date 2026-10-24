#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
dc() { docker compose -f compose.yaml "$@"; }
# The management model intentionally omits the three running app services.
tool() { COMPOSE_IGNORE_ORPHANS=true docker compose -f tools.yaml run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" tools "$@"; }
backup() {
  name="$(date -u +%Y%m%dT%H%M%SZ)"
  dc stop web api
  # Always resume the API if a dump or file copy fails.
  trap 'dc start api web >/dev/null' EXIT HUP INT TERM
  tool backup-prepare "$name"
  dc exec -T db pg_dump -U hrt -d hrt -Fc -f /tmp/hrt-backup.dump
  dc cp db:/tmp/hrt-backup.dump "backups/$name/database.dump"
  dc exec -T db rm /tmp/hrt-backup.dump
  tool backup-finish "$name"
  dc start api web
  trap - EXIT HUP INT TERM
}
command="${1:-help}"
case "$command" in
  install)
    address="${2:?Supply https://domain or https://fixed-IP}"
    docker info >/dev/null || { echo 'Docker is not running or this user cannot access it. See README.md.' >&2; exit 1; }
    docker compose version >/dev/null
    echo '[1/3] Creating configuration and encryption key...'
    tool init "$address"
    echo '[2/3] Downloading images and starting services (first run may take several minutes)...'
    dc up -d --wait --wait-timeout 180
    echo '[3/3] Preparing your access instructions...'
    tool installed
    ;;
  init) tool init "${2:?Supply https://domain or https://fixed-IP}" ;;
  start) dc up -d --wait --wait-timeout 180 ;;
  stop) dc stop ;;
  status) dc ps --all ;;
  check) dc up -d --wait --wait-timeout 180; dc exec -T api node -e "fetch('http://127.0.0.1:8788/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))" ;;
  logs) dc logs --tail 100 -f ;;
  cert) tool cert ;;
  backup) backup ;;
  restore)
    name="${2:?Supply backup directory name}"
    tool backup-verify "$name"
    tool restore-files "$name"
    tool restore-ca "$name"
    dc up -d db --wait --wait-timeout 120
    count="$(dc exec -T db psql -U hrt -d hrt -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
    [ "$count" = 0 ] || { echo 'Database is not empty; restore refused' >&2; exit 1; }
    dc cp "backups/$name/database.dump" db:/tmp/hrt-restore.dump
    dc exec -T db pg_restore -U hrt -d hrt --exit-on-error --single-transaction --no-owner /tmp/hrt-restore.dump
    dc exec -T db rm /tmp/hrt-restore.dump
    dc up -d --wait --wait-timeout 180
    ;;
  upgrade)
    version="${2:?Supply an explicit version}"
    tool validate-version "$version"
    # Validate before stopping anything; pull the selected release before changing configuration.
    HRT_VERSION="$version" dc config --quiet
    HRT_VERSION="$version" dc pull
    backup
    tool version "$version"
    dc up -d --wait --wait-timeout 180
    echo "Upgrade healthy: $version"
    ;;
  build) docker compose -f compose.yaml -f compose.build.yaml build ;;
  help) echo 'First installation: sh hrt.sh install https://YOUR-DOMAIN-OR-IP'; echo 'Maintenance: sh hrt.sh start | stop | status | check | logs | cert | backup | restore NAME | upgrade VERSION'; echo 'Advanced: sh hrt.sh init URL | build' ;;
  *) echo 'Unknown command. Run: sh hrt.sh help' >&2; exit 1 ;;
esac
