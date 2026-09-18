# Code audit — where each policy claim is verified

Internal document. Not part of the published policy, and not written for users: they
cannot check file paths, so a claim that cites one is a claim they must take on trust.

This exists for one job: confirming a claim against the code *before* it goes into the
policy at `https://hrt.kiramyao.com/privacy`. Work down the table, open each path, and
refuse to publish any row you cannot confirm.

| Claim | Where to check |
|---|---|
| Records encrypted, DEK wrapped per credential | `server/src/session.ts`, `createKeyMaterial` / `unwrapWithPassword` / `unwrapWithServer` / `unwrapWithRecovery` |
| Only `occurred_at` and `user_id` are clear | `server/schema.sql` comments on `medication_events`, and `server/scripts/check-records.mjs` (reads the column directly) |
| Record payloads are sealed with AES-256-GCM | `server/src/payloadCrypto.ts`; wire format is `iv:tag:ciphertext` |
| Session key lifetime | `server/src/session.ts`, `MAX_SESSION_AGE_MS` and `SESSION_TTL_MINUTES` |
| Password hashing (scrypt) | `server/src/accounts.ts`, `hashPassword` |
| Rate limits and lockout | `server/src/http.ts` limiter + `server/src/accounts.ts`, `noteFailedUnlock` |
| Tokens revoked on password change | `server/src/accounts.ts`, `changePassword` |
| **An agent token cannot unlock an account by itself** | `server/src/accounts.ts`, `resolveApiToken` — returns a user id, never a key; `server/src/http.ts` `contextFor` and `server/src/mcp.ts` `makeBearerResolver` then require `findUserSession` |
| **An agent token can read during an unlocked window, and extends it** | `server/src/session.ts`, `findUserSession` — refreshes `expiresAt` on every read; `mintApiToken` defaults `expires_at` to NULL (no expiry) |
| **An agent token does not permit remote access** | `server/src/session.ts`, `openSession` — a session is only created by a password unlock; no token path creates one |
| Deletion removes everything user-scoped | `server/test/deleteAccount.test.ts` — asserts each table is empty |
| The deletion tombstone carries no identifier | `server/schema.sql`, `deletion_log`, and the tombstone test |
| Individual record deletes are soft | `server/src/store.ts`, `softDelete` |
| **We receive no Google data except the account id** | `server/src/oauth.ts`, `GOOGLE_SCOPE = 'openid'` and `parseGoogleIdToken` — `handle`/`displayName`/`avatarUrl` are `null` by construction; `server/test/accounts.test.ts` feeds it a token that carries `email`/`name`/`picture` and asserts they are ignored |
| X receives no data from us | `server/src/oauth.ts` — the only X calls are token exchange and profile fetch |
| No third-party requests in the app | `grep -rn "https://" src/ index.html` — links only |
| Share links exclude labs and weight | `worker.ts` snapshot sanitiser, and `README.md` |
| What a predicted level is | `server/src/core.ts`, `PKSimulationService` |
| The medical disclaimer, and where it lives | `index.html` (the line under the feature list, which a client that runs no JavaScript still sees) and `src/components/DisclaimerModal.tsx` / `src/i18n/share.ts` for the in-app text. There is no `/terms` page — one was removed on purpose, because everything left after the disclaimer was a guess about an operator that is not a legal entity |

## The claim that was previously stated too strongly

An earlier version of this document said a leaked agent token "alone reads nothing."
True, and not the whole story — the two halves of the mechanism pull in opposite
directions:

- A token needs a live unlock, so it cannot create access. (`findUserSession`)
- That unlock renews on every token read, and the default token never expires. So once
  the user is signed in, holding the token is enough to read, indefinitely.

"Reads nothing without an unlock" is therefore not the same as "a leaked token is
harmless". Do not let the policy reduce to the first.

Two changes would close the gap, neither made yet, because both alter security
behaviour rather than wording:

1. Give `mintApiToken` a non-NULL default expiry, so a forgotten token eventually dies.
2. Stop refreshing the idle timer on token reads in `findUserSession`, so a session
   expires on the user's own inactivity rather than on an agent's activity.

If either is done, update the token rows above and the "Agents and AI assistants"
paragraph in the guide.
