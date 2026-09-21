set -e
cd /tmp && rm -rf s2 && mkdir s2 && tar -xzf status-src2.tgz -C s2
sudo rsync -a --chown=status:status /tmp/s2/lib/ /srv/kira-status/lib/
sudo rsync -a --chown=status:status /tmp/s2/static/ /srv/kira-status/static/
sudo install -o status -g status -m 644 /tmp/s2/server.mjs /srv/kira-status/server.mjs
sudo systemctl restart kira-status
sleep 5
systemctl is-active kira-status
curl -s -H 'Accept: text/html' http://127.0.0.1:8789/ > /tmp/p2.html; wc -c /tmp/p2.html
for s in '所有日期均按 GMT+8 显示' '由 KiraEqual 出品' '对 AI 助手友好' '<title>' 'favicon-32.png'; do printf '%-24s %s\n' "$s" "$(grep -c "$s" /tmp/p2.html || true)"; done
grep -o '<title>[^<]*</title>' /tmp/p2.html
