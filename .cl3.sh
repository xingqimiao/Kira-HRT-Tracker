set -e
echo '=== web backups: keep the 2 newest ==='
sudo bash -c 'cd /srv/backup && ls -t hrt-web-*.tar.gz | tail -n +3 | while read f; do echo "  rm $f"; rm -f "$f"; done'
echo '=== stray web backups in /srv root: keep the newest ==='
sudo bash -c 'cd /srv && ls -t hrt-web-backup-*.tgz hrt-web-backup-*.tar.gz 2>/dev/null | tail -n +2 | while read f; do echo "  rm /srv/$f"; rm -f "/srv/$f"; done'
echo '=== bundle backups: keep the 3 newest ==='
sudo bash -c 'find /srv/hrt/dist -maxdepth 1 -name "index.cjs.bak-*" -printf "%T@ %p\n" | sort -rn | tail -n +4 | cut -d" " -f2- | while read p; do echo "  rm $p"; rm -f "$p"; done'
echo '=== schema backups: keep the 2 newest ==='
sudo bash -c 'find /srv/hrt -maxdepth 1 -name "schema.sql.bak-*" -printf "%T@ %p\n" | sort -rn | tail -n +3 | cut -d" " -f2- | while read p; do echo "  rm $p"; rm -f "$p"; done'
echo '=== journal ==='
sudo journalctl --vacuum-size=50M 2>&1 | tail -2
echo '=== result ==='
df -h / | tail -1
sudo du -sh /srv/backup /srv/hrt/dist 2>/dev/null
