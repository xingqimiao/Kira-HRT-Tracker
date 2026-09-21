echo '=== /srv/hrt ==='
sudo ls -la /srv/hrt/
echo '=== dist backups count ==='
sudo ls /srv/hrt/dist/ | grep -c 'bak'
echo '=== /srv/backup contents ==='
sudo ls -la /srv/backup/ | head -20
echo '=== db size ==='
sudo -u postgres psql -tAc "select pg_size_pretty(pg_database_size('hrt'))" 2>/dev/null
echo '=== table sizes ==='
sudo -u postgres psql -d hrt -tAc "select relname, pg_size_pretty(pg_total_relation_size(c.oid)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by pg_total_relation_size(c.oid) desc limit 10" 2>/dev/null
echo '=== row counts ==='
sudo -u postgres psql -d hrt -tAc "select 'users', count(*) from users union all select 'records', count(*) from records union all select 'sessions', count(*) from sessions union all select 'api_tokens', count(*) from api_tokens union all select 'shares', count(*) from shares" 2>/dev/null
