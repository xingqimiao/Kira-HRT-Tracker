echo '=== services ==='
for s in caddy hrt-server kira-status kiraequal-comments postgresql; do printf '%-24s %s\n' "$s" "$(systemctl is-active $s 2>/dev/null)"; done
echo '=== listening ports ==='
sudo ss -lntp | awk 'NR>1 {print $4, $6}' | sort -u | head -20
echo '=== disk ==='
df -h / | tail -1
echo '=== memory ==='
free -m | head -2
echo '=== load / uptime ==='
uptime
echo '=== /srv sizes ==='
sudo du -sh /srv/* 2>/dev/null | sort -h | tail -12
