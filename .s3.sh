echo '=== db size + tables ==='
sudo -u postgres psql -tAc "select pg_size_pretty(pg_database_size('hrt'))"
sudo -u postgres psql -d hrt -tAc "select relname||' '||pg_size_pretty(pg_total_relation_size(c.oid)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by pg_total_relation_size(c.oid) desc limit 8"
echo '=== rows ==='
sudo -u postgres psql -d hrt -tAc "select 'users='||count(*) from users"
sudo -u postgres psql -d hrt -tAc "select 'records='||count(*) from records"
sudo -u postgres psql -d hrt -tAc "select 'sessions='||count(*) from sessions"
sudo -u postgres psql -d hrt -tAc "select 'api_tokens='||count(*) from api_tokens"
sudo -u postgres psql -d hrt -tAc "select 'shares='||count(*) from shares"
echo '=== how a record row is shaped ==='
sudo -u postgres psql -d hrt -tAc "select column_name||' '||data_type from information_schema.columns where table_name='records' order by ordinal_position"
echo '=== backup total ==='
sudo du -sh /srv/backup
echo '=== journal/docker/crash leftovers ==='
sudo journalctl --disk-usage
sudo ls /var/crash 2>/dev/null | head -5 || echo 'no /var/crash'
