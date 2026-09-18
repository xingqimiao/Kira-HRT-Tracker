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
