# Connecting an AI assistant (MCP)

The server speaks **MCP over Streamable HTTP**, so any client that supports that
transport — Claude Desktop, Cursor, VS Code, or an agent you wrote — can read and write a
user's records. Written from the code that implements it (`server/src/mcp.ts`,
`src/pages/McpSettings.tsx`); every value below is what the server actually sends.

**A durable token needs nobody present.** There is no live-unlock guard on the MCP
path: `resolveApiContext` (`server/src/accounts.ts:392`) turns an `hrt_` token into a
user id and then attaches the account's key from the deployment's own copy
(`serverDekFor` → `unwrapWithServer`). No browser session is consulted, and signing out
does not stop it.

The one refusal left is `{ denied: 'locked' }`, and it is a deployment state rather than a
user action: it is returned only when `serverDekFor` finds no server-side wrapper to open
(`server/src/accounts.ts:402` and `:415`) — a deployment missing `SERVER_DEK_KEY`, which
production requires (`server/src/config.ts:255`), or an account created before the wrapper
existed. A password sign-in adds the missing wrapper (`server/src/accounts.ts:350`). On a
correctly configured deployment this should never appear; if it does, it is a bug, not a
locked account waiting for a browser.

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
- **`ks_…`** — a session token from the web UI, not minted for an agent. It reaches the
  same key the same way, because a session row carries none of its own
  (`server/src/accounts.ts:398`); it expires on its own idle window
  (`SESSION_TTL_MINUTES`).

So an `hrt_` token is a full credential for the account's records — read and write.
Treat it exactly as you would treat the user's password, and say so in any prompt or
documentation that asks a user to paste one. `resolveApiToken` returns a user, never a
key; the key is attached separately, but it is attached from a copy the server always
holds. See `CODE-AUDIT.md` for the paths that prove it.

**Consequence for automation:** a headless job holding an `hrt_` token can pull records
on its own, indefinitely, with nobody signed in. That is deliberate — it is the same key
that makes a forgotten password recoverable — but it means minting a token is granting
standing access, not a temporary one.

**Where those records are, and who can read them.** They are sealed at rest with the
deployment's platform key — `requireKey()` in `server/src/records.ts:59` reads
`ENCRYPTION_KEY` — not with a key only the user holds. The operator can read them. State
that plainly to a user before asking for a token; never describe this service as end-to-end
or zero-knowledge encrypted.

---

## Install: one paste

The app builds a self-contained prompt for this — `buildMcpInstallPrompt` in
`src/utils/mcpInstallPrompt.ts`, the same text the intro's assistant step copies. Copy it
from **Account → 连接 AI 助手 → 第三步 · 一键安装** and paste it into any assistant; the
assistant finds its own config file and wires itself up.

The prompt is written so the reader needs to know nothing about this service in advance: it
names the server, the Streamable HTTP transport and the `Authorization: Bearer` header, the
per-client config paths (`claude_desktop_config.json`, `.cursor/mcp.json`,
`.vscode/mcp.json`), the tool to test with (`hrt_reference`), and the two facts a person
pasting a credential has to know — the token is a full credential that works with no
browser session, and `hrt_create_share` publishes a link anyone can open.

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

Nineteen, grouped by what they touch. Every one is described for an agent to choose from,
and `hrt_reference` exists so an agent can learn the vocabulary — and the whole surface,
because it returns its own catalogue — before writing anything.

**Every tool listed here is reachable by any holder of the token**, reads and writes alike.
There is no per-tool scope and no live unlock; the token is the whole credential. What it
deliberately cannot reach is the list under [Identity and destructive operations](#identity-and-destructive-operations).

### Reads

Every read that can return a history paginates. `limit` bounds one page and `before`
(the oldest instant from the page just read) steps back through it; no read returns an
unbounded history.

| Tool | Input | Returns |
|---|---|---|
| `hrt_get_timeline` | `limit?, before?` | Doses and labs merged, newest first. Start here. |
| `hrt_list_medications` | `limit?, before?` | Logged doses only |
| `hrt_list_labs` | `limit?, before?` | Lab results only |
| `hrt_list_journal` | `limit?, before?` | Private journal entries — one free-text note each, newest first |
| `hrt_list_dose_templates` | `limit?, before?` | Saved dose templates — the shapes the app offers as one-tap buttons |
| `hrt_predict_levels` | `analyte?, from_days?, to_days?, points?, with_calibration?` | A downsampled modelled curve plus peak, trough and current level |
| `hrt_check_advisories` | — | Any dosage advisory the app would show |
| `hrt_get_settings` | — | Body weight, mode, calibration, PK overrides, and the app's opaque `appState` |
| `hrt_sync_state` | — | The full record state in one call. This is the whole export (~76 KB) and can be truncated by the result budget — read history with the paginated tools above instead. |
| `hrt_reference` | — | Routes, esters, units, parameter ranges, and the tool catalogue. Static: it reads no records, so it needs no key at all. |

An agent reading history should use the paginated tools, not `hrt_sync_state`: that one
returns the whole export (~76 KB) and can be truncated by the result budget, so a
truncated read looks exactly like missing data.

### Writes

| Tool | Input | Returns |
|---|---|---|
| `hrt_add_medication` | `route, ester, dose_mg, at, extras?` | The created dose |
| `hrt_add_lab_result` | `value, unit, at` | The created lab result |
| `hrt_add_journal_entry` | `note, at, id?` | The created journal entry |
| `hrt_add_dose_template` | `name, route, ester, dose_mg, extras?` | The saved template |
| `hrt_update_settings` | any setting field | The updated settings |
| `hrt_delete_record` | `kind, id` | Confirmation |

**A journal entry is the user's own words.** `hrt_add_journal_entry` is for text they wrote
or dictated; an agent must never compose an entry or infer how someone felt.
`hrt_add_dose_template` saves a reusable *shape* and does not log a dose.

**Deletion covers all four record kinds.** `hrt_delete_record` takes
`kind: 'dose' | 'lab' | 'journal' | 'template'` and the `record_id` a list tool returned.
It writes the tombstone the app's merge needs, so a deleted record does not come back on
the next sync from another device.

**`hrt_update_settings` covers the settings the model reads** — body weight, HRT mode,
calibration method and history window, timezone, and the PK parameter overrides. Those are
settings, so they belong here. The app's *display* preferences (language, theme, HRT start
date, re-check reminders, quick-dose buttons) ride in the opaque `appState` blob and are
**not** writable over MCP: the blob is replaced whole, so a targeted write by an agent
would silently drop collections it never read. They stay a client-side concern.

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

## Identity and destructive operations

The design principle is that everything the web app can do with a person's record is
available over MCP. One class of action is deliberately excluded, and it is written down
here rather than left as an unstated exception — **a principle with silent exceptions is
worse than no principle at all.**

**An `hrt_` token already is a complete credential.** It reaches every record, and the
deployment holds its own copy of the key, so its holder needs nobody's presence and no
browser session. Adding the account's *identity* operations to the same token would raise
the blast radius without giving a person anything they would actually want:

| Web-only action | Endpoint | Why it is not an MCP tool |
|---|---|---|
| Delete the account | `POST /auth/account/delete` | Requires the password on top of the session, precisely because it is the most destructive action the service offers. A token-only path would delete the other factor for the one action that most needs it. |
| Change the password | `POST /auth/password` | Requires the current password and deletes every session and API token. An agent that could rotate the password could lock the owner out of their own record. |
| List or revoke sessions | `GET /auth/sessions`, `POST /auth/sessions/revoke` | Ends a live browser unlock. An agent never holds one, so there is nothing here for it to manage. |
| Bind or unlink X / Google | `POST /auth/credentials/bind`, `POST /auth/x/unlink`, `POST /auth/oauth/{provider}/unlink` | Changes how the account can be reached at all. Getting it wrong can strand the owner, so it needs a person who is present. |
| Mint or revoke agent tokens | `GET/POST /api/tokens`, `DELETE /api/tokens/{id}` | A token that can mint tokens can outlive its own revocation, and one that can revoke a sibling is a denial-of-access between agents. |

None of these is reachable through any MCP tool, and none should be. Revoking this agent's
own token is one button in the app: **Account → 连接 AI 助手**.

This is a decision rather than an omission, and the app states the same boundary on its own
MCP page — `mcp.scope_label` and `mcp.scope_note` in `src/i18n/translations.ts`, in the
reader's language, right under the tool table.

---

## Verifying a connection

Call `hrt_reference` first. It reads no records, so it works with no credential at all —
which separates "the transport is reachable" from "the token is good", the two failures that
otherwise look identical.

Then `hrt_get_timeline` to confirm the token actually reaches records.

## Common failures

| Symptom | Cause |
|---|---|
| `the account is locked` | Not a session state: the deployment holds no copy of the key (`server/src/accounts.ts:415`) — no `SERVER_DEK_KEY`, or an account from before the wrapper existed. A new token will not help; a password sign-in adds the wrapper. |
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
| A `hrt_` token reaches records without a live unlock | `server/src/accounts.ts:392`, `resolveApiContext` → `serverDekFor` → `unwrapWithServer` in `server/src/session.ts` |
| A token is permanent by default | `server/src/accounts.ts`, `mintApiToken` — `expires_at` is NULL unless a caller passes `ttlDays` |
| Sign-out does not stop a token | `server/src/http.ts`, `/auth/logout` → `AccountService.lock` → `closeSession`, which only removes a `ks_` unlock |
| The only refusal is a deployment with no server copy of the key | `resolveApiContext` in `server/src/accounts.ts` returns `{ denied: 'locked' }`; `withContext` in `server/src/mcp.ts` turns it into a readable tool error |
| Shares exclude labs and weight | `server/src/shares.ts`, `assertShareable`; `server/test/shares.test.ts` |
| The tool surface is what it says | `server/test/mcp.protocol.test.ts` asserts the full name set and the exact count, and that `hrt_reference`'s own catalogue equals what `tools/list` returns |
| The documented count and tables match the code | `node scripts/check-mcp-tools.mjs` — parses `registerTool` names and compares them with `src/pages/McpSettings.tsx` and this file, and requires `mcp.tools_desc` to carry `{count}` rather than a typed number |
| Identity operations are not exposed over MCP | None of `/auth/password`, `/auth/sessions*`, `/auth/account/delete`, `/auth/*/unlink`, `/auth/oauth/*/unlink` or `/api/tokens*` has an MCP counterpart; this file and `mcp.scope_note` are where the boundary is stated |
| Expiry is enforced on read | `shares.ts`, `access` — checked per request, not by a sweeper |
