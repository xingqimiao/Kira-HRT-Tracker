-- Application Core schema.
--
-- Two deliberate choices worth knowing before reading the tables:
--
-- 1. Health records are stored as ciphertext. A `medication_events` row cannot be
--    read without the user's DEK, which exists server-side only while that user
--    has an active unlock (see src/session.ts). That rules out SQL-level reporting
--    or analytics over doses — a cost accepted on purpose, because the product's
--    privacy claim is the thing being protected.
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
--   `totp_secret_sealed` is the TOTP secret encrypted under a key held only in
--   the environment (`TOTP_ENC_KEY`), not in this database. A dump that carried
--   secrets in the clear would quietly switch off the second factor for every
--   account, which is strictly worse than not offering 2FA at all.
--
--   `totp_last_step` is the highest TOTP step already spent. A code is valid for
--   its whole 30-second step (90 with drift), so without this an observed code
--   could be replayed inside that window. Requiring a strictly higher step makes
--   each code single-use.
--
--   `failed_unlocks` / `locked_until` throttle password guessing per account.
CREATE TABLE IF NOT EXISTS users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username            text NOT NULL UNIQUE,
    display_name        text,
    password_hash       text,
    password_set_at     timestamptz,
    wrapped_dek         jsonb,
    totp_secret_sealed  text,
    totp_enabled_at     timestamptz,
    totp_last_step      bigint,
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_sealed text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at    timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step     bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_unlocks     integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until       timestamptz;
-- Password became optional for X-created accounts.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
-- The pre-encryption column, if it exists, is left in place but unused: dropping
-- a column that might hold the only copy of someone's 2FA secret is not a
-- migration this file should perform unattended.

-- Two data-security modes, and a versioned home for the key wrappers.
--
-- `privacy_mode` is an explicit column, not something inferred from which wrappers
-- happen to exist. Guessing the mode from `hasPassword`/`hasRecovery`-style flags
-- makes it silently flip when a wrapper is added or removed; the mode is a stated
-- product choice, so it is stored as one.
--
-- `encryption_metadata` is versioned jsonb so a future wrapper (passkey, a new KDF,
-- a new algorithm) is a data change rather than a table change. Its shape:
--   { version, dek: {alg, createdAt},
--     wrappers: { password?, server?, recovery?, passkey? } }
-- Every wrapper is the same {cloud:1,iv,data} AES-GCM envelope as a cloud backup,
-- so the browser and the server agree on the format by construction. `version` is
-- explicit for the same reason `privacy_mode` is: the format of this document must
-- never be guessed from which fields are present.
--
--   standard: wrappers.password + wrappers.server   (the server can self-unlock)
--   advanced: wrappers.password + wrappers.recovery  (it cannot)
--
-- `wrapped_dek` is kept in step with `wrappers.password`: it is what existing rows
-- hold and what the previous release reads, so this file neither drops it nor
-- rewrites rows that already carry a metadata document.
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_mode        text NOT NULL DEFAULT 'standard';
ALTER TABLE users ADD COLUMN IF NOT EXISTS encryption_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
-- No `ADD CONSTRAINT IF NOT EXISTS` in Postgres, so the check is guarded by hand to
-- keep this file re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_privacy_mode_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_privacy_mode_check
      CHECK (privacy_mode IN ('standard', 'advanced'));
  END IF;
END $$;
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

-- Passkeys (WebAuthn credentials).
--
-- One row per registered credential. `public_key` is the COSE key the authenticator
-- issued at registration, and it is what every later assertion is verified against —
-- so this column is *not* secret, and it cannot create a key: the row alone opens
-- nothing. `credential_id` is the browser-facing handle and is the lookup key for a
-- discoverable sign-in, where the server does not know who is signing in until the
-- assertion names the credential.
--
-- `sign_count` is the authenticator's monotonic counter. It is nullable and its
-- usefulness is genuinely limited — passkeys that sync between devices (iCloud
-- Keychain, Google Password Manager) report a constant 0, so a non-increase means
-- nothing there. It is recorded because some authenticators do report it and a
-- decrease is a real cloning signal; the check is "refuse a *decrease*", never
-- "require an increase".
--
-- The data-key wrapper for this credential lives in `users.encryption_metadata`
-- (`wrappers.passkeys[credential_id]`), not here. Key material stays in one document
-- so a mode switch rewraps in one place.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    credential_id   text PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key      bytea NOT NULL,
    sign_count      bigint NOT NULL DEFAULT 0,
    transports      text,
    device_type     text,
    backed_up       boolean NOT NULL DEFAULT false,
    name            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);
-- One credential id maps to one account. The primary key enforces it; this index
-- exists because the discoverable-sign-in path looks the row up by id before it has
-- any user context, which is the primary key's job, so no second index is needed.

-- In-flight WebAuthn challenges.
--
-- A challenge is a single-use nonce: the server mints one, the authenticator signs it,
-- and the server refuses anything it did not just issue. It lives in a table rather
-- than in process memory because a ceremony can start on one instance and finish on
-- another — `webauthn.ts` kept these in a `Map` first, which works on exactly one
-- instance and then fails *sometimes*, the kind of failure that gets blamed on the
-- user's authenticator. A row also outlives a restart, so deploying between "tap to
-- add" and "tap to confirm" no longer discards the attempt.
--
-- `user_id` is nullable on purpose: a discoverable sign-in has no account yet, so its
-- challenge is minted ownerless and the credential naming the account afterwards. The
-- row is deleted the moment it is consumed, which is the replay guard; `expires_at` is
-- checked on read, so a lapsed challenge is refused even if no sweep has run.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
    challenge   text PRIMARY KEY,
    user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);

-- Recovery codes for the second factor. Hashed with scrypt, not stored
-- reversibly: each code bypasses 2FA, so the set is equivalent to ten spare
-- passwords and deserves the same treatment. `used_at` enforces single use.
CREATE TABLE IF NOT EXISTS totp_backup_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash   text NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_totp_backup_codes_user
    ON totp_backup_codes(user_id) WHERE used_at IS NULL;

-- A linked external identity. One row per (provider, external account), so the
-- same X account cannot be attached to two users, and one user can rebind to a
-- different X account only after unlinking the old one.
--
-- `provider_user_id` is X's immutable numeric id, never the @handle: handles are
-- changeable and can be released and re-registered by someone else, so keying a
-- login on one would let a handle change transfer access.
CREATE TABLE IF NOT EXISTS oauth_links (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          text NOT NULL CHECK (provider IN ('x')),
    provider_user_id  text NOT NULL,
    handle            text,
    -- The provider's avatar, captured when the link is made or used, so the account
    -- page can show it without calling X on every render. Cosmetic: null just means
    -- no picture, which is why nothing here depends on it being present.
    avatar_url        text,
    linked_at         timestamptz NOT NULL DEFAULT now(),
    last_login_at     timestamptz,
    UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_links_user ON oauth_links(user_id);
-- Added after the first release, so a database created by that revision needs it too.
ALTER TABLE oauth_links ADD COLUMN IF NOT EXISTS avatar_url text;

-- In-flight OAuth authorizations, keyed by the `state` value.
--
-- Server-side rather than a signed cookie because the PKCE `code_verifier` must
-- be stored somewhere and must not reach the browser: the verifier is what stops
-- an intercepted authorization code from being redeemed by whoever intercepted
-- it. Single-use, short-lived, and consumed on the callback.
CREATE TABLE IF NOT EXISTS oauth_states (
    state           text PRIMARY KEY,
    code_verifier   text NOT NULL,
    purpose         text NOT NULL CHECK (purpose IN ('login','link')),
    -- Set for 'link': the account this authorization will be attached to.
    user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

-- ---------------------------------------------------------------------------
-- Health records — encrypted at rest
-- ---------------------------------------------------------------------------
-- Record ids are `text`, not `uuid`, because the domain treats them as opaque
-- client-supplied strings: the app generates uuid v4 in practice but accepts any
-- string id on import (`typeof item.id === 'string' ? item.id : uuidv4()`), and
-- hand-written exports in the wild carry ids like `dose-2024-01-01`. Declaring
-- them `uuid` adds a constraint the model never had and rejects real history on
-- import. The length bound is the actual thing worth enforcing.
--
-- The primary key is (user_id, id), NOT id alone. Ids are client-generated, so
-- nothing guarantees they are unique across accounts — and importing the same
-- export into two accounts (a shared routine, a re-test) is legitimate. A global
-- id key made the second import fail with a duplicate-key error, which is a
-- constraint the domain never asked for. Record identity is scoped to its owner.
--
-- `payload` is an AES-GCM envelope: {"cloud":1,"iv":...,"data":...} holding the
-- plaintext record. `version` implements optimistic locking, so two clients
-- editing the same record cannot silently clobber each other — the loser gets a
-- conflict and re-reads, rather than losing a dose entry.
--
-- `occurred_at` is duplicated out of the ciphertext in the clear, on purpose:
-- the server needs to order and range-filter a timeline, and a timestamp alone
-- leaks far less than the record it belongs to. `user_id` is likewise cleartext
-- by necessity (see ARCHITECTURE.md).
CREATE TABLE IF NOT EXISTS medication_events (
    id              text NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, id),
    occurred_at     timestamptz NOT NULL,
    payload         jsonb NOT NULL,
    version         integer NOT NULL DEFAULT 1,
    deleted_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Timeline reads filter by user and order by time; this serves them from the
-- index with no sort step.
CREATE INDEX IF NOT EXISTS idx_medication_events_user_time
    ON medication_events(user_id, occurred_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS lab_results (
    id              text NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, id),
    occurred_at     timestamptz NOT NULL,
    payload         jsonb NOT NULL,
    version         integer NOT NULL DEFAULT 1,
    deleted_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lab_results_user_time
    ON lab_results(user_id, occurred_at DESC)
    WHERE deleted_at IS NULL;

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
