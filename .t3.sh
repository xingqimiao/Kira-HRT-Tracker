echo '=== ip:port 443 ==='
sudo ss -lntp | grep ':443'
echo '=== does the CF IP list include the observed peers? 172.71.x / 172.64.x / 104.16.x ==='
grep -c '172.64.0.0/13\|104.16.0.0/13\|172.71' /etc/caddy/Caddyfile || echo 'check manually'
echo '=== recent connection errors? ==='
sudo journalctl -u caddy --since '-20 min' --no-pager 2>/dev/null | grep -ciE 'error|handshake|refused' || true
echo '=== gateway/firewall ==='
sudo iptables -L INPUT -n --line-numbers 2>/dev/null | head -12 || echo 'no iptables rules visible'
sudo ufw status 2>/dev/null | head -6 || echo 'no ufw'
echo '=== tcp backlog / syn drops ==='
nstat -az 2>/dev/null | grep -iE 'TcpExtListenDrops|TcpExtListenOverflows|TcpExtSyncookiesSent|TcpAttemptFails' | head -6 || echo 'nstat unavailable'
echo '=== somaxconn ==='
cat /proc/sys/net/core/somaxconn
