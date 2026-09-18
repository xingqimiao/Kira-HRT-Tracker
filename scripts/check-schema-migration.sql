-- Migration acceptance checks. Run against a restored copy of production.
-- Written to a file because nesting single quotes through several shells silently
-- corrupted the values (' google ' instead of 'google') and produced two false alarms.
--
-- Rewritten when the account name replaced the email column and records became a
-- sealed-payload store: the old version asserted `users.email` exists and that
-- `records` has a `client_id`, both of which the schema now deliberately removes, so
-- it would have failed for the right reason and been read as the wrong one.

\echo '--- 1. oauth_links renamed, contents intact ---'
SELECT 'accounts table' AS check, to_regclass('public.oauth_accounts') IS NOT NULL AS ok
UNION ALL SELECT 'old name gone', to_regclass('public.oauth_links') IS NULL;

\echo '--- 2. the account name is the login identifier, and email is gone ---'
SELECT 'username column' AS check, EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users'
     AND column_name = 'username' AND character_maximum_length = 64
) AS ok
UNION ALL SELECT 'email column dropped', NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
)
UNION ALL SELECT 'username shape enforced', EXISTS (
  SELECT 1 FROM pg_constraint
   WHERE conrelid = 'users'::regclass AND conname = 'users_username_shape'
);

\echo '--- 3. provider allowlist widened to x and google ---'
-- The insert is the test: before the constraint was widened this failed with
-- `oauth_accounts_provider_check`, not with a clear error from the app.
INSERT INTO oauth_accounts (user_id, provider, provider_user_id)
SELECT id, 'google', 'google-test-1' FROM users LIMIT 1;

SELECT 'google accepted' AS check, EXISTS (
  SELECT 1 FROM oauth_accounts WHERE provider = 'google' AND provider_user_id = 'google-test-1'
) AS ok;

\echo '--- 4. UNIQUE(provider, provider_user_id) still enforced ---'
DO $$
BEGIN
  INSERT INTO oauth_accounts (user_id, provider, provider_user_id)
  SELECT id, 'google', 'google-test-1' FROM users LIMIT 1;
  RAISE EXCEPTION 'duplicate (provider, provider_user_id) was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'duplicate correctly rejected';
END $$;

\echo '--- 5. records table, its indexes, and its key type ---'
SELECT 'records table' AS check, to_regclass('public.records') IS NOT NULL AS ok
UNION ALL SELECT 'timeline index', to_regclass('public.idx_records_user_taken_at') IS NOT NULL
UNION ALL SELECT 'category index', to_regclass('public.idx_records_user_category_taken_at') IS NOT NULL
-- The ids are minted by the client as `dose:transfem:<id>`, so a uuid column would
-- reject every real payload; this asserts the type that makes that work.
UNION ALL SELECT 'client-minted text id', (
  SELECT data_type = 'text' FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'records' AND column_name = 'id'
)
-- Superseded by the id itself once the client started minting it, and two conflict
-- targets that disagree is worse than one.
UNION ALL SELECT 'client_id column gone', NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'records' AND column_name = 'client_id'
);

\echo '--- 6. records accepts a sealed payload and rejects a null one ---'
INSERT INTO records (user_id, taken_at, category, payload_encrypted, id)
SELECT id, now(), 'dose', 'AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:BBBB', 'dose:transfem:migration-check'
FROM users LIMIT 1;

SELECT 'sealed row stored' AS check, EXISTS (
  SELECT 1 FROM records WHERE id = 'dose:transfem:migration-check'
) AS ok;

DO $$
BEGIN
  INSERT INTO records (user_id, taken_at, payload_encrypted, id)
  SELECT id, now(), NULL, 'dose:transfem:null-check' FROM users LIMIT 1;
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

\echo '--- 8. the second factor is gone, columns and table alike ---'
-- This used to assert the three `totp_*` columns were *nullable*, which was the
-- weaker claim that let an older release keep working mid-migration. They are now
-- dropped outright along with `totp_backup_codes`, so the check is absence: a
-- column that came back would mean schema.sql stopped carrying the DROP.
SELECT 'totp columns dropped' AS check, NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name LIKE 'totp%'
) AS ok
UNION ALL SELECT 'totp_backup_codes dropped', to_regclass('public.totp_backup_codes') IS NULL;

-- Clean up the rows this file inserted, so re-running it is not a surprise later.
DELETE FROM records WHERE id IN ('dose:transfem:migration-check', 'dose:transfem:null-check');
DELETE FROM oauth_accounts WHERE provider_user_id = 'google-test-1';
