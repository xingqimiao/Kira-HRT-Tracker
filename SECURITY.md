# Security Documentation

How this project protects accounts and record data, and what a deployment has to
configure. It describes the code in `server/src/`; when a claim here and the code
disagree, the code wins — this file has drifted before.

Two hosts, by design: the web app is static (`PUBLIC_ORIGIN`, e.g. `hrt.example.com`)
and the API is a stateful process (`API_ORIGIN`, e.g. `api.example.com`). A compromise
or cache poisoning on the static side therefore cannot reach the data plane.

## Authentication

- **Passwords** are hashed with `scrypt` and verified with `crypto.timingSafeEqual`, so
  comparison is constant-time (`server/src/accounts.ts`).
- **Sessions** are opaque `ks_` tokens, stored hashed and expiring after
  `SESSION_TTL_MINUTES`. A session can be listed and revoked individually.
- **Durable agent tokens** are `hrt_` values, stored only as a SHA-256 hash
  (`hashToken()`); the plaintext is shown once and never persisted. Lookups are
  parameterized queries keyed on the hash.
- **Social login** (X, Google) is optional per provider. X uses PKCE; Google's web
  client authenticates with the secret and carries identity in the ID token. Google
  asks for `openid profile` and never `email`.
- **Username enumeration** is avoided: a wrong password and an unknown user return the
  same generic failure.
- **Turnstile** (optional) is enabled only when both `TURNSTILE_SECRET` and
  `TURNSTILE_HOSTNAMES` are set; the reply's hostname is checked against the allowlist,
  because a token alone would not prove which site minted it.

## Record encryption

Every business field of a dose, lab, journal entry, or template is stored as one
AES-256-GCM blob under each account's own data key (DEK). The GCM tag length (16 bytes)
and IV length (12 bytes) are validated before decryption, not merely assumed.

This is **not** end-to-end encryption: the server decrypts on read. The guarantee is
"a database dump is useless without the key". Each account has its own data key (DEK);
`SERVER_DEK_KEY` is the deployment's wrapped copy so an unlocked token can reach records
without the user re-entering a password. With no `SERVER_DEK_KEY`, the account is
"locked" and record tools report that rather than failing as an auth error.

## Transport and request handling

- **CORS is an exact-match allowlist**, never a reflected `Origin`, and
  `Allow-Credentials` is only sent to a listed origin. This is required because the API
  is called with credentials from one known site.
- **Baseline response headers** on every response (`server/src/http.ts`): `nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
  HSTS, and `Cache-Control: no-store`.
- **Rate limiting** is a per-IP fixed window plus a per-account lockout: the first stops
  one host spraying many accounts, the second stops a botnet focusing on one account.
  It is in-memory and per-process (a `ponytail:` note marks the Redis upgrade path).
- **Inbound JSON** endpoints validate `Content-Type`.
- **SQL** is parameterized throughout (`pg` with `$1…` placeholders). No string-built
  queries.

## Outbound requests (SSRF)

The server fetches two kinds of URL: fixed provider endpoints (X/Google token and
profile hosts, which are compile-time constants) and the avatar URL named by a provider
token response. That second one is untrusted — it is parsed, not verified — so before
the request the host is screened (`server/src/urlGuard.ts`): loopback, private, CGNAT,
link-local (including the cloud metadata endpoint `169.254.169.254`), reserved, and
multicast ranges are refused, as are `.localhost`/`.internal` names and IPv4-mapped IPv6
literals. Redirects are refused rather than followed, so a public host cannot bounce the
request to an internal one. The body is size-capped and must be a png/jpeg/webp —
`image/svg+xml` and `text/html` are dropped, so an error page or a script container can
never be stored as an avatar.

## Security configuration requirements

Set these in the process environment (the systemd unit on the deployment host keeps the
secrets encrypted on disk). Read once and validated at boot, so a bad paste fails at
startup rather than on the first request.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `PUBLIC_ORIGIN` | yes | The web app origin. Used for the CORS allowlist and OAuth bounce targets. Bare origin, no trailing slash. |
| `API_ORIGIN` | yes | This server's own public origin — the OAuth callback host. |
| `SERVER_DEK_KEY` | production | Deployment's wrapped copy of each account's data key, 32+ chars. Required in production. |
| `PORT` | no | Default `8788`. |
| `BASE_PATH` | no | Path prefix on a shared host (e.g. `/hrt`). No `.`/`..` segments. |
| `BIND_HOST` | no | Interface to bind. Defaults to `127.0.0.1` — put a reverse proxy in front. |
| `SESSION_TTL_MINUTES` | no | Session lifetime. |
| `RATE_LIMIT_LOGIN` / `RATE_LIMIT_REGISTER` / `RATE_LIMIT_WINDOW_MS` | no | Rate-limit tuning. |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` / `X_REDIRECT_URI` | optional | All three together, or none. `X_REDIRECT_URI` must be https outside localhost. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | optional | All three together, or none. Must match the Cloud Console registration byte for byte. |
| `TURNSTILE_SECRET` / `TURNSTILE_HOSTNAMES` | optional | Both together, or neither. |
| `CREDENTIALS_DIRECTORY` | no | systemd credential directory, read for keys. |
| `HRT_UNLOCK_TOKEN` | no | For the stdio MCP adapter: an unlock token so the local server can read records. |

Half-configured provider blocks (one of three variables set) are refused at boot, because
that is the mistake that silently half-works.

## Deployment checklist

- [ ] Set `DATABASE_URL`, `PUBLIC_ORIGIN`, `API_ORIGIN` in the environment.
- [ ] Generate and set `SERVER_DEK_KEY` (`openssl rand -base64 48`); never commit it.
- [ ] Keep `BIND_HOST` on loopback and terminate TLS at the reverse proxy.
- [ ] Configure the CORS allowlist to the exact production origin.
- [ ] If social login is used, register the callback URIs exactly as configured.
- [ ] If Turnstile is used, list the site hostnames.
- [ ] Review rate-limit settings for expected traffic.
- [ ] Monitor authentication and error logs for suspicious activity.

## Known considerations

- **Rate limiting** is in-memory; a multi-instance deployment needs a shared store.
- **Password policy** enforces 8–128 characters. No composition rules are imposed.
- **DNS rebinding** is not guarded: `urlGuard.ts` screens the literal host, not where a
  public name resolves. The only writers of an avatar URL are the X and Google callbacks;
  the upgrade path is to resolve the name and pin the connection to the address.
- **Dependencies**: run `npm audit` (root and `server/`) before a release.

## Reporting security issues

Report privately to the maintainers rather than in a public issue, so a fix can ship
before disclosure.

## License

This documentation is part of the HRT project and subject to the same license as the code.
