set -e
echo '=== back up .env ==='
sudo cp /srv/hrt/.env /root/hrt-env.bak-$(date -u +%Y%m%d-%H%M%S) && echo backed up
echo '=== remove the two key lines (values stay in the encrypted credentials) ==='
sudo python3 - <<'PY'
p = '/srv/hrt/.env'
lines = open(p).read().splitlines(True)
keep = [l for l in lines if not (l.startswith('ENCRYPTION_KEY=') or l.startswith('SERVER_DEK_KEY='))]
removed = len(lines) - len(keep)
open(p, 'w').writelines(keep)
print('removed', removed, 'lines')
PY
sudo chown hrt:hrt /srv/hrt/.env; sudo chmod 600 /srv/hrt/.env
echo '=== restart with the keys gone from .env ==='
sudo systemctl restart hrt-server
sleep 6
systemctl is-active hrt-server
echo '=== proof: it booted, which requires both keys, and it says where they came from ==='
sudo journalctl -u hrt-server --since '-2 minutes' --no-pager 2>/dev/null | grep -iE 'keys from|error' | tail -3
echo '=== health ==='
curl -s http://127.0.0.1:8788/hrt/health; echo
echo '=== .env no longer holds them ==='
sudo bash -c 'grep -cE "^(ENCRYPTION_KEY|SERVER_DEK_KEY)=" /srv/hrt/.env || echo 0'
