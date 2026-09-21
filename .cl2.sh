set -e
echo '=== web backups: keep the 2 newest, delete the rest ==='
cd /srv/backup
sudo ls -t hrt-web-*.tar.gz | tail -n +3 | while read f; do echo "  rm $f"; sudo rm -f "$f"; done
echo '=== stray web backups in /srv root: keep the newest ==='
cd /srv
STRAY=$(ls -t hrt-web-backup-*.tgz hrt-web-backup-*.tar.gz 2>/dev/null | tail -n +2)
for f in $STRAY; do echo "  rm /srv/$f"; sudo rm -f "/srv/$f"; done
echo '=== bundle backups: keep the 3 newest, delete the rest ==='
cd /srv/hrt/dist
sudo find /srv/hrt/dist -maxdepth 1 -name 'index.cjs.bak-*' -printf '%T@ %p\n' | sort -rn | tail -n +4 | while read t p; do echo "  rm $p"; sudo rm -f "$p"; done
echo '=== schema backups: keep the newest 2 ==='
sudo find /srv/hrt -maxdepth 1 -name 'schema.sql.bak-*' -printf '%T@ %p\n' | sort -rn | tail -n +3 | while read t p; do echo "  rm $p"; sudo rm -f "$p"; done
echo '=== journal: keep a month, then 50M ==='
sudo journalctl --vacuum-time=14d 2>&1 | tail -2
sudo journalctl --vacuum-size=50M 2>&1 | tail -2
echo '=== result ==='
df -h / | tail -1
sudo du -sh /srv/backup /srv/hrt/dist /srv/hrt 2>/dev/null
