echo '=== the production host clock ==='
date; date -u; timedatectl 2>/dev/null | head -6
echo '=== TZ env for the service ==='
systemctl show kira-status -p Environment --value
grep -E '^Environment' /etc/systemd/system/kira-status.service 2>/dev/null || sudo grep -E 'Environment' /etc/systemd/system/kira-status.service
echo '=== what the live code says it schedules ==='
sudo journalctl -u kira-status --since '-3 days' --no-pager 2>/dev/null | grep -i 'next CN sample' | tail -3
