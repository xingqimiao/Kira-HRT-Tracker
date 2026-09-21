set -e
sudo cp /srv/hrt/dist/index.cjs /srv/hrt/dist/index.cjs.bak-precred
sudo install -o hrt -g hrt -m 644 /tmp/h7-index.cjs /srv/hrt/dist/index.cjs
sudo systemctl restart hrt-server
sleep 6
systemctl is-active hrt-server
echo '=== which keys are in force ==='
sudo journalctl -u hrt-server --since '-2 minutes' --no-pager 2>/dev/null | grep -i 'keys from' | tail -2
echo '=== health ==='
curl -s http://127.0.0.1:8788/hrt/health; echo
echo '=== the credential directory the process sees ==='
PID=$(systemctl show hrt-server -p MainPID --value); sudo ls -la /proc/$PID/cwd >/dev/null 2>&1; sudo tr '\0' '\n' < /proc/$PID/environ | grep -c CREDENTIALS_DIRECTORY || echo 'not in environ (expected: it is passed per-process)'
