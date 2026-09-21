-- Application Core schema.
--
-- Two deliberate choices worth knowing before reading the tables:
--
-- 1. Health records are stored as ciphertext. A `records` row holds one sealed
--    AES-256-GCM payload; only `user_id`, `taken_at` and `category` are readable, so
--    the timeline can be ordered and paged without decrypting every row. That rules
--    out SQL-level reporting or analytics over doses — a cost accepted on purpose.
--
--    Each payload is sealed under its own account's DEK, not one deployment-wide key,
--    so a single leaked account key opens one history rather than the whole table. (A
--    `v1` row sealed under the old `ENCRYPTION_KEY` is still read; see the records
--    section below.)
--
--    Do not read that as "the operator cannot see the data", which is what an earlier
--    version of this comment implied. The server decrypts on read, and every account's
--    DEK is *also* wrapped under `SERVER_DEK_KEY`, so it can be opened with no live
--    unlock at all. The honest bound is narrower: a stolen database dump is unreadable
--    on its own. See `payloadCrypto.ts` and `docs/auth-design.md` §5.
--
-- 2. Loose JSON is a `jsonb` column, not shredded into columns. The domain model
--    in logic.ts (`DoseEvent.extras` varies per route and ester) is already
--    shaped that way, and mirroring it in DDL would mean a migration per PK
--    field. Row-level columns are reserved for what the server must query,
--    index, or enforce uniqueness on.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
-- `wrapped_dek` is the user's data key, encrypted under a key derived from their
-- password. The server can store it and hand it back; it cannot open it. A null
-- value means an account created before it had a key and cannot store records
-- until a password is set.
-- Authentication shape, and the reason for each nullable column:
--
--   `password_hash` is NULLABLE because an account can be created through X
--   OAuth. Such an account is deliberately *not usable* until a password is set:
--   the data key is wrapped under a password-derived key, so with no password
--   there is no key and no records can be written. `password_set_at` records that
--   transition, and an X-created account cannot read or write anything until it
--   is set. That is the whole answer to "what if the X account gets banned" —
--   losing X costs the convenience of one login button, never the data.
--
--   `failed_unlocks` / `locked_until` throttle password guessing per account.
--
--   There is no second factor. TOTP and its recovery codes were removed, and the
--   three columns and the `totp_backup_codes` table that held them are dropped
--   below rather than left to rot: nothing reads them, and a sealed secret whose
--   key (`TOTP_ENC_KEY`) is no longer required by the environment is unreadable
--   anyway.
CREATE TABLE IF NOT EXISTS users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The login identifier: a self-chosen account name, NOT an email address.
    --
    -- Required for an account that signs in with a password. An account created
    -- through X or Google is still given one at signup (generated from the handle, so
    -- it has something to show and can be renamed later) — see the note on
    -- `password_hash` below for why a social-only account is never left unusable.
    --
    -- There is no verification mail and no address-recovery flow by design: nothing
    -- here should let a mail provider become the gate on someone's medication history.
    -- 64 is the storage ceiling; the application is stricter (3–30, letters, digits,
    -- underscore, hyphen), and both exist so the database cannot hold a name no
    -- validation would ever have produced.
    username            varchar(64) NOT NULL UNIQUE,
    display_name        text,
    password_hash       text,
    password_set_at     timestamptz,
    wrapped_dek         jsonb,
    failed_unlocks      integer NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Bring a database created by an earlier revision up to the shape above.
-- `CREATE TABLE IF NOT EXISTS` cannot add columns to a table that already exists,
-- so an already-migrated development database would otherwise keep the old shape
-- and fail at runtime instead of at migration time. Each line is a no-op when the
-- column is already present.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name       text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at    timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_unlocks     integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until       timestamptz;
-- Password became optional for X-created accounts.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Second factor removal. Deliberately a DROP and not a "leave it, it is harmless":
-- three nullable columns nobody reads are exactly the kind of residue that a later
-- revision starts writing to again, and `totp_secret_sealed` is ciphertext whose key
-- is no longer a required variable, so it can never be read even if something wanted
-- to. `DROP COLUMN IF EXISTS` keeps this file re-runnable.
ALTER TABLE users DROP COLUMN IF EXISTS totp_secret_sealed;
ALTER TABLE users DROP COLUMN IF EXISTS totp_enabled_at;
ALTER TABLE users DROP COLUMN IF EXISTS totp_last_step;
DROP TABLE IF EXISTS totp_backup_codes;

-- `username` is the login identifier, so its width and non-emptiness are enforced by
-- the database and not only by the request validator. Widen from `text` to
-- `varchar(64)` (a no-op for existing rows) and refuse a blank name — an account
-- whose identifier is the empty string can be created but never signed into.
ALTER TABLE users ALTER COLUMN username TYPE varchar(64);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_shape;
ALTER TABLE users ADD CONSTRAINT users_username_shape
    CHECK (username = btrim(username) AND length(username) BETWEEN 1 AND 64);

-- A previous revision added an `email` column here. Removed on purpose: the product
-- signs people in with a self-chosen account name, and carrying a second, half-used
-- identity column invites code to start depending on it. Dropped unconditionally —
-- it is only ever added by that one revision, and no code has ever written to it.
ALTER TABLE users DROP COLUMN IF EXISTS email;
DROP INDEX IF EXISTS idx_users_email_unique;
-- The pre-encryption column, if it exists, is left in place but unused: dropping
-- a column that might hold the only copy of someone's 2FA secret is not a
-- migration this file should perform unattended.

-- A versioned home for the account's key wrappers.
--
-- `encryption_metadata` is versioned jsonb so a future wrapper (a new KDF, a new
-- algorithm) is a data change rather than a table change. Its shape:
--   { version, dek: {alg, createdAt},
--     wrappers: { password?, server? } }
-- Every wrapper is the same {cloud:1,iv,data} AES-GCM envelope as a cloud backup, so
-- the browser and the server agree on the format by construction. `version` is
-- explicit because the format of this document must never be guessed from which
-- fields are present.
--
-- There is one arrangement now. There used to be a `privacy_mode` column choosing
-- between a `standard` account (wrappers.password + wrappers.server — the server can
-- self-unlock) and an `advanced` one (wrappers.password only — it cannot). That
-- choice was a leftover of the zero-knowledge design this service abandoned, and it
-- is gone: every account carries the server wrapper, so the server can always open
-- the records it stores. The honest bound is the one `payloadCrypto.ts` states —
-- a stolen database dump is unreadable without `ENCRYPTION_KEY`.
--
-- `wrapped_dek` is kept in step with `wrappers.password`: it is what existing rows
-- hold and what the previous release reads, so this file neither drops it nor
-- rewrites rows that already carry a metadata document.
ALTER TABLE users ADD COLUMN IF NOT EXISTS encryption_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
-- The column and its check go unconditionally. Nothing reads or writes either any
-- more, so leaving them would only preserve a second, contradictory statement of how
-- an account's key is protected — which is exactly the residue a later change reads
-- again by mistake. `DROP COLUMN IF EXISTS` keeps this file re-runnable.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_privacy_mode_check;
ALTER TABLE users DROP COLUMN IF EXISTS privacy_mode;
-- Backfill: lift the existing password wrapper into the new document, exactly once
-- per row. Rows that already have a document (written by this release) are left
-- alone, so re-running the file changes nothing.
UPDATE users
   SET encryption_metadata = jsonb_build_object(
         'version', 2,
         'wrappers', jsonb_build_object('password', wrapped_dek)
       )
 WHERE wrapped_dek IS NOT NULL
   AND (encryption_metadata IS NULL OR encryption_metadata = '{}'::jsonb);

-- Tokens MCP clients and the web app present. Separate from the password so a
-- leaked agent token can be revoked without a password change.
CREATE TABLE IF NOT EXISTS api_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            text NOT NULL,
    token_hash      text NOT NULL UNIQUE,
    last_used_at    timestamptz,
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- Browser logins. Durable on purpose: the product promise is that the server does not
-- sign anyone out, and a session held only in process memory dropped every user on
-- every restart — a logout nobody chose. The row holds **no key**: a record is opened
-- from the account's own server wrapper when a request needs it, so this table answers
-- "which browser is this" and can be ended one row at a time from the device list.
--
--   `token_hash` is SHA-256 of the bearer token, the same treatment `api_tokens` gets,
--   so a dump of this table is not a set of usable logins.
--
--   `persistent` is the reader's "keep me signed in". Those rows have
--   `expires_at IS NULL` forever; every other row keeps the deployment's sliding idle
--   window and is signed out by it.
CREATE TABLE IF NOT EXISTS sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    text NOT NULL UNIQUE,
    persistent    boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,
    user_agent    text,
    ip            text
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Passkeys used to live here: `webauthn_credentials` (one row per registered
-- credential, with its COSE public key and sign counter) and `webauthn_challenges`
-- (single-use ceremony nonces). Both are gone with the feature.
--
-- The feature was not merely unused. A passkey here was built to protect the data key
-- — `users.encryption_metadata` carried a `wrappers.passkeys[credential_id]` entry,
-- and the KEK came from the authenticator's WebAuthn PRF output. That is the
-- zero-knowledge design this service abandoned when it moved to a hosted model where
-- the server holds `ENCRYPTION_KEY`, and a passkey that no longer guards the key would
-- be a button claiming to do something it does not. Dropped rather than left inert.
DROP TABLE IF EXISTS webauthn_credentials;
DROP TABLE IF EXISTS webauthn_challenges;

-- Recovery codes for the second factor. Hashed with scrypt, not stored
-- reversibly: each code bypasses 2FA, so the set is equivalent to ten spare
-- passwords and deserves the same treatment. `used_at` enforces single use.
-- A linked external identity. One row per (provider, external account), so the same
-- X or Google account cannot be attached to two users, and one user can rebind to a
-- different external account only after unlinking the old one.
--
-- ── Why this table is the anti-ban insurance ──────────────────────────────────
-- Identity and credentials are deliberately decoupled: `users` holds the account and
-- its optional password, this table holds *how else* you can get in. So a social
-- account being banned, deleted, or having its API credentials revoked costs the user
-- one button on the sign-in screen — never their medication history. They fall back to
-- the account name and password they set while the social login still worked.
--
-- `provider_user_id` is the provider's immutable id, never the @handle: handles are
-- changeable and can be released and re-registered by someone else, so keying a login
-- on one would let a handle change transfer access.
-- ── Create-or-rename, never both ──────────────────────────────────────────────
--
-- This has to be one conditional block rather than a `CREATE TABLE IF NOT EXISTS`
-- followed by a rename. Written the obvious way, a database that still has
-- `oauth_links` gets a *new empty* `oauth_accounts` from the CREATE, which then makes
-- the rename's "target does not exist" guard false — so the real rows stay behind in
-- the old table and every existing social login is silently orphaned. Found by running
-- this file against a restored copy of production; the naive version did exactly that.
DO $$
BEGIN
  IF to_regclass('public.oauth_accounts') IS NULL
     AND to_regclass('public.oauth_links') IS NOT NULL THEN
    -- Older database: take the table, and its contents, over to the current name.
    ALTER TABLE oauth_links RENAME TO oauth_accounts;
    ALTER INDEX IF EXISTS idx_oauth_links_user RENAME TO idx_oauth_accounts_user;
  ELSIF to_regclass('public.oauth_accounts') IS NULL THEN
    -- Fresh database: create it in the current shape.
    CREATE TABLE oauth_accounts (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider          varchar(32) NOT NULL,
      provider_user_id  varchar(255) NOT NULL,
      handle            text,
      avatar_url        text,
      linked_at         timestamptz NOT NULL DEFAULT now(),
      last_login_at     timestamptz,
      UNIQUE (provider, provider_user_id)
    );
    CREATE INDEX idx_oauth_accounts_user ON oauth_accounts(user_id);
  END IF;

  -- Only present on tables that predate the column.
  IF to_regclass('public.oauth_accounts') IS NOT NULL THEN
    ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS avatar_url text;
  END IF;
END $$;

-- Widen the provider allowlist. The original constraint admitted only 'x', which would
-- make a Google link fail at insert time with a constraint error rather than a clear
-- "unsupported provider" — the app-level check gives the better message, but the
-- database should not be the thing that decides which providers exist.
ALTER TABLE oauth_accounts DROP CONSTRAINT IF EXISTS oauth_links_provider_check;
ALTER TABLE oauth_accounts DROP CONSTRAINT IF EXISTS oauth_accounts_provider_check;
ALTER TABLE oauth_accounts ADD CONSTRAINT oauth_accounts_provider_check
    CHECK (provider IN ('x', 'google'));
-- In-flight OAuth authorizations, keyed by the `state` value.
--
-- Server-side rather than a signed cookie because the PKCE `code_verifier` must
-- be stored somewhere and must not reach the browser: the verifier is what stops
-- an intercepted authorization code from being redeemed by whoever intercepted
-- it. Single-use, short-lived, and consumed on the callback.
CREATE TABLE IF NOT EXISTS oauth_states (
    state           text PRIMARY KEY,
    code_verifier   text,
    purpose         text NOT NULL CHECK (purpose IN ('login','link')),
    -- Which provider this authorization belongs to. The callback needs it: the state is
    -- the only thing the provider echoes back, so without this column a state minted for
    -- Google would be redeemed against X's token endpoint.
    provider        varchar(32) NOT NULL DEFAULT 'x',
    -- Set for 'link': the account this authorization will be attached to.
    user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
-- Bring a database created by an earlier revision up to the shape above.
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS provider varchar(32) NOT NULL DEFAULT 'x';
-- Google has no PKCE, so its rows carry no verifier. X's path still sets one.
ALTER TABLE oauth_states ALTER COLUMN code_verifier DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Health records — encrypted at rest
-- ---------------------------------------------------------------------------
-- Two tables used to live here: `medication_events` and `lab_results`, each a
-- per-event row with its own AES-GCM envelope in a `jsonb` column, a `version` for
-- optimistic locking and a `deleted_at` for soft deletion. They were replaced by the
-- single `records` table further down, which stores one sealed payload per record and
-- is what the app, the export and MCP all read and write now.
--
-- They are dropped rather than left in place. Nothing has written to them since the
-- store moved, so leaving them would only preserve a second, contradictory description
-- of where a dose lives — which is the sort of thing a later change starts reading
-- again by mistake. `DROP TABLE IF EXISTS` keeps this file re-runnable, and the
-- `CASCADE` is not needed: their only foreign key was to `users`, which still exists.
DROP TABLE IF EXISTS medication_events;
DROP TABLE IF EXISTS lab_results;

-- Per-user model settings: body weight, active HRT mode, PK parameter overrides,
-- calibration method. One row per user — the settings a simulation cannot run
-- without, which is why they are not folded into the event stream.
CREATE TABLE IF NOT EXISTS user_settings (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    body_weight_kg      numeric(6,2),
    hrt_mode            text NOT NULL DEFAULT 'transfem'
                        CHECK (hrt_mode IN ('transfem','transmasc')),
    calibration_method  text NOT NULL DEFAULT 'mipd'
                        CHECK (calibration_method IN ('off','ekf','ou_kalman','mipd')),
    calibration_history text NOT NULL DEFAULT 'retrospective'
                        CHECK (calibration_history IN ('forward','retrospective')),
    pk_params           jsonb,
    timezone            text,
    -- App-only collections that are not clinical records and that no agent has a
    -- use for: dose templates and quick-dose buttons the web UI remembers. They
    -- still have to survive a sync, or switching devices loses them, but giving
    -- each its own table would put UI conveniences in the domain schema. One opaque
    -- blob keeps them syncable without pretending they are records.
    app_state           jsonb,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- A record that an account was deleted, deliberately carrying no identifier.
--
-- Deleting an account cascades away every row that names it, which is what makes the
-- deletion promise in the Privacy Policy true. But an operator still needs to be able
-- to answer basic questions: are accounts being deleted in bulk (abuse, or a bug),
-- and how long do people stay. Those are answerable from counts and timestamps alone.
--
-- `user_created_at` is the one field that is arguably identifying, and it is kept
-- because "how long after signing up do people leave" is the useful signal. It is a
-- timestamp at minute granularity with no account attached — write it rounded if you
-- want to be stricter. There is no username, no id, and no IP, so the row cannot be
-- tied back to a person or joined to anything.
CREATE TABLE IF NOT EXISTS deletion_log (
    id               bigserial PRIMARY KEY,
    reason           text NOT NULL,
    user_created_at  timestamptz,
    deleted_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deletion_log_deleted_at ON deletion_log(deleted_at);
CREATE INDEX IF NOT EXISTS idx_deletion_log_reason ON deletion_log(reason);
-- Records that an unlock happened, not what was read. Deliberately no record
-- contents, since the server cannot read them anyway.
--
-- These rows are removed when an account is deleted, rather than kept with a nulled
-- `user_id`. They carry an IP address, which is personal data, and the whole point of
-- deletion is that nothing linkable survives. The aggregate fact of the deletion is
-- preserved in `deletion_log` without identifiers.
CREATE TABLE IF NOT EXISTS auth_events (
    id          bigserial PRIMARY KEY,
    user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    kind        text NOT NULL,
    ip          inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_events_user_time ON auth_events(user_id, created_at DESC);

-- Read-only share links. The whole point of the feature is to show a dosage history to
-- someone who has no account, so the design decisions that matter are about what the
-- row does *not* contain.
--
-- `token_hash`, not the token: the link is the credential, and a database dump should
-- not hand over working links. It is a hash rather than an encrypted value because the
-- server never needs to show the link again — the user keeps the URL.
--
-- `snapshot` holds only what the sharer chose to publish: the dose events and the
-- modelled curve. No lab results, no weight, no profile. That is enforced where the
-- snapshot is built and by a test on this table's shape, because a column that could
-- hold a lab value is a column that eventually will.
--
-- `password_hash` is scrypt, the same treatment as a login password, since a share
-- password guards health data in exactly the same way.
--
-- `expires_at` is NOT NULL: a link that never dies is a disclosure waiting to happen,
-- and the UI always sets a window. Expiry is checked on read rather than by a sweeper,
-- so a lapsed link is refused even if no cleanup has run.
CREATE TABLE IF NOT EXISTS shares (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash       text NOT NULL UNIQUE,
    password_hash    text,
    live             boolean NOT NULL DEFAULT false,
    snapshot         jsonb NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
-- Expiry is per-row and short, so the token hash is the only lookup that needs help.
-- The unique constraint above already serves it.

-- ---------------------------------------------------------------------------
-- Records — the encrypted business payload
-- ---------------------------------------------------------------------------
--
-- One row per dose / lab result / note. What the server may look at is deliberate
-- and small: *who*, *when*, and a coarse *category*, which is what pagination and
-- retention need. Everything a person typed — medication name, dose, lab values,
-- free-text notes — is JSON, sealed as one AES-256-GCM blob in `payload_encrypted`.
--
-- Per-field encryption was rejected on purpose: it would leak the shape of every
-- record (which fields exist, how many of each) while buying nothing, because the
-- same process holds the key either way. One blob per record leaks nothing but size.
--
-- Each blob is sealed under its own account's DEK, so one leaked account key opens one
-- history. This is encryption at rest, NOT end-to-end: the server decrypts on read,
-- because it is the API that answers, and every DEK is also wrapped under
-- `SERVER_DEK_KEY`. The honest claim is "a stolen database dump is useless without an
-- account's data key", and that is all this table is designed to deliver.
--
--   `taken_at` is plaintext because the timeline is ordered and paged by it. It is a
--   real privacy cost — the server learns when someone doses — and it is the price of
--   not pulling the entire history to the client to sort it there.
--
--   `payload_encrypted` is TEXT holding either "v2:iv:tag:ciphertext" (sealed under the
--   account's DEK) or the untagged "iv:tag:ciphertext" written before this change
--   (sealed under the old deployment-wide `ENCRYPTION_KEY`, still readable). See
--   src/payloadCrypto.ts. TEXT rather than bytea so the column is readable in a psql
--   session during an incident, at a 33% storage cost.
CREATE TABLE IF NOT EXISTS records (
    -- TEXT, not uuid: the id is minted by the client, and the client's ids are
    -- human-readable and structured (`dose:transfem:<id>`), which is what makes a
    -- retried write idempotent and a record traceable back to what it holds. A uuid
    -- column would reject every one of them at insert time.
    id                 text PRIMARY KEY,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    taken_at           timestamptz NOT NULL,
    category           varchar(32) NOT NULL DEFAULT 'dose',
    payload_encrypted  text NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The timeline query: one user's records, newest first, paged. Descending to match
-- the read, so the index serves the order with no sort step.
CREATE INDEX IF NOT EXISTS idx_records_user_taken_at
    ON records(user_id, taken_at DESC);

-- Category filtering (the lab list vs the dose list) alongside the same ordering.
CREATE INDEX IF NOT EXISTS idx_records_user_category_taken_at
    ON records(user_id, category, taken_at DESC);

-- A previous revision carried a separate `client_id` for idempotent pushes. The id is
-- chosen by the client, so it already is that identity; keeping both meant a re-sync
-- hit the primary key while the client-id constraint pointed somewhere else, and every
-- second sync failed.
DROP INDEX IF EXISTS idx_records_user_client_id;
ALTER TABLE records DROP COLUMN IF EXISTS client_id;

-- `records.id` was `uuid` in the revision that introduced the table. The client's ids
-- are structured strings (`dose:transfem:<id>`), so every write failed with "invalid
-- input syntax for type uuid" until this widens the column. Existing values were uuids,
-- which are valid text, so the cast is lossless.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'records'
       AND column_name = 'id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE records ALTER COLUMN id TYPE text USING id::text;
    ALTER TABLE records ALTER COLUMN id DROP DEFAULT;
  END IF;
END $$;
