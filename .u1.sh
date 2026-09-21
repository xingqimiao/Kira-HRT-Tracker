echo '=== the real unit ==='
sudo cat /etc/systemd/system/hrt-server.service
echo '=== drop-ins? ==='
sudo ls -la /etc/systemd/system/hrt-server.service.d/ 2>/dev/null || echo 'none'
echo '=== how config reads env (names only, no values) ==='
cd /srv/hrt && echo ok
