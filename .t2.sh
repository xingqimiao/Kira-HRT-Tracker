echo '=== origin cert subject/validity ==='
sudo openssl x509 -in /etc/caddy/certs/origin.pem -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null
echo '=== handshake against the origin directly ==='
echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername api.kiramyao.com 2>&1 | grep -E 'subject=|issuer=|Verify return code|Protocol|Cipher' | head -8
echo '=== repeat 8 direct POSTs, look for failures ==='
for i in 1 2 3 4 5 6 7 8; do curl -sk -o /dev/null -w "$i:%{http_code} " -X POST https://127.0.0.1/hrt/mcp -H 'Host: api.kiramyao.com' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' --max-time 20; done; echo
echo '=== caddy access log for 5xx recently ==='
sudo journalctl -u caddy --since '-30 min' --no-pager 2>/dev/null | grep -ciE 'error|handshake' || echo 0
