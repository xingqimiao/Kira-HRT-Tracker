echo '=== caddy tls for api.kiramyao.com ==='
sudo grep -n -A 3 'api.kiramyao.com {' /etc/caddy/Caddyfile | head -8
echo '=== origin cert ==='
sudo ls -la /etc/caddy/certs/ 2>/dev/null
echo '=== who terminates 443 ==='
sudo ss -lntp | grep -E ':443|:80' | head -6
echo '=== caddy errors mentioning handshake/tls (last 200 lines) ==='
sudo journalctl -u caddy -n 200 --no-pager 2>/dev/null | grep -iE 'handshake|tls|error' | tail -12
echo '=== origin reachable directly over https? ==='
curl -sk -o /dev/null -w 'direct https status=%{http_code} ssl=%{ssl_verify_result}\n' https://127.0.0.1/hrt/mcp -H 'Host: api.kiramyao.com' -X POST -d '{}' -H 'Content-Type: application/json' --max-time 15
