# Connecting an AI assistant (MCP)

The server speaks **MCP over Streamable HTTP**, so any client that supports that
transport — Claude Desktop, Cursor, VS Code, or an agent you wrote — can read and write a
user's records. Written from the code that implements it (`server/src/mcp.ts`,
`src/pages/McpSettings.tsx`); every value below is what the server actually sends.

**The one thing that surprises everyone:** record tools can refuse with `the account is
locked`. It is not an authentication failure, and the fix is a browser tab rather than a
new token — but the reason is narrower than it used to be. The server does hold a copy of
every account's data key (wrapped under `SERVER_DEK_KEY`), so a durable token normally
reads with no live unlock at all. `locked` is returned by `resolveApiContext` in exactly
one situation: the account carries no server wrapper, or the deployment has no
`SERVER_DEK_KEY` to open it with. An account that predates the wrapper is the usual
cause; signing in with the password at the web UI adds the wrapper, and the account stops
reporting itself as locked for good.

---

## What you need

| | |
|---|---|
| Endpoint | `https://api.kiramyao.com/hrt/mcp` |
| Method | **POST only** — no GET, no SSE upgrade |
| Auth | `Authorization: Bearer <token>` |
| Protocol | MCP, Streamable HTTP |

---

## Two credential shapes, and why it matters

The bearer token is one of two things, and they differ in lifetime rather than in reach:

- **`hrt_…`** — a durable token minted for an agent in the app. It **proves identity**,
  and the key then comes from the deployment's own copy of it (`resolveApiContext` →
  `serverDekFor`). **No live unlock is needed and the user does not have to be present.**
  It never expires by default, and `/auth/logout` does not stop it, because it is not a
  session: only revoking it in the app or changing the password ends it.
- **`ks_…`** — a live unlock token from the web UI. It **carries the key** directly, and
  it expires on its own idle window (`SESSION_TTL_MINUTES`).

So an `hrt_` token is a full credential for the account's records — read and write.
Treat it exactly as you would treat the user's password, and say so in any prompt or
documentation that asks a user to paste one. `resolveApiToken` returns a user, never a
key; the key is attached separately, but it is attached from a copy the server always
holds. See `CODE-AUDIT.md` for the paths that prove it.

**Consequence for automation:** a headless job holding an `hrt_` token can pull records
on its own, indefinitely, with nobody signed in. That is deliberate — it is the same key
that makes a forgotten password recoverable — but it means minting a token is granting
standing access, not a temporary one.

---

## Install: one paste

The app builds a self-contained prompt for this. Copy it from **Account → 连接 AI
助手 → 第一步 · 一键安装** and paste it into any assistant; the assistant finds its own
config file and wires itself up.

The prompt is written to work without the reader knowing anything about this service, so
it names the transport, the header, the per-client config paths, the tool to test with
(`hrt_reference` — it needs no records and no unlock), and the two things that look like
failures and are not: a locked account, and a share being a disclosure.

## Install: by hand

```json
{
  "mcpServers": {
    "kira-tracker": {
      "type": "http",
      "url": "https://api.kiramyao.com/hrt/mcp",
      "headers": { "Authorization": "Bearer hrt_..." }
    }
  }
}
```

Config file locations, for reference: `claude_desktop_config.json` (Claude Desktop),
`.cursor/mcp.json` (Cursor), `.vscode/mcp.json` (VS Code).

---

## The tools

Fifteen, grouped by what they touch. Every one is described for an agent to choose from,
and `hrt_reference` exists so an agent can learn the vocabulary before writing anything.

### Reads

| Tool | Input | Returns |
|---|---|---|
| `hrt_get_timeline` | `limit?` | Doses and labs merged, newest first. Start here. |
| `hrt_list_medications` | `limit?` | Logged doses only |
| `hrt_list_labs` | `limit?` | Lab results only |
| `hrt_predict_levels` | `at?` | Modelled concentration at a time |
| `hrt_check_advisories` | — | Any dosage advisory the app would show |
| `hrt_get_settings` | — | Body weight, mode, calibration |
| `hrt_sync_state` | — | The full record state in one call |
| `hrt_reference` | — | Routes, esters, units, parameter ranges. **Works while locked.** |

### Writes

| Tool | Input | Returns |
|---|---|---|
| `hrt_add_medication` | `route, ester, dose_mg, at` | The created dose |
| `hrt_add_lab_result` | `value, unit, at` | The created lab result |
| `hrt_update_settings` | any setting field | The updated settings |
| `hrt_delete_record` | `kind, id` | Confirmation |

### Shares

The only tools whose effect is visible to someone **without an account**, which is why
they are described in those terms rather than by their arguments.

| Tool | Input | Returns |
|---|---|---|
| `hrt_create_share` | `expires_in_hours?, password?, live?, limit?` | A URL, shown once |
| `hrt_list_shares` | — | What is currently published |
| `hrt_revoke_share` | `id` | Confirmation |

A share carries **dose history and the modelled curve only**. Lab results, body weight
and account details are refused by the server — `assertShareable` in `src/shares.ts`
walks the whole payload, at any depth, because the snapshot is built by the caller and
cannot be trusted. An agent cannot publish a lab value through a share even if it tries.

There is deliberately **no update tool**: a link is either frozen or live, and changing
what someone may be reading right now is not a one-liner worth exposing. Revoke and
create is the honest sequence.

---

## Verifying a connection

Call `hrt_reference`. It needs no records and no unlock, so it separates "the connection
works" from "the account is locked" — the two failures that otherwise look identical.

Then `hrt_get_timeline` to confirm records are readable.

## Common failures

| Symptom | Cause |
|---|---|
| `the account is locked` | The account has no server wrapper, or the deployment has no `SERVER_DEK_KEY`. A new token will not help; a password sign-in at the web UI adds the wrapper. |
| `401` on every call | Token missing, mistyped, or revoked in the app. |
| `404` | Wrong path. It is `/hrt/mcp` — the `/hrt` prefix is part of it, because the host is shared with the comment service. |
| `405` | Sent a GET. The transport is POST-only. |
| Tools list is empty | The client connected but does not speak Streamable HTTP, or is pointed at `/hrt/` instead of `/hrt/mcp`. |

## Rotating or revoking a token

Tokens are permanent by default and listed in the app (**Account → 连接 AI 助手**).
Revoking one stops it immediately. A password change deletes every token as well, because
a password change is a security event rather than because the password wraps the key —
the agent's key came from the deployment's copy, not from the password. Signing out does
**not** revoke a token.

---

## Where each claim is verified in the code

| Claim | Where to check |
|---|---|
| A `hrt_` token reaches records without a live unlock | `server/src/accounts.ts`, `resolveApiContext` → `serverDekFor` → `unwrapWithServer` in `server/src/session.ts` |
| A token is permanent by default | `server/src/accounts.ts`, `mintApiToken` — `expires_at` is NULL unless a caller passes `ttlDays` |
| Sign-out does not stop a token | `server/src/http.ts`, `/auth/logout` → `AccountService.lock` → `closeSession`, which only removes a `ks_` unlock |
| Only the locked state refuses | `server/src/mcp.ts`, `withContext` turns `{ denied: 'locked' }` into a readable tool error |
| Shares exclude labs and weight | `server/src/shares.ts`, `assertShareable`; `server/test/shares.test.ts` |
| The tool surface is what it says | `server/test/mcp.protocol.test.ts` asserts the names, including the three share tools |
| Expiry is enforced on read | `shares.ts`, `access` — checked per request, not by a sweeper |
