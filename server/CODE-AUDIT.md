# Code audit — where each policy claim is verified

Internal document. Not part of the published policy, and not written for users: they
cannot check file paths, so a claim that cites one is a claim they must take on trust.

This exists for one job: confirming a claim against the code *before* it goes into the
policy at `https://hrt.kiramyao.com/privacy`. Work down the table, open each path, and
refuse to publish any row you cannot confirm.

| Claim | Where to check |
|---|---|
| Records encrypted, DEK wrapped per credential | `server/src/session.ts`, `createKeyMaterial` / `createPasswordlessKeyMaterial` / `unwrapWithPassword` / `unwrapWithServer` / `setPasswordWrapper` / `addServerWrapper` |
| Only `user_id`, `taken_at` and `category` are clear | `server/schema.sql` comments on `records`, and `server/scripts/check-records.mjs` (reads the column directly, so a plaintext body fails the check rather than passing an API round-trip) |
| Record payloads are sealed with AES-256-GCM | `server/src/payloadCrypto.ts`; wire format is `iv:tag:ciphertext` |
| Session key lifetime | `server/src/session.ts`, `MAX_SESSION_AGE_MS` and `SESSION_TTL_MINUTES` |
| Password hashing (scrypt) | `server/src/accounts.ts`, `hashPassword` |
| Rate limits and lockout | `server/src/http.ts` limiter + `server/src/accounts.ts`, `noteFailedUnlock` |
| Tokens revoked on password change | `server/src/accounts.ts`, `changePassword` |
| **An agent token is a full credential for the account's records** | `server/src/accounts.ts`, `resolveApiContext` — a `hrt_` token resolves to a user id (`resolveApiToken`), and `serverDekFor` then opens the key from the account's own server wrapper. No live unlock is consulted |
| **An agent token is permanent by default, and ends only by revocation** | `server/src/accounts.ts`, `mintApiToken` defaults `expires_at` to NULL; `revokeApiToken` deletes the row. `POST /auth/logout` (`AccountService.lock`) closes a live unlock and does not touch an API token |
| **The password is the other thing that ends a token** | `server/src/accounts.ts`, `changePassword` — deletes every `api_tokens` row for the account and calls `closeUserSessions` |
| **A token cannot be locked out by account state** | `server/src/accounts.ts`, `resolveApiContext` — a `hrt_` token whose account carries no server wrapper, or a deployment with no `SERVER_DEK_KEY`, returns `{ denied: 'locked' }`; that is the only state in which a durable token reads nothing |
| Deletion removes everything user-scoped | `server/test/deleteAccount.test.ts` — asserts each table is empty |
| The deletion tombstone carries no identifier | `server/schema.sql`, `deletion_log`, and the tombstone test |
| Individual record deletes are **physical**, with no tombstone | `server/src/records.ts`, `RecordService.remove` — unlike account deletion, which writes one identifier-free `deletion_log` row |
| **We receive no Google data except the account id** | `server/src/oauth.ts`, `GOOGLE_SCOPE = 'openid'` and `parseGoogleIdToken` — `handle`/`displayName`/`avatarUrl` are `null` by construction; `server/test/accounts.test.ts` feeds it a token that carries `email`/`name`/`picture` and asserts they are ignored |
| X receives no data from us | `server/src/oauth.ts` — the only X calls are token exchange and profile fetch |
| No analytics, no tracking, and only one third-party request | `grep -rn "https://" src/ index.html`: the app ships no analytics or advertising script. The single third-party request is Cloudflare **Turnstile**, loaded from `challenges.cloudflare.com` by `index.html` and rendered on the register form — an earlier version of this row read "links only", which was never true once Turnstile was added. Any policy claim has to name it |
| Share links exclude labs and weight | `server/src/shares.ts`, `assertShareable` — a category blocklist, and `expires_at` is `NOT NULL` in `schema.sql` |
| What a predicted level is | `server/src/core.ts`, `PKSimulationService` |
| The medical disclaimer, and where it lives | `index.html` (the line under the feature list, which a client that runs no JavaScript still sees) and `src/components/DisclaimerModal.tsx` / `src/i18n/share.ts` for the in-app text. There is no `/terms` page — one was removed on purpose, because everything left after the disclaimer was a guess about an operator that is not a legal entity |

## The claims that were previously stated too strongly

An earlier version of this document said a leaked agent token "alone reads nothing",
and that it "does not permit remote access". Both were true while agents needed a live
unlock and are false now. A durable `hrt_` token is a **full credential**:

- It resolves to a user id (`resolveApiToken`), and the key then comes from the
  deployment's own copy of the account key (`serverDekFor` → `unwrapWithServer`). The
  request needs no live unlock, and no user presence.
- It never expires by default (`mintApiToken` writes `expires_at = NULL`), so once
  minted it keeps working until something explicitly ends it.
- `POST /auth/logout` calls `AccountService.lock`, which closes a live unlock. A
  durable token is not a session, so sign-out does not stop it. Only
  `DELETE /api/tokens/{id}` or a password change (`changePassword`) does.

This is the old standard-mode behaviour, now universal: every account carries the
server wrapper, so the same key that makes a forgotten password recoverable makes a
pasted token sufficient. The policy sentence that follows is **"treat an agent token
as a password"**, not "a token cannot read on its own".

The bound that survives is the one `payloadCrypto.ts` states: a stolen database dump
is unreadable without `ENCRYPTION_KEY`. It is not that the operator cannot see the
data — the operator holds both keys.

One change would narrow the gap, not made yet because it alters security behaviour
rather than wording: give `mintApiToken` a non-NULL default expiry, so a forgotten
token eventually dies. Revoking a token and changing a password are both immediate and
already correct; there is nothing to fix about the read path, because the read path is
what the server wrapper is for.

If that default changes, update the token rows above and the "Agents and AI assistants"
paragraph in the guide.
