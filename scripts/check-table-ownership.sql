-- Ownership audit and repair.
--
-- The app connects as `hrt` and runs `schema.sql` on every startup, which means it
-- must OWN every object the file touches. Anything created through a
-- `sudo -u postgres psql` session lands owned by `postgres` instead, and the app then
-- crash-loops with "must be owner of table ..." — which is exactly what happened to
-- `records` and took the API down.
--
-- Read this output before and after any manual migration.

\echo '=== tables and their owners ==='
SELECT tableowner AS owner, tablename AS object
  FROM pg_tables
 WHERE schemaname = 'public'
 ORDER BY tableowner, tablename;

\echo '=== anything NOT owned by hrt (these will break startup) ==='
SELECT c.relkind AS kind, c.relname AS object, r.rolname AS owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'S', 'v', 'm')
   AND r.rolname <> 'hrt'
 ORDER BY c.relname;

-- Tables and columns that the code no longer references, kept as a positive check
-- that the DROPs in schema.sql actually ran. A row from the first list means a
-- dropped table is still there; a row from the second means a dropped column is.
\echo '=== retired tables that must be absent ==='
SELECT tablename AS still_present
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename IN ('totp_backup_codes', 'medication_events', 'lab_results',
                     'webauthn_credentials', 'webauthn_challenges')
 ORDER BY tablename;

\echo '=== retired users columns that must be absent ==='
SELECT column_name AS still_present
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'users' AND column_name LIKE 'totp%';


