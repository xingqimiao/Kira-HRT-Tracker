echo '=== bundle backups (name, size, date) ==='
sudo ls -la /srv/hrt/dist/ | grep bak | awk '{print $5, $6, $7, $8, $9}' | sort -n | head -25
echo '=== count + total ==='
sudo du -sh /srv/hrt/dist/
echo '=== web backups by date ==='
sudo ls -la /srv/backup/ | awk '{print $5, $6, $7, $8, $9}'
echo '=== journal ==='
sudo journalctl --disk-usage
