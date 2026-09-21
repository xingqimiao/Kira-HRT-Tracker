echo '=== the page as a crawler sees it ==='
curl -s -H 'Accept: text/html' http://127.0.0.1:8789/ > /tmp/p.html; wc -c /tmp/p.html
for s in '所有日期均按 GMT+8 显示' '由 KiraEqual 出品' '对 AI 助手友好' 'GMT+8' '<title>' 'og:image' 'favicon-32.png'; do printf '%-24s %s\n' "$s" "$(grep -c "$s" /tmp/p.html)"; done
echo '=== the title ==='
grep -o '<title>[^<]*</title>' /tmp/p.html
echo '=== the last three day cells for CN ==='
curl -s -H 'Accept: application/json' http://127.0.0.1:8789/history.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);const c=b.components.find(x=>x.id==='site_cn');console.log(c.days.slice(-3).map(d=>d.day+'='+d.state).join(' '));});"
