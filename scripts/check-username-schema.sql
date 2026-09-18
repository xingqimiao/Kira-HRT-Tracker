-- Acceptance checks for the username-identifier schema (email removed).
-- Plain file, because nesting quotes through several shells produced empty results
-- and two false alarms earlier.

\echo '--- users: username shape, no email column ---'
SELECT
  format_type(a.atttypid, a.atttypmod) AS username_type,
  a.attnotnull AS username_not_null,
  (SELECT count(*) FROM pg_attribute
    WHERE attrelid = 'users'::regclass AND attname = 'email' AND NOT attisdropped) AS email_cols
FROM pg_attribute a
WHERE a.attrelid = 'users'::regclass AND a.attname = 'username';

\echo '--- users: username CHECK constraint present ---'
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'users'::regclass AND contype = 'c' AND conname = 'users_username_shape';

\echo '--- email index removed ---'
SELECT to_regclass('public.idx_users_email_unique') AS should_be_null;

\echo '--- a name longer than 64 is refused by the column ---'
DO $$
BEGIN
  INSERT INTO users (username) VALUES (repeat('a', 65));
  RAISE EXCEPTION 'over-long username was accepted';
EXCEPTION
  WHEN string_data_right_truncation OR check_violation OR numeric_value_out_of_range THEN
    RAISE NOTICE 'over-long username correctly rejected';
END $$;

\echo '--- a blank name is refused ---'
DO $$
BEGIN
  INSERT INTO users (username) VALUES ('   ');
  RAISE EXCEPTION 'blank username was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'blank username correctly rejected';
END $$;

\echo '--- an OAuth-only account is representable: no password, name present ---'
INSERT INTO users (username) VALUES ('oauth_only_probe');
SELECT 'password nullable' AS check, (SELECT password_hash IS NULL FROM users WHERE username = 'oauth_only_probe') AS ok;

\echo '--- a full 64-character name fits ---'
INSERT INTO users (username) VALUES (repeat('b', 64));
SELECT '64 chars accepted' AS check, (SELECT count(*) = 1 FROM users WHERE length(username) = 64) AS ok;

\echo '--- oauth_accounts still intact from the previous migration ---'
SELECT provider, provider_user_id FROM oauth_accounts ORDER BY provider;
