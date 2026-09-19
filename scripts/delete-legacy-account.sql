-- Delete the one legacy account, mirroring what the app's own deletion path does.
--
-- The account is the last one left and it is the operator's test account, not a real
-- user's. It is also the only account in the database whose key material predates the
-- server wrapper, so it is the one account that could still land in the `locked` state
-- the removal was meant to eliminate.
--
-- Order matters twice:
--   1. `auth_events` has a foreign key with ON DELETE SET NULL, not CASCADE, so those
--      rows would survive as orphans pointing at nobody. `deleteAccount` deletes them
--      explicitly for the same reason, and so does this.
--   2. The tombstone is written before the row goes, and it carries no identifier —
--      only a reason and the account's creation time — which is what lets the public
--      deletion count stay honest without keeping anything about who was deleted.
\set ON_ERROR_STOP on

BEGIN;

SELECT 'before: users=' || (SELECT count(*) FROM users)
    || ' oauth=' || (SELECT count(*) FROM oauth_accounts)
    || ' auth_events=' || (SELECT count(*) FROM auth_events)
    || ' settings=' || (SELECT count(*) FROM user_settings);

DO $$
DECLARE
  target uuid;
  created timestamptz;
BEGIN
  SELECT id, created_at INTO target, created FROM users WHERE username = 'kiramyao';
  IF target IS NULL THEN
    RAISE NOTICE 'no such account; nothing to do';
    RETURN;
  END IF;

  DELETE FROM auth_events WHERE user_id = target;
  INSERT INTO deletion_log (reason, user_created_at) VALUES ('admin', created);
  DELETE FROM users WHERE id = target;
END $$;

SELECT 'after: users=' || (SELECT count(*) FROM users)
    || ' oauth=' || (SELECT count(*) FROM oauth_accounts)
    || ' auth_events=' || (SELECT count(*) FROM auth_events)
    || ' settings=' || (SELECT count(*) FROM user_settings)
    || ' orphan_auth_events=' || (SELECT count(*) FROM auth_events WHERE user_id IS NULL)
    || ' deletion_log=' || (SELECT count(*) FROM deletion_log);

COMMIT;
