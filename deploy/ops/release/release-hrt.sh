#!/usr/bin/env bash
# Versioned release helper for the HRT deployment.
#
#   release-hrt.sh server deploy   <artifact.tar.gz> <version>
#   release-hrt.sh server rollback <version>
#   release-hrt.sh web    deploy   <artifact.tar.gz> <version>
#   release-hrt.sh web    rollback <version>
#   release-hrt.sh check
#
# Releases are extracted next to the running one and never overwritten; the switch
# is an atomic symlink rename. A server switch restarts the unit and is verified by
# health checks; any failure puts the previous release back and restarts it.
#
# The server unit must already run /srv/hrt/current/dist/index.cjs (one-time
# bootstrap, see README.md). A rollback to a build that predates the restore
# generation gate is refused while any account has been restored.
#
# Test seams: HRT_ROOT, WEB_ROOT, NO_SYSTEMD=1, NO_HEALTH=1, PREFLIGHT_CMD.
set -uo pipefail

MODE=${1:-}; ACTION=${2:-}
ARTIFACT=""; VERSION=""
if [ "$ACTION" = deploy ]; then
  ARTIFACT=${3:-}; VERSION=${4:-}
else
  VERSION=${3:-}
fi
HRT_ROOT=${HRT_ROOT:-/srv/hrt}
WEB_ROOT=${WEB_ROOT:-/srv/hrt-web}
HEALTH_API=${HEALTH_API:-https://api.kiramyao.com/hrt/health}
HEALTH_WEB=${HEALTH_WEB:-https://hrt.kiramyao.com/}
NO_SYSTEMD=${NO_SYSTEMD:-0}
NO_HEALTH=${NO_HEALTH:-0}
UNIT=${UNIT:-hrt-server}
PREFLIGHT_CMD=${PREFLIGHT_CMD:-}

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
warn() { log "WARNING: $*"; }

valid_version() { [[ ${1:-} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }

# Atomic symlink replacement: a rename of a prepared link, never an unlink+link.
swap_link() { # swap_link <link> <target>
  local link=$1 target=$2 tmp="$1.tmp.$$"
  ln -sfn "$target" "$tmp" || return 1
  mv -Tf "$tmp" "$link" || return 1
}

restore_generation() {
  if [ -n "$PREFLIGHT_CMD" ]; then
    eval "$PREFLIGHT_CMD"
    return
  fi
  # Two steps: a single statement cannot name the column before it exists without
  # failing at parse time. "Unknown" (empty output) makes the caller refuse.
  local has
  has=$(sudo -u postgres psql -d hrt -tAc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='restore_generation'" 2>/dev/null | tr -d '[:space:]')
  [ "$has" = 0 ] && { echo 0; return; }
  [ "$has" = 1 ] || return 0
  sudo -u postgres psql -d hrt -tAc "SELECT coalesce(max(restore_generation),0) FROM users" 2>/dev/null | tr -d '[:space:]'
}

has_gate() { # has_gate <release-dir>
  grep -q 'restore generation mismatch' "$1/dist/index.cjs" 2>/dev/null
}

health_api() { curl -fsS --max-time 10 -o /dev/null "$HEALTH_API"; }
health_web() { curl -fsS --max-time 10 -o /dev/null "$HEALTH_WEB"; }

# Type=simple reports "active" as soon as the process exists, which is before the
# listener is up (KMS unwrap and migration take a moment). Poll the endpoint instead
# of failing the release on that race.
wait_health() {
  local i
  for i in $(seq 1 30); do
    health_api && return 0
    sleep 1
  done
  return 1
}

wait_active() {
  local i
  for i in $(seq 1 30); do
    [ "$(systemctl is-active "$UNIT" 2>/dev/null)" = active ] && return 0
    sleep 1
  done
  return 1
}

# --- server ----------------------------------------------------------------
server_require_bootstrap() {
  if [ "$NO_SYSTEMD" -eq 1 ]; then return 0; fi
  systemctl show "$UNIT" -p ExecStart --value 2>/dev/null | grep -q "$HRT_ROOT/current" \
    || die "unit $UNIT does not run $HRT_ROOT/current (see deploy/ops/release/README.md bootstrap)"
}

server_switch() { # server_switch <target-release>
  local target=$1
  swap_link "$HRT_ROOT/current" "releases/$target" || { warn "symlink swap failed"; return 1; }
  if [ "$NO_SYSTEMD" -eq 1 ]; then
    log "NO_SYSTEMD: skipped restart; current -> $target"
    return 0
  fi
  systemctl restart "$UNIT" || { warn "restart failed"; return 1; }
  wait_active || { warn "service did not become active"; return 1; }
  if [ "$NO_HEALTH" -eq 0 ]; then
    wait_health || { warn "API did not become healthy within 30s"; return 1; }
    health_web || { warn "web health failed"; return 1; }
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${HEALTH_API%/health}/api/records")
    [ "$code" = 401 ] || { warn "records route answered $code (want 401)"; return 1; }
  fi
  log "release $target is live"
  return 0
}

server_rollback_to() { # server_rollback_to <previous-release-label>
  local previous=$1
  [ -n "$previous" ] && [ -d "$HRT_ROOT/$previous" ] || die "previous release '$previous' not found"
  if has_gate "$HRT_ROOT/$previous"; then
    log "rollback target has the generation gate"
  else
    local gen
    gen=$(restore_generation)
    [ -n "$gen" ] || die "cannot read restore_generation; refusing a rollback without proof"
    [ "$gen" = 0 ] || die "refusing rollback: restore_generation=$gen and '$previous' has no gate; roll back to a gated build with RESTORE_ENABLED=0 instead"
    log "rollback target predates the gate, but no account was restored (generation 0)"
  fi
  local current
  current=$(basename "$(readlink -f "$HRT_ROOT/current")")
  swap_link "$HRT_ROOT/current" "$previous" || die "symlink swap failed"
  if [ "$NO_SYSTEMD" -eq 1 ]; then log "NO_SYSTEMD: skipped restart"; return 0; fi
  if ! systemctl restart "$UNIT" || ! wait_active; then
    warn "rollback restart failed; restoring $current"
    swap_link "$HRT_ROOT/current" "releases/$current"
    systemctl restart "$UNIT"
    die "rollback failed and the previous state was restored"
  fi
  [ "$NO_HEALTH" -eq 0 ] && { wait_health || warn "API did not become healthy after rollback"; }
  log "rolled back to $previous"
}

# --- entry -----------------------------------------------------------------
case "$MODE" in
  check)
    if [ -L "$HRT_ROOT/current" ]; then
      echo "current: $(basename "$(readlink -f "$HRT_ROOT/current")")"
      if [ "$HRT_ROOT" = /srv/hrt ]; then
        pid=$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null || true)
        [ -n "${pid:-}" ] && [ "$pid" != 0 ] && echo "running: $(readlink -f "/proc/$pid/exe" 2>/dev/null)"
      fi
      echo "gate: $(has_gate "$HRT_ROOT/$(readlink "$HRT_ROOT/current")" && echo present || echo missing)"
    else
      echo "current: (not a symlink)"
    fi
    echo "restore_generation: $(restore_generation)"
    if [ -L "$WEB_ROOT" ]; then echo "web: $(basename "$(readlink -f "$WEB_ROOT")")"; else echo "web: (not a symlink)"; fi
    ;;

  server)
    RELEASES=$HRT_ROOT/releases
    case "$ACTION" in
      deploy)
        valid_version "$VERSION" || die "version must be [A-Za-z0-9._-]{1,64}"
        [ -f "$ARTIFACT" ] || die "artifact not found: $ARTIFACT"
        server_require_bootstrap
        target=$RELEASES/$VERSION
        [ -e "$target" ] && die "release $VERSION already exists; releases are never overwritten"
        install -d "$target" || die "cannot create $target"
        tar -xzf "$ARTIFACT" -C "$target" || die "extract failed"
        [ -f "$target/dist/index.cjs" ] || die "artifact has no dist/index.cjs"
        [ -f "$target/schema.sql" ] || die "artifact has no schema.sql"
        if [ -L "$HRT_ROOT/current" ]; then
          previous=$(basename "$(readlink -f "$HRT_ROOT/current")")
        else
          previous=""
        fi
        if server_switch "$VERSION"; then
          log "deployed $VERSION (previous: ${previous:-none})"
          exit 0
        fi
        warn "switch to $VERSION failed; restoring ${previous:-none}"
        [ -n "$previous" ] && server_rollback_to "releases/$previous"
        exit 2
        ;;
      rollback)
        valid_version "$VERSION" || die "version must be [A-Za-z0-9._-]{1,64}"
        server_require_bootstrap
        server_rollback_to "releases/$VERSION"
        ;;
      *) die "usage: $0 server deploy <artifact> <version> | rollback <version>" ;;
    esac
    ;;

  web)
    WEB_RELEASES=$(dirname "$WEB_ROOT")/$(basename "$WEB_ROOT")-releases
    case "$ACTION" in
      deploy)
        valid_version "$VERSION" || die "version must be [A-Za-z0-9._-]{1,64}"
        [ -f "$ARTIFACT" ] || die "artifact not found: $ARTIFACT"
        [ -L "$WEB_ROOT" ] || die "$WEB_ROOT must be a symlink (bootstrap: move the current dir into $WEB_RELEASES and link it)"
        target=$WEB_RELEASES/$VERSION
        [ -e "$target" ] && die "web release $VERSION already exists; releases are never overwritten"
        install -d "$target" || die "cannot create $target"
        tar -xzf "$ARTIFACT" -C "$target" || die "extract failed"
        [ -f "$target/index.html" ] || die "artifact has no index.html"
        [ -d "$target/assets" ] || die "artifact has no assets/"
        previous=$(basename "$(readlink -f "$WEB_ROOT")")
        if swap_link "$WEB_ROOT" "$WEB_RELEASES/$VERSION" && { [ "$NO_HEALTH" -eq 1 ] || health_web; }; then
          log "deployed web $VERSION (previous: $previous)"
          exit 0
        fi
        warn "web switch failed; restoring $previous"
        swap_link "$WEB_ROOT" "$WEB_RELEASES/$previous"
        exit 2
        ;;
      rollback)
        valid_version "$VERSION" || die "version must be [A-Za-z0-9._-]{1,64}"
        target=$WEB_RELEASES/$VERSION
        [ -d "$target" ] || die "web release $VERSION not found"
        [ -L "$WEB_ROOT" ] || die "$WEB_ROOT must be a symlink"
        swap_link "$WEB_ROOT" "$target" || die "symlink swap failed"
        [ "$NO_HEALTH" -eq 0 ] && { health_web || { warn "web health failed after rollback"; exit 2; }; }
        log "rolled back web to $VERSION"
        ;;
      *) die "usage: $0 web deploy <artifact> <version> | rollback <version>" ;;
    esac
    ;;

  *) sed -n '2,17p' "$0"; exit 64 ;;
esac
