# API status and latency observability — design

Design only; nothing here is deployed. The goal is the smallest scheme that answers
"are users getting errors, and is it slow?" without creating a second copy of user
data.

## What to record

One line per request, from the API process (it knows the route template; Caddy only
knows the raw URI, which carries share tokens and OAuth codes):

| field | example | note |
| --- | --- | --- |
| `ts` | `2026-11-02T08:41:52Z` | UTC, second precision |
| `route` | `POST /api/records/batch` | **template**, never the raw path or query |
| `status` | `429` | integer |
| `ms` | `37` | integer milliseconds |
| `bytes` | `512` | response length, for spotting truncated streams |
| `actor` | `u:9f2c…` / `anon` | truncated hash of the account id; never the id itself |
| `ip` | `b:3f9a` | truncated hash of the client IP, used only for "how many callers" |
| `ver` | `2.5.0-rc2.052263b` | so a regression can be tied to a release |

Aggregate at write time: `route`, `status class`, `ms` bucket (5/10/25/50/100/250/
500/1000/2500/5000+). Counters per minute are enough; no per-request ids, no
correlation key.

## What is never recorded

- `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, and any `*token*` header.
- OAuth `code`/`state` (live credentials for a few seconds, still credentials).
- Share tokens and share passwords, whether in the path (`/share/<token>`) or the
  fragment — hence the route template rule.
- Avatar ids, usernames, emails, record payloads, journal text, lab values.
- Raw query strings, and the raw `Referer`.

Redaction is structural (build the line from fields, never dump a request object),
not a regex pass over a log line: a regex misses the next new route.

## Where it goes

Preferred: journald via the existing unit (`StandardOutput=journal`), one
`hrt_metric` line per request, because journald already applies rate limiting and
access control. If volume makes that awkward, a file under `/var/log/hrt/metrics/`
with `0640 root:adm`, daily rotation, `compress`, `rotate 14` and a total-size cap.

Retention: 14 days. Metrics are cheap and short-lived; anything older belongs in an
aggregate, not a log.

## What to alert on (once collected)

1. 5xx rate > 1% of requests over 15 minutes.
2. p90 latency > 2 s for a route class over 10 minutes.
3. 401 spike: more than 10× the trailing 24 h hourly baseline (credential stuffing,
   or an auth regression).
4. 429 spike: a bucket is being hit hard — expected during an incident, worth seeing.

Thresholds are deliberately coarse: the point is to notice, not to page.

## Order of work

1. Emit the line (behind a config flag), verify on staging that no secret appears.
2. Ship rotation/retention with it — never enable the writer without a bound.
3. Only then add the four alerts.
