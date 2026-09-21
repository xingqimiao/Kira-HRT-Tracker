set -e
cd /tmp && rm -rf s3 && mkdir s3 && tar -xzf status-src3.tgz -C s3
sudo rsync -a --chown=status:status /tmp/s3/lib/ /srv/kira-status/lib/
sudo rsync -a --chown=status:status /tmp/s3/static/ /srv/kira-status/static/
sudo install -o status -g status -m 644 /tmp/s3/server.mjs /srv/kira-status/server.mjs
sudo systemctl restart kira-status
sleep 5
systemctl is-active kira-status
curl -s -H 'Accept: text/html' http://127.0.0.1:8789/ > /tmp/p3.html
grep -o '<title>[^<]*</title>' /tmp/p3.html
echo '--- footer order ---'
python3 - <<'PY'
import re
h = open('/tmp/p3.html').read()
foot = h[h.index('<footer'):h.index('</footer>')]
for line in re.findall(r'<p>.*?</p>', foot, re.S):
    print(' ', re.sub(r'<[^>]+>', '', line)[:70])
PY
echo '--- the two claims must be gone ---'
grep -c '由 KiraEqual 出品' /tmp/p3.html || true; grep -c '对 AI 助手友好' /tmp/p3.html || true
