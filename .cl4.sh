echo '=== .env backups with their owners ==='
sudo bash -c 'ls -la /srv/hrt/.env.bak* | awk "{print \$3, \$5, \$9}"'
echo '=== keep the newest, delete the rest ==='
sudo bash -c 'find /srv/hrt -maxdepth 1 -name ".env.bak*" -printf "%T@ %p\n" | sort -rn | tail -n +2 | cut -d" " -f2- | while read p; do echo "  rm $p"; rm -f "$p"; done'
echo '=== what remains ==='
sudo ls -la /srv/hrt/ | grep -E 'env|schema.sql$'
echo '=== keys referenced in the live .env (names only) ==='
sudo bash -c 'grep -oE "^[A-Z_]+" /srv/hrt/.env | tr "\n" " "'
echo
echo '=== disk after ==='
df -h / | tail -1
