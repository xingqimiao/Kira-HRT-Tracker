# Connecting X (Twitter) OAuth

How to wire the "Sign in with X" button on the HRT Core. Written from the code that
implements it (`server/src/oauth.ts`, `server/src/accounts.ts`) and the deployment
notes in `DEPLOY.md` §1 — every value below is the one the server actually sends,
not a guess at what X expects.

**X login is an assist, never a replacement for a password.** An account is only
usable once it has a password and TOTP, because the data key is wrapped under a
password-derived key. Losing the X account therefore costs one login button, never
the history. Nothing in this setup can change that, by design.

---

## What you need before starting

1. An X developer account with a Project and an App.
2. The public origin of **both** sides:
   - the web app, e.g. `https://hrt.kiramyao.com`
   - the API, e.g. `https://api.kiramyao.com/hrt`
3. About 15 minutes. The portal's save-then-wait is the slow part, not the code.

---

## 1. Create the App and take three values

At <https://console.x.com> → your Project → **Keys and tokens**:

| Value | Where | Goes into |
|---|---|---|
| Client ID | OAuth 2.0 Client ID | `X_CLIENT_ID` |
| Client Secret | OAuth 2.0 Client Secret | `X_CLIENT_SECRET` |
| — | — | `X_REDIRECT_URI` (you choose it, see step 2) |

The Client Secret is shown **once**. Store it in `.env` immediately; if it is lost,
regenerate rather than hunt for it.

## 2. Set the Callback URI — this is the step people get wrong

Under **User authentication settings**:

- **App permissions:** Read.
- **Type of App:** Web App, Automated App or Bot.
- **Callback URI / Redirect URL:**

  ```
  https://api.kiramyao.com/hrt/auth/x/callback
  ```

Three things about that string, each of which has caused a failure:

1. **`/hrt` is part of it.** The Core is mounted under a prefix because the host is
   shared with the comment service, and X compares the callback byte for byte.
   Dropping the prefix produces `redirect_uri` mismatch, not a helpful error.
2. **No trailing slash.** X treats it as a different URI.
3. **`https`, never `http`** — except on a localhost development host, which X
   allows specifically.

- **Website URL:** `https://hrt.kiramyao.com`
- **Terms of Service:** leave empty. Optional, and this project does not publish one
  — see the note in `DEPLOY.md`. X only requires it (and the Privacy Policy) when the
  app asks for users' email addresses, which this one does not: `requestEmailAddress`
  is `false`.
- **Privacy Policy:** `https://kiramyao.com/privacy` — see `PRIVACY-POLICY-GUIDE.md`.
  Filled in because the field is there, not because it is demanded of this app. If you
  do supply it, X checks that it resolves and will not accept a placeholder.

Save. The portal can take a minute to propagate; a request in the next 60 seconds
may still see the old settings.

## 3. Configure the server

In `/srv/kira-hrt/.env`:

```bash
X_CLIENT_ID=<from step 1>
X_CLIENT_SECRET=<from step 1>
X_REDIRECT_URI=https://api.kiramyao.com/hrt/auth/x/callback
```

All three or none. Setting one or two makes config loading **throw** at boot
(`server/src/config.ts`), deliberately: a half-configured provider fails later and
less clearly, on someone's first login attempt.

Leave all three unset and the service runs on password + TOTP alone. `/hrt/health`
reports `x_login: false` in that case, which is how you confirm the state from
outside.

## 4. Restart and verify

```bash
sudo systemctl restart kira-hrt
curl -s https://api.kiramyao.com/hrt/health
#  -> {"ok":true,"service":"hrt","mount":"/hrt","x_login":true}
```

`x_login: true` means all three values parsed. It does **not** mean the portal will
accept the callback — that needs a real browser:

```bash
# Open this and complete the flow. A 400 from X here is almost always a
# redirect_uri mismatch, and the page says which URI it received.
open https://api.kiramyao.com/hrt/auth/x/start
```

A successful round trip ends at `https://hrt.kiramyao.com/auth/x/callback`, which
the app exchanges for a session.

---

## What the server sends, so you can debug it

Useful when the portal disagrees with the server, because the failure is usually a
mismatch between these and the dashboard.

| Field | Value |
|---|---|
| Authorize endpoint | `https://twitter.com/i/oauth2/authorize` |
| Token endpoint | `https://api.twitter.com/2/oauth2/token` |
| Profile endpoint | `https://api.twitter.com/2/users/me` |
| Profile fields | `user.fields=username,name,profile_image_url` |
| Scope | `users.read tweet.read` — the minimum pair that actually works |
| Flow | Authorization code **with PKCE** (S256) |
| Client auth | HTTP Basic, using Client ID and Secret |

**Why PKCE on a confidential client that already holds a secret:** the secret proves
*this server* is making the call, while the code verifier proves the same client
that started the flow is finishing it. They defend different links in the chain, and
X requires PKCE regardless.

**On the avatar:** `profile_image_url` comes back as a 48px `_normal.jpg`, too small to
show anywhere but a 48px slot. The server rewrites the size suffix to `_400x400` — the
same file at a usable resolution — and stores it in `oauth_links.avatar_url`, refreshed
on each sign-in so a changed picture follows. It is cosmetic: a null simply renders the
generic 𝕏 glyph. Note this needs no extra **scope**; it is a field within `users.read`.

**Why the scope is `users.read` *and* `tweet.read`:** `users.read` is what yields the
identity — the app needs to know which handle is attached to an account, and nothing
here reads or posts tweets. `tweet.read` is not used to read anything, but it is
**required alongside `users.read` or `GET /2/users/me` answers 403**. That failure is
easy to misdiagnose, because the authorize step still succeeds: X hands back a code,
the token exchange works, and only the profile fetch fails, so the symptom points at
the credentials rather than the scope. It was absent here at first for exactly that
reason. The comment service on this box runs the same flow and documents the same
requirement in `lib/auth.mjs`.

If the scope is ever narrowed, test the **whole round trip** with a real browser, not
just `/auth/x/start` — the authorize request will keep looking correct.

---

## Common failures

| Symptom | Cause |
|---|---|
| `redirect_uri` mismatch | The value differs from the portal by a character: a missing `/hrt`, a trailing slash, or `http`. Diff them literally. |
| `invalid_client` | Client ID or Secret wrong, or the Secret was rotated in the portal and `.env` was not updated. |
| Boot throws `X_CLIENT_ID is required` | One or two of the three are set. It is all three or none. |
| Works locally, fails in production | Localhost callback registered but the production one is not, or the reverse. Both can be registered, and they are separate entries. |
| `x_login: false` after a restart | The unit did not pick up `.env`; check `systemctl show kira-hrt -p Environment` and the file's permissions. |
| Sign-in reaches X, then fails with `X profile fetch failed (403)` | The requested scope is missing `tweet.read`. The authorize step and the token exchange both succeed, which is what makes it look like a credential problem. Fix in `src/oauth.ts`, not in the portal. |
| X shows "Something went wrong / You weren't able to give access to the App" *before* any consent screen | X does not recognise the client id at all — the app's OAuth 2.0 client was never provisioned. Confirm by POSTing a bogus code to `/2/oauth2/token` with the client's Basic credentials: an unprovisioned client answers `invalid_client` ("client id was invalid"), while a working client answers `invalid_grant`/`invalid_request` about the code. Console edits and a Client Secret regeneration do **not** fix it; a new app does. |
| Callback lands on the wrong service | Two `/auth/x/callback` routes on one host. The `/hrt` prefix is what keeps the comment service's apart from this one, and a collision redeems one app's codes against the other's state table — silently, with no error. Check that `BASE_PATH` is set. |

---

## Rotating the secret

1. Regenerate in the portal.
2. Update `X_CLIENT_SECRET` in `.env`.
3. `sudo systemctl restart kira-hrt`.

Existing sessions are unaffected: X is an assist, so no session depends on the X
tokens staying valid. Users who linked with X sign in again with their password if
the link ever needs redoing — the data key is password-derived and never came from X.
