# Connecting an AI assistant (MCP)

The server speaks **MCP over Streamable HTTP**, so any client that supports that
transport — Claude Desktop, Cursor, VS Code, or an agent you wrote — can read and write a
user's records. Written from the code that implements it (`server/src/mcp.ts`,
`src/pages/McpSettings.tsx`); every value below is what the server actually sends.

**The one thing that surprises everyone:** record tools refuse while the account is
locked. That is not a bug and not an authentication failure — the server holds no
decryption key at rest, so it cannot read anything until the user unlocks the account in
the web UI. A tool answers `the account is locked` and the fix is a browser tab, not a
new token.

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

The bearer token is one of two things, and they behave differently:

- **`hrt_…`** — a durable token minted for an agent in the app. It **proves identity
  only**. The key still has to come from somewhere, so a token with no open unlock
  resolves to nothing and the tools report the account as locked.
- **`ks_…`** — a live unlock token from the web UI. It **carries the key**, so tools work
  for as long as the session lasts (30 minutes of inactivity).

An agent therefore cannot read a locked account by any means. That is the design: the
API token is deliberately not a key. `resolveApiToken` returns a user, never a key —
see `ARCHITECTURE.md`.

**Consequence for automation:** a headless job cannot pull records on its own. Someone
must have unlocked recently, or the job must hold a `ks_…` token, which expires. There is
no "service account" mode, because that would mean storing a key on the server.

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
| `the account is locked` | No open unlock. The user must sign in at the web UI; a new token will not help. |
| `401` on every call | Token missing, mistyped, or revoked in the app. |
| `404` | Wrong path. It is `/hrt/mcp` — the `/hrt` prefix is part of it, because the host is shared with the comment service. |
| `405` | Sent a GET. The transport is POST-only. |
| Tools list is empty | The client connected but does not speak Streamable HTTP, or is pointed at `/hrt/` instead of `/hrt/mcp`. |

## Rotating or revoking a token

Tokens are permanent by default and listed in the app (**Account → 连接 AI 助手**). A
password change deletes them, so an agent stops working after the owner changes their
password — deliberately, since the password is what wraps the key.

---

## Where each claim is verified in the code

| Claim | Where to check |
|---|---|
| The token is not a key | `server/src/mcp.ts`, `makeBearerResolver` — a `hrt_` token resolves to a user, then the key is looked up separately |
| A locked account cannot be read | `server/src/session.ts`, `findUserSession`; `withContext` in `mcp.ts` |
| Shares exclude labs and weight | `server/src/shares.ts`, `assertShareable`; `server/test/shares.test.ts` |
| The tool surface is what it says | `server/test/mcp.protocol.test.ts` asserts the names, including the three share tools |
| Expiry is enforced on read | `shares.ts`, `access` — checked per request, not by a sweeper |
