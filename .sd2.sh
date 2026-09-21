echo '=== first 400 bytes of the page from the origin ==='
curl -s http://127.0.0.1:8789/?cb=$(date +%s) | head -c 400
echo
echo '=== does the string appear at all (raw) ==='
curl -s http://127.0.0.1:8789/?cb=$(date +%s) > /tmp/page.html; wc -c /tmp/page.html; grep -c 'GMT+8' /tmp/page.html || echo 0; grep -o '<title>[^<]*</title>' /tmp/page.html || echo 'no title tag'
echo '=== is the running code the new one? ==='
grep -c 'STATUS_TIME_ZONE' /srv/kira-status/lib/aggregate.mjs
grep -c 'GMT+8' /srv/kira-status/lib/view.mjs
grep -o "const PRODUCT = '[^']*'" /srv/kira-status/lib/view.mjs
