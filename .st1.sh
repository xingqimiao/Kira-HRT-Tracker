echo '=== now ==='
date -u; date
echo '=== boce samples by UTC day ==='
sudo -u status node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/srv/kira-status/data/status.sqlite');
for (const r of db.prepare(\"select substr(datetime(at/1000,'unixepoch'),1,10) d, count(*) n, sum(ok) ok, sum(ok)*100.0/count(*) pct from probes where component='site_cn' group by d order by d desc limit 5\").all()) console.log(r.d, 'rows='+r.n, 'ok='+r.ok, pct=r.pct.toFixed(1)+'%');
console.log('--- local-time day of the newest sample ---');
const newest = db.prepare(\"select max(at) m from probes where component='site_cn'\").get();
console.log('newest UTC:', new Date(Number(newest.m)).toISOString());
"
echo '=== boce log ==='
sudo journalctl -u kira-status --since '-24 hours' 2>/dev/null | grep -i boce | tail -5
echo '=== what the page computes today ==='
curl -s http://127.0.0.1:8789/history.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);const c=b.components.find(x=>x.id==='site_cn');console.log('state:',c.state,'uptime:',(c.uptime*100).toFixed(2)+'%');console.log('last 5 days:',c.days.slice(-5).map(d=>d.key+'='+d.state).join(' '));});"
