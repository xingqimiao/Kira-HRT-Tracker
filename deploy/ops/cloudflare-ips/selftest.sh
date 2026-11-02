#!/usr/bin/env bash
# selftest.sh — exercise cloudflare-ips-update and cloudflare-ips-notify in a sandbox.
#
#   sudo ./selftest.sh
#
# Nothing outside the temp dir is touched: --caddyfile points at a fixture (which
# forces --no-reload), CADDY_BIN is a stub, and the notifier talks to a local fake
# Telegram endpoint instead of api.telegram.org. Requires python3, curl, flock.
set -uo pipefail
export LC_ALL=C

[ "$(id -u)" = 0 ] || { echo "run as root: sudo $0" >&2; exit 64; }

HERE=$(cd "$(dirname "$0")" && pwd)
UPD=$HERE/cloudflare-ips-update
NOTIFY=$HERE/cloudflare-ips-notify
SB=$(mktemp -d /tmp/cf-ips-selftest.XXXXXX)
TG_PID=
cleanup() { [ -n "${TG_PID:-}" ] && kill "$TG_PID" 2>/dev/null; rm -rf "$SB"; }
trap cleanup EXIT

pass=0; fail=0
ok()  { pass=$((pass+1)); printf 'ok   %s\n' "$1"; }
no()  { fail=$((fail+1)); printf 'FAIL %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (want [$2], got [$3])"; fi; }
contains()     { if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1"; else no "$1 (missing [$3])"; fi; }
not_contains() { if grep -qF -- "$3" "$2" 2>/dev/null; then no "$1 (found [$3])"; else ok "$1"; fi; }
nlines() { wc -l < "$1" 2>/dev/null | tr -d ' '; }

# --- fake telegram ---------------------------------------------------------
PORT=$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
)
cat > "$SB/tg.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

sent, port, codes_file = sys.argv[1], int(sys.argv[2]), sys.argv[3]

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers()
        self.wfile.write(b"ok")
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            text = json.loads(body).get("text", "")
        except Exception:
            text = "<unparsable>"
        # Every attempt is recorded, but only an accepted message counts as sent:
        # a retried delivery must not look like two alerts.
        with open(sent + ".attempts", "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
        code, extra = 200, {}
        try:
            codes = [l.strip() for l in open(codes_file) if l.strip()]
        except FileNotFoundError:
            codes = []
        if codes:
            code = int(codes[0])
            open(codes_file, "w").write("\n".join(codes[1:]) + ("\n" if codes[1:] else ""))
            if code == 429:
                extra = {"parameters": {"retry_after": 1}}
        if code == 200:
            payload = {"ok": True, "result": {"message_id": 1}}
        else:
            payload = {"ok": False, "error_code": code, "description": "forced-%d" % code, **extra}
        if code == 200:
            with open(sent, "a", encoding="utf-8") as fh:
                fh.write(text + "\n")
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
python3 "$SB/tg.py" "$SB/sent.txt" "$PORT" "$SB/codes" >"$SB/tg.out" 2>&1 &
TG_PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/" && break; sleep 0.1; done

printf 'tok-TEST-9f3a' > "$SB/token"
printf '4242' > "$SB/chat"
: > "$SB/sent.txt"

# --- harness environment ---------------------------------------------------
export NOTIFY=$NOTIFY CADDY_BIN=$SB/caddy
export CF_TG_TOKEN_FILE=$SB/token CF_TG_CHAT_FILE=$SB/chat
export CF_ALERT_STATE=$SB/alert.state CF_ALERT_LOG=$SB/alert.log
export CF_TG_API_BASE=http://127.0.0.1:$PORT

cat > "$SB/caddy" <<EOS
#!/usr/bin/env bash
[ -f "$SB/caddy.fail" ] && { echo "Error: simulated invalid config" >&2; exit 1; }
exit 0
EOS
chmod +x "$SB/caddy"

CADDYFILE=$SB/Caddyfile
STATE=$SB/state
LOG=$SB/log
mkdir -p "$STATE" "$LOG" "$SB/backup" "$SB/src"

# The real Cloudflare ranges: the validator requires globally routable networks.
V4=(103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 104.16.0.0/13 104.24.0.0/14
    108.162.192.0/18 131.0.72.0/22 141.101.64.0/18 162.158.0.0/15 172.64.0.0/13
    173.245.48.0/20 188.114.96.0/20 190.93.240.0/20 197.234.240.0/22 198.41.128.0/17)
V6=(2400:cb00::/32 2405:8100::/32 2405:b500::/32 2606:4700::/32 2803:f800::/32
    2a06:98c0::/29 2c0f:f248::/32)

write_caddyfile() { # write_caddyfile <v4 list> <v6 list>
  {
    echo 'example.test {'
    echo '	# BEGIN CLOUDFLARE-IPS (managed by cloudflare-ips-update; do not edit by hand)'
    echo "	@not_cloudflare not remote_ip $1 $2"
    echo '	# END CLOUDFLARE-IPS'
    echo '}'
  } > "$CADDYFILE"
}
write_source() { # write_source <v4 list> <v6 list>
  printf '%s\n' $1 > "$SB/src/ips-v4"
  printf '%s\n' $2 > "$SB/src/ips-v6"
}
run_upd() { # run_upd [extra args...]
  "$UPD" --caddyfile "$CADDYFILE" --state-dir "$STATE" --log-dir "$LOG" \
         --backup-root "$SB/backup" --source-dir "$SB/src" "$@" >"$SB/out" 2>&1
}
status() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("status",""))' "$STATE/last-result.json" 2>/dev/null; }
set_pending_age() { # set_pending_age <days>
  python3 - "$STATE/pending-removal.json" "$1" <<'PY'
import json, sys, time
p, days = sys.argv[1], int(sys.argv[2])
d = json.load(open(p))
d["firstSeen"] = int(time.time()) - days * 86400
json.dump(d, open(p, "w"))
PY
}

BASE4="${V4[*]}"; BASE6="${V6[*]}"
write_caddyfile "$BASE4" "$BASE6"

# --- 1. no change ----------------------------------------------------------
write_source "$BASE4" "$BASE6"
run_upd; check "no-change exit" 0 $?
check "no-change status" no_change "$(status)"
check "no-change sends nothing" 0 "$(nlines "$SB/sent.txt")"

# --- 2. addition applies and notifies -------------------------------------
write_source "$BASE4 1.0.0.0/24" "$BASE6"
run_upd; check "add exit" 0 $?
check "add status" applied "$(status)"
contains "add written" "$CADDYFILE" "1.0.0.0/24"
check "add sent one alert" 1 "$(nlines "$SB/sent.txt")"
contains "add message" "$SB/sent.txt" "已更新并生效"
contains "add message diff" "$SB/sent.txt" "+ 1.0.0.0/24"

# --- 3. removal is held, and alerted once ---------------------------------
write_source "$BASE4" "$BASE6"
run_upd; check "removal exit" 3 $?
check "removal status" pending_removal "$(status)"
test -f "$STATE/pending-removal.json" && ok "pending state written" || no "pending state written"
contains "removal not applied" "$CADDYFILE" "1.0.0.0/24"
check "removal sent one alert" 2 "$(nlines "$SB/sent.txt")"
contains "removal message" "$SB/sent.txt" "已暂缓应用"
run_upd; check "repeat removal exit" 3 $?
check "repeat removal is deduped" 2 "$(nlines "$SB/sent.txt")"

# --- 4. reminder at half the grace window ---------------------------------
set_pending_age 3
run_upd; check "reminder exit" 3 $?
check "reminder sent" 3 "$(nlines "$SB/sent.txt")"
contains "reminder message" "$SB/sent.txt" "仍在挂起"
run_upd; check "reminder deduped" 3 "$(nlines "$SB/sent.txt")"

# --- 5. grace expiry applies, telling the operator before and after -------
set_pending_age 8
run_upd; check "expiry exit" 0 $?
check "expiry status" applied "$(status)"
check "expiry sent two alerts" 5 "$(nlines "$SB/sent.txt")"
contains "expiry pre-notice" "$SB/sent.txt" "宽限期已满"
contains "expiry applied" "$SB/sent.txt" "已更新并生效"
not_contains "expiry removed the range" "$CADDYFILE" "1.0.0.0/24"
test -f "$STATE/pending-removal.json" && no "pending cleared" || ok "pending cleared"

# --- 6. fetch failure -----------------------------------------------------
mkdir -p "$SB/empty"
"$UPD" --caddyfile "$CADDYFILE" --state-dir "$STATE" --log-dir "$LOG" \
       --backup-root "$SB/backup" --source-dir "$SB/empty" >"$SB/out" 2>&1
check "fetch failure exit" 1 $?
check "fetch failure status" error "$(status)"
contains "fetch failure alert" "$SB/sent.txt" "列表读取失败"

# --- 7. validation failure ------------------------------------------------
printf '10.0.0.0/8\n300.1.1.0/24\n' > "$SB/src/ips-v4"
run_upd; check "validation exit" 1 $?
contains "validation alert" "$SB/sent.txt" "校验失败"

# --- 8. caddy validate failure leaves the file alone ----------------------
write_source "$BASE4 5.0.0.0/24" "$BASE6"
before=$(sha256sum "$CADDYFILE" | cut -d' ' -f1)
: > "$SB/caddy.fail"
run_upd; check "caddy validate exit" 1 $?
rm -f "$SB/caddy.fail"
after=$(sha256sum "$CADDYFILE" | cut -d' ' -f1)
check "caddy validate leaves file" "$before" "$after"
contains "caddy validate alert" "$SB/sent.txt" "caddy validate"

# --- 9. post-update failure rolls back and says so ------------------------
write_source "$BASE4 8.0.0.0/24" "$BASE6"
run_upd --simulate-post-reload-failure; check "rollback exit" 2 $?
check "rollback status" rolled_back "$(status)"
not_contains "rollback removed the new range" "$CADDYFILE" "8.0.0.0/24"
contains "rollback pre-notice" "$SB/sent.txt" "正在回滚"
contains "rollback ok notice" "$SB/sent.txt" "已自动回滚"

# --- 10. failed rollback escalates ---------------------------------------
write_source "$BASE4 9.0.0.0/24" "$BASE6"
run_upd --simulate-post-reload-failure --simulate-rollback-restore-failure
check "failed rollback exit" 4 $?
check "failed rollback status" rollback_failed "$(status)"
contains "failed rollback alert" "$SB/sent.txt" "回滚失败"

# A second failure inside the window must not stack more messages: the alarm for
# "cannot put the old allowlist back" is one per hour, not one per attempt.
before=$(nlines "$SB/sent.txt")
write_source "$BASE4 9.0.0.0/24 13.0.0.0/24" "$BASE6"
run_upd --simulate-post-reload-failure --simulate-rollback-restore-failure
check "second failed rollback exit" 4 $?
check "second failed rollback is rate-limited" "$before" "$(nlines "$SB/sent.txt")"

# --- 11. notifier: dedup, retry, no-retry, missing channel ---------------
before=$(nlines "$SB/sent.txt")
"$NOTIFY" --key dedup-test --window 3600 -- "第一次" >/dev/null 2>&1
"$NOTIFY" --key dedup-test --window 3600 -- "第二次" >/dev/null 2>&1
check "dedup sends one" "$((before+1))" "$(nlines "$SB/sent.txt")"

printf '500\n200\n' > "$SB/codes"
"$NOTIFY" --key retry-test --window 0 -- "重试测试" >/dev/null 2>&1
check "retry delivers" "$((before+2))" "$(nlines "$SB/sent.txt")"
contains "retry logged" "$SB/alert.log" "retrying"

printf '401\n' > "$SB/codes"
before=$(nlines "$SB/sent.txt")
"$NOTIFY" --key noauth-test --window 0 -- "不会送达" >/dev/null 2>&1
check "4xx not delivered" "$before" "$(nlines "$SB/sent.txt")"
contains "4xx logged as failure" "$SB/alert.log" "http=401"

rm -f "$SB/token"
"$NOTIFY" --key nochannel-test --window 0 -- "无渠道" >/dev/null 2>&1
contains "missing channel is reported, not fatal" "$SB/alert.log" "NOT SENT"
printf 'tok-TEST-9f3a' > "$SB/token"

# --- 12. the token never lands in a log or a state file -------------------
if grep -rqF "tok-TEST-9f3a" "$SB/alert.log" "$SB/state" "$SB/backup" "$SB/log" 2>/dev/null; then
  no "token leaked into logs/state"
else
  ok "token leaked into logs/state"
fi

# --- 13. unit definitions carry the supplement ---------------------------
contains "service has OnFailure" "$HERE/cloudflare-ips-update.service" "OnFailure=cloudflare-ips-alert@%N.service"
contains "service treats review/rollback as handled" "$HERE/cloudflare-ips-update.service" "SuccessExitStatus=2 3"
contains "alert unit exists" "$HERE/cloudflare-ips-alert@.service" "cloudflare-ips-notify"
# 2 = rolled back safely, 3 = held for review. 4 (rollback failed) and 1 (any
# error) must stay failures so OnFailure still fires as the supplement.
check "SuccessExitStatus is exactly 2 3" "SuccessExitStatus=2 3" \
  "$(grep '^SuccessExitStatus=' "$HERE/cloudflare-ips-update.service")"
if grep -qE '^SuccessExitStatus=.*\b4\b' "$HERE/cloudflare-ips-update.service"; then
  no "exit 4 (rollback failed) must not be a success status"
else
  ok "exit 4 (rollback failed) is still a failure"
fi
check "exit 3 appears only for the pending-review branch" "1" \
  "$(grep -oE 'exit 3' "$UPD" | wc -l | tr -d ' ')"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
