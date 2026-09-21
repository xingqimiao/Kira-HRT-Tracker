set -e
echo '=== install the new bundle (has applyCredentials) ==='
sudo cp /srv/hrt/dist/index.cjs /srv/hrt/dist/index.cjs.bak-precred
sudo install -o hrt -g hrt -m 644 /tmp/h6-index.cjs /srv/hrt/dist/index.cjs 2>/dev/null || echo 'staged bundle missing, will use current'
echo '=== restart ==='
sudo systemctl restart hrt-server
sleep 6
systemctl is-active hrt-server
echo '=== does the process see the credentials dir? ==='
sudo systemctl show hrt-server -p MainPID --value
echo '=== health ==='
curl -s http://127.0.0.1:8788/hrt/health; echo
echo '=== logs ==='
sudo journalctl -u hrt-server --since '-2 minutes' --no-pager 2>/dev/null | grep -iE 'error|listen|credential' | tail -5
