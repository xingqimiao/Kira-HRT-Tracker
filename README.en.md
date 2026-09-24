# Kira HRT Tracker

**English** · [中文](README.md)

![Kira HRT Tracker — dose logging, pharmacokinetic estimates, private by default](public/og.png)

Log HRT doses and blood tests, estimate how your hormone levels move over time, and let
an AI assistant read and write those records over MCP.

Built by **[KiraEqual](https://kiramyao.com)** · Service status <https://status.kiramyao.com>

> ⚠️ The estimates come from a **population pharmacokinetic model**, not from a blood test, and
> **must not be used to decide a dose**. The only way to know your actual level is to have blood
> drawn — always go by your clinic's report.

---

## What it is

A tracker for HRT, built around one loop:

**log a dose → the model estimates a concentration curve → enter your blood-test results →
the model adjusts toward you specifically**

It suits someone who injects or uses gel and wants to know "roughly where is my level this
week", "when should I get the next blood test", "was that dose too high" — and who wants
those records to be readable by an AI assistant.

## Getting started

1. **The first launch** shows a short introduction to what the app does. Language and HRT
   mode are chosen once, and can be changed later in Settings.
2. **Log your first dose**: route, medication, amount, time. Save it as a template and the
   home screen can log it in one tap from then on.
3. **Look at the overview**: current estimated level, the curve over time, and a dose calendar.
4. **After a blood test**, enter the result on the 体检 (Labs) page. With two or more results
   the model starts **calibrating to your own data**, and the curve fits you better.
5. **For an AI assistant**, mint a token (below) and let it read your records, do the
   arithmetic, and remind you about re-checks.

Your data lives in **your own account** and syncs across devices. No third-party analytics,
no advertising.

---

## Features

- **Records** — injection / oral / sublingual / gel / patch. Gel carries the product, the
  application area, what else was on the skin, and the wash-off time. Blood tests, a private
  journal, quick-log buttons, batch add, import and export.
- **Estimates** — concentration curve, current level, dose-level reference, individual calibration.
- **Re-check reminders** — prompts for liver function, potassium and estradiol on the cadence
  MtF.wiki recommends; anti-androgens get cumulative tracking.
- **Lab-report scanning** — photograph a report; recognition happens **on-device** and the
  image never leaves it.
- **Accounts** — password plus X / Google sign-in, mutually bindable; device session list;
  data export and deletion.
- **Sharing** — a read-only link for a doctor or a friend, with an optional expiry and
  password, containing **only what you chose to share**.
- **7 languages** — Simplified Chinese, Traditional Chinese, Cantonese, English, Japanese,
  Korean, Turkish, loaded on demand.

---

## Moving in / moving out

**Importing from another tracker**: Settings → Data management → Import data, pick a file. Supported:

- **[Oyama's HRT Tracker](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker)** JSON,
  including password-encrypted exports — this app is forked from it, and the envelope is identical;
- **[Transmtf HRT Tracker](https://github.com/TransmtfTeam/Transmtf-HRT-Tracker)** JSON,
  including password-encrypted exports;
- **[Featherline](https://github.com/mkx173/Featherline)** `.hrtbackup` files (enter the backup
  password).

Doses and labs both come across. Featherline's custom gel-product catalogue has no equivalent
here, so it is skipped and the user is told how many entries were skipped — the records
themselves keep their dose, route and site.

**Exporting**: JSON, in a format that is published and stable.

**For the authors of other trackers**: start with the
**[Chinese how-to](docs/hrt-import-export-protocol.zh-CN.md)** — field tables, working example
code, a self-test checklist and a prompt you can hand an AI assistant. The authoritative field
definitions are in the English
**[spec](docs/hrt-import-export-protocol.md)**: the minimum required fields, the full tables,
the `route`/`Ester` enumerations, the unit conventions (`timeH` is hours since 1970; `doseMG` is
the mass of the substance, not its estradiol equivalent), the optional encryption envelope, and
a minimal example. Write to it and your users can move across in one step.

---

## Two pharmacokinetic models

The curve comes from a model, and the models are **other people's work**. Two ship here,
switchable any time in Settings → General:

| Model | Source |
|---|---|
| **Built-in** | [@LaoZhong-Mihari](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test)'s `PKcore.swift` / `PKparameter.swift`, ported directly |
| **Transmtf** | [Transmtf Team](https://github.com/TransmtfTeam/Transmtf-HRT-Tracker) (MIT), extending the same algorithm |

The two **draw different curves from the same records** — that is not a bug, it is why the
choice exists. Injections usually agree; gel and sublingual differ noticeably. The Transmtf
engine models estradiol only, so it is unavailable in transmasc mode.

**Individual calibration** has a separate implementation for each (MAP fitting, an extended
Kalman filter, Ornstein–Uhlenbeck dynamic calibration); all of them use your lab values to
adjust the model's parameters.

---

## Connecting an AI assistant

The server implements [MCP](https://modelcontextprotocol.io). Mint a token in the app and put
it in your client's config:

```json
{
  "mcpServers": {
    "hrt": {
      "type": "http",
      "url": "https://your-api-host/hrt/mcp",
      "headers": { "Authorization": "Bearer hrt_..." }
    }
  }
}
```

19 tools: read the timeline, log a dose, log a lab, estimate levels, check advisories, create a
share. The **tool list** is readable anonymously (schemas only); **calling** any tool requires a
token. Tokens are revocable and expirable, and changing your password ends all of them.

The assistant **can read** which model is active (to explain the curve) but **cannot change
it** for you — switching re-computes every past estimate, which is a decision to make while
looking at the curve.

---

## Self-hosting

The front end is a static build; the back end is the Node service in `server/`, which needs a
Postgres.

```bash
VITE_API_ORIGIN=https://your-api-host/hrt npm run build
```

The full manual is **[`server/DEPLOY.md`](server/DEPLOY.md)** (database, systemd, Caddy,
pre-deployment checks).

---

## Upstream / Credits

The interface and the thinking **fork from [Oyama's HRT Tracker](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker)**,
with thanks. That is a complete piece of work — accounts, a backend, share links, multiple
languages — and this project carries it forward.

Thanks to [@LaoZhong-Mihari](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test):
the pharmacokinetic algorithm, model and parameters are their work, and this app only ports it
to the web and maintains it. That attribution is a licence requirement and, more to the point,
the right thing.

Thanks also to [Transmtf Team](https://github.com/TransmtfTeam/Transmtf-HRT-Tracker) for the
algorithmic extensions, and to [MtF.wiki](https://mtf.wiki/) (CC BY-SA 4.0) and
[Transfeminine Science](https://transfemscience.org/) for the dosing and monitoring reference —
**their published conclusions and figures are cited; their content is not reproduced**.

The full licence list is in **[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md)**, and is
also itemised in the app under Settings → About → Open-source licences.

Runtime dependency licences are generated by `scripts/gen-licences.mjs`, not maintained by hand.

---

## Licence

This repository is **MIT**; the original notices from the fork sources are preserved in
[`LICENSE`](LICENSE).

**Note the upstream model's non-commercial restriction**: the code is MIT, but the
pharmacokinetic model it depends on carries a **non-commercial clause**, and that constrains how
*the whole application* may be used. Use in a paid product requires renegotiating with the
copyright holder first. See [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md).
