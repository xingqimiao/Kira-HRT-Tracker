-- Production post-migration state. Plain SQL file so nothing depends on shell quoting.
\echo '=== tables ==='
SELECT tablename FROM pg_tables
 WHERE schemaname = 'public' AND (tablename LIKE '%oauth%' OR tablename = 'records')
 ORDER BY tablename;

\echo '=== users columns (email present?) ==='
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'users' AND column_name IN ('email', 'username')
 ORDER BY column_name;

\echo '=== row counts ==='
SELECT 'users' AS t, count(*) AS n FROM users
UNION ALL SELECT 'oauth_accounts', count(*) FROM oauth_accounts
UNION ALL SELECT 'records', count(*) FROM records;

\echo '=== provider constraint ==='
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conrelid = 'oauth_accounts'::regclass AND contype = 'c';
