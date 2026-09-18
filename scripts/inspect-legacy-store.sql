-- Inspect the account's key wrappers and payload shape.
-- Plain SQL file: nesting quotes through pwsh silently produced empty results twice
-- while working on this migration.

\echo '=== users: privacy mode and which wrappers exist ==='
SELECT u.username,
       u.privacy_mode,
       (u.encryption_metadata -> 'wrappers' -> 'password') IS NOT NULL AS has_password_wrapper,
       (u.encryption_metadata -> 'wrappers' -> 'server')   IS NOT NULL AS has_server_wrapper,
       (u.encryption_metadata -> 'wrappers' -> 'recovery') IS NOT NULL AS has_recovery_wrapper,
       u.password_hash IS NOT NULL AS has_password
  FROM users u;

\echo '=== does the stored event payload hold a cloud envelope? ==='
SELECT count(*) AS events,
       count(*) FILTER (WHERE payload ? 'cloud') AS with_cloud_marker,
       count(*) FILTER (WHERE payload ? 'iv')    AS with_iv,
       count(*) FILTER (WHERE deleted_at IS NULL) AS live
  FROM medication_events;

\echo '=== one payload, first 120 chars ==='
SELECT left(payload::text, 120) FROM medication_events LIMIT 1;

\echo '=== a newer row, in case the shape changed ==='
SELECT left(payload::text, 120) FROM medication_events ORDER BY created_at DESC LIMIT 1;
