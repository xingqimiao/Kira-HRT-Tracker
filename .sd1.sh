set -e
cd /tmp && rm -rf status-src && mkdir status-src && tar -xzf status-src.tgz -C status-src
echo '=== what will be installed ==='
ls status-src; ls status-src/static
echo '=== back up the current service files ==='
sudo tar -czf /srv/backup/kira-status-predayfix-$(date -u +%Y%m%d-%H%M%S).tar.gz -C /srv/kira-status lib server.mjs
echo '=== install (ownership status:status, never touch data/) ==='
sudo rsync -a --chown=status:status /tmp/status-src/lib/ /srv/kira-status/lib/
sudo rsync -a --chown=status:status /tmp/status-src/static/ /srv/kira-status/static/
sudo install -o status -g status -m 644 /tmp/status-src/server.mjs /srv/kira-status/server.mjs
echo '=== restart ==='
sudo systemctl restart kira-status
sleep 5
systemctl is-active kira-status
echo '=== live page checks ==='
curl -s http://127.0.0.1:8789/ | grep -oE '所有日期均按 GMT\+8 显示；数据最多可能有 5 分钟延迟。|Kira HRT Tracker 由 KiraEqual 出品。|<title>[^<]*</title>' | head -5
echo '=== today CN cell ==='
curl -s http://127.0.0.1:8789/history.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);const c=b.components.find(x=>x.id==='site_cn');console.log('state:',c.state);console.log('days:',c.days.slice(-3).map(d=>d.date+'='+d.state).join(' '));});"
echo '=== icon + robots + sitemap ==='
for p in /favicon-32.png /robots.txt /sitemap.xml; do printf '%s ' $p; curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:8789$p; done
