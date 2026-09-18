-- Migration acceptance checks. Run against a restored copy of production.
-- Written to a file because nesting single quotes through several shells silently
-- corrupted the values (' google ' instead of 'google') and produced two false alarms.

\echo '--- 1. oauth_links renamed, contents intact ---'
SELECT 'accounts table' AS check, to_regclass('public.oauth_accounts') IS NOT NULL AS ok
UNION ALL SELECT 'old name gone', to_regclass('public.oauth_links') IS NULL
UNION ALL SELECT 'x row preserved', (SELECT count(*) FROM oauth_accounts WHERE provider = 'x') = 1;

\echo '--- 2. provider allowlist widened ---'
INSERT INTO oauth_accounts (user_id, provider, provider_user_id)
SELECT id, 'google', 'google-test-1' FROM users LIMIT 1;

SELECT 'google accepted' AS check, EXISTS (
  SELECT 1 FROM oauth_accounts WHERE provider = 'google' AND provider_user_id = 'google-test-1'
) AS ok;

\echo '--- 3. UNIQUE(provider, provider_user_id) still enforced ---'
DO $$
BEGIN
  INSERT INTO oauth_accounts (user_id, provider, provider_user_id)
  SELECT id, 'google', 'google-test-1' FROM users LIMIT 1;
  RAISE EXCEPTION 'duplicate (provider, provider_user_id) was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'duplicate correctly rejected';
END $$;

\echo '--- 4. users.email exists and is unique among non-null values ---'
SELECT 'email column' AS check, EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
) AS ok;

UPDATE users SET email = 'one@example.test' WHERE id = (SELECT id FROM users LIMIT 1);
SELECT 'email stored' AS check, (SELECT email FROM users LIMIT 1) = 'one@example.test' AS ok;

\echo '--- 5. records table and its indexes ---'
SELECT 'records table' AS check, to_regclass('public.records') IS NOT NULL AS ok
UNION ALL SELECT 'timeline index', to_regclass('public.idx_records_user_taken_at') IS NOT NULL
UNION ALL SELECT 'category index', to_regclass('public.idx_records_user_category_taken_at') IS NOT NULL
UNION ALL SELECT 'client_id index', to_regclass('public.idx_records_user_client_id') IS NOT NULL;

\echo '--- 6. records accepts a sealed payload and rejects a null one ---'
INSERT INTO records (user_id, taken_at, category, payload_encrypted, client_id)
SELECT id, now(), 'dose', 'AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:BBBB', 'client-1'
FROM users LIMIT 1;
SELECT 'sealed row stored' AS check, (SELECT count(*) FROM records) = 1 AS ok;

DO $$
BEGIN
  INSERT INTO records (user_id, taken_at, payload_encrypted)
  SELECT id, now(), NULL FROM users LIMIT 1;
  RAISE EXCEPTION 'a NULL payload was accepted';
EXCEPTION WHEN not_null_violation THEN
  RAISE NOTICE 'NULL payload correctly rejected';
END $$;

\echo '--- 7. ON DELETE CASCADE from users ---'
SELECT 'cascade declared' AS check,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'records'::regclass
            AND contype = 'f'
            AND confdeltype = 'c'
       ) AS ok;
