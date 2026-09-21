# Kira HRT Tracker

**Kira HRT Tracker** — an agent-friendly HRT tracker: log medications and lab results, follow treatment history, and see pharmacokinetic estimates of hormone levels over time.

**Kira HRT Tracker**（HRT 记录工具）——面向 AI 助手友好的 HRT 记录工具：记录用药与化验结果、跟踪治疗历程，并提供基于药代动力学模型的激素水平估算。

出品 / Made by **[KiraEqual](https://kiramyao.com)** · 服务状态 / Status: <https://status.kiramyao.com>

---

## Algorithm & Core Logic 算法逻辑

The pharmacokinetic algorithms, mathematical models, and parameters used in this simulation are derived directly from the **[HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test)** repository.

本模拟中使用的药代动力学算法、数学模型与相关参数，直接来源于 **[HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test)** 仓库。

We strictly adhere to the `PKcore.swift` and `PKparameter.swift` logic provided by **@LaoZhong-Mihari**, ensuring that the web simulation matches the accuracy of the original native implementation (including 3-compartment models, two-part depot kinetics, and specific sublingual absorption tiers).

我们严格遵循 **@LaoZhong-Mihari** 提供的 `PKcore.swift` 与 `PKparameter.swift` 中的逻辑，确保网页端模拟与原生实现在精度上保持一致（包括三室模型、双相肌注库房动力学以及特定的舌下吸收分层等）。

Upstream attribution is a licence condition, not a courtesy: the model grant and the MIT notice it was built from are reproduced in `THIRD-PARTY-LICENSES.md`, and the algorithm credit is also shown in the app under Settings → About.

上游署名是许可条件而非客套：模型授权与所依据的 MIT 声明都完整收录在 `THIRD-PARTY-LICENSES.md`，应用内「设置 → 关于」也可见算法致谢。

---

## Features 功能

- **Multi-Route Simulation**: Supports Injection (Valerate, Benzoate, Cypionate, Enanthate, Undecylate), Oral, Sublingual, Gel, and Patches.

  **多给药途径模拟**：支持注射（戊酸酯 Valerate、苯甲酸酯 Benzoate、环戊丙酸酯 Cypionate、庚酸酯 Enanthate、十一酸酯 Undecylate）、口服、舌下、凝胶以及贴片等多种给药方式。

- **Both HRT directions**: Oestrogen records (estradiol and its esters) and testosterone records (unesterified T, cypionate, enanthate, undecanoate), each with its own curve.

  **两个方向都支持**：雌激素记录（雌二醇及其酯类）与睾酮记录（未酯化 T、环戊丙酸酯、庚酸酯、十一酸酯），各自有独立的曲线。

- **Anti-androgens are recorded, not simulated**: cyproterone acetate, spironolactone and bicalutamide have no useful concentration curve — spironolactone's half-life is about 1.4 hours and what acts are its metabolites, CPA's steady state is a flat line at a half-life of 1.5–4 days, and bicalutamide blocks the receptor without lowering testosterone at all. They contribute no curve and no "E2 equivalent"; what they get instead is monitoring, and every threshold shown has a source.

  **抗雄药只记录、不建模**：醋酸环丙孕酮、螺内酯与比卡鲁胺没有有意义的血药浓度曲线——螺内酯半衰期约 1.4 小时、起效的是代谢产物，CPA 半衰期 1.5–4 天故稳态近乎直线，比卡鲁胺则只阻断受体、完全不降睾酮。它们不贡献曲线，也不显示「E2 当量」；取而代之的是监测，而且界面上每一个阈值都有出处。

- **Monitoring that cites itself**: prolactin, ALT, AST and potassium can be recorded with the reference limit printed on your own report, and the app raises a notice only at the multiples the sources give (prolactin above 3×, ALT above 2×, potassium at 5.0 mmol/L, cumulative CPA at 10 g). Where the sources disagree — CPA and meningioma screening — both recommendations are shown and neither is turned into an instruction. Bilirubin is not collected because no source named it, and no reminder is invented for an interval the sources do not state.

  **会注明依据的监测**：可以连同**你化验单上印的参考上限**一起记录泌乳素、ALT、AST 与血钾；应用只在来源给出的倍数上提示（泌乳素 > 3×、ALT > 2×、血钾 ≥ 5.0 mmol/L、CPA 累积 ≥ 10 g）。当来源彼此冲突时——CPA 与脑膜瘤筛查——**两条建议都列出，且都不写成指令**。胆红素因为没有任何来源提到而不收集；来源没有给出间隔的复查，也不会凭空生成提醒。

- **Re-check reminders with a stated basis**: monthly liver enzymes for the first six months of CPA or bicalutamide and quarterly after, quarterly potassium for the first year of spironolactone and annually after. The clock is anchored to the first recorded dose of that compound, which is an upper bound on the true start — stated on screen, and it errs toward a late reminder rather than a false one. No doses of a compound means no reminder at all.

  **有依据的复查提醒**：CPA 或比卡鲁胺前六个月每月查肝酶、之后每季度；螺内酯首年每季度查血钾、之后每年。计时锚点是**该药的第一条记录**，那是真实起始时间的上界——界面会说明这一点，而且它偏向**提醒得晚**而不是误报。**没有该药记录时完全不提醒。**

- **Body and mood journal**: a private, plain-text note — a time and what it felt like, with no scores and no advice, because the experience scales are not clinical signals.

  **体感记录**：私密的纯文本记录——时间和当时的感受，不打分、不给建议，因为这些自评量表并不是临床信号。

- **Lab report scanning**: photograph or pick a report and the app reads the oestrogen and progesterone values out of it, offline, using its own bundled OCR assets. The values only prefill the form; nothing is saved until you confirm it. A scan that cannot read a value says so rather than guessing.

  **化验单扫描**：拍照或选择一张化验单，应用用**自带、离线**的 OCR 资源读出其中的雌二醇与孕酮数值。识别结果只用于预填表单，**未经你确认不会保存**；读不出数值时会直说，而不是猜。

- **Privacy by Default**: The app works offline-first — what you enter is kept in your browser and shown immediately. Once signed in, records are also stored on the server, each **sealed with your account's own data key and stored as an AES-256-GCM payload**, with only the timestamp and category left readable for paging. Be clear about what that is and is not: it is **not** end-to-end encryption. The server holds a copy of your data key so that it can decrypt on read, so the honest claims are (a) a stolen database dump is useless without the key, and (b) a leaked key for one account is no longer the whole database — which is why records are sealed per account rather than under one deployment-wide key. It is not the claim that the operator cannot see your data.

  **默认保护隐私**：应用可以离线优先使用——你录入的内容保存在浏览器中并立即显示。登录之后记录同时保存在服务器上，**每条记录都用你自己账号的数据密钥封装、以 AES-256-GCM 密文保存**，只有时间戳与类别保持明文以便分页。它**不是**端到端加密，这一点必须说清楚：服务器持有你数据密钥的副本，才能在读取时解密，所以诚实的说法是（a）数据库被拖走、没有这把密钥则读不出来；（b）**一个账号的密钥泄露不再等于整个数据库**——这正是记录改为按账号封装而不是全部署共用一把密钥的原因。**而不是**「运营方看不到你的数据」。

  Share links upload a read-only copy of the dosage history, modelled curve, and timezone until they expire; optional live links refresh that copy while the signed-in app is open. Share links never include lab results, weight, profile details, or account data.

  分享链接会保存一份只读的用药记录、模型曲线和时区副本，直到链接过期；可选的实时链接会在已登录的应用打开时刷新该副本。分享链接**不会**包含化验结果、体重、个人资料或账户数据。

- **Agent Access Tokens**: Connecting an AI assistant (MCP) uses a long-lived token you paste into its config. The token is a full credential for your records: the server holds a copy of your data key, so the assistant reads and writes them with no browser session, no unlock, and no expiry. Signing out does not stop it — only revoking the token in Settings or changing your password does. Treat it exactly as you would treat your password. Anything the assistant reads leaves this system and is governed by that provider's privacy policy.

  **AI 助手访问令牌**：连接 AI 助手（MCP）需要把一个长期令牌粘贴进它的配置。该令牌是你的记录的**完整凭据**：服务器持有你数据密钥的副本，所以助手无需浏览器会话、无需解锁、也不会过期。退出登录拦不住它——只有在设置中吊销该令牌或修改密码才行。请像对待密码一样对待它。助手读到的任何内容都会离开本系统，并受该服务商隐私政策约束。

- **Internationalization**: Native support for **Simplified Chinese**, **Traditional Chinese**, **Cantonese**, **English**, **Japanese**, **Korean**, and **Turkish** — seven locales, with a coverage check that fails the build if any one of them is missing a string.

  **多语言支持**：原生支持**简体中文、繁体中文、粤语、英语、日语、韩语、土耳其语**共 7 种语言，并有覆盖率检查——任何一种语言缺字符串都会导致构建失败。

---

## Connecting an AI assistant 连接 AI 助手

The server speaks **MCP over Streamable HTTP**, so Claude Desktop, Cursor, VS Code or an agent you wrote can read and write a record. `server/MCP.md` is the reference: the endpoint, the two credential shapes, the tool list, and the config snippets.

服务端支持 **MCP over Streamable HTTP**，因此 Claude Desktop、Cursor、VS Code 或你自己写的 agent 都能读写记录。`server/MCP.md` 是参考文档：端点、两种凭据形态、工具清单与配置片段。

The app builds a self-contained prompt for this — copy it from **Account → Connect an AI assistant** and paste it into any assistant, which will find its own config file and wire itself up.

应用会为此生成一段自包含的提示词——在**账户 → 连接 AI 助手**里复制，粘给任何助手，它会自己找到配置文件并完成接入。

---

## 🧪 Run Locally 本地运行

This project is built with **React** and **TypeScript**, bundled with [Vite](https://vitejs.dev/).

本项目基于 **React** 与 **TypeScript** 构建，使用 [Vite](https://vitejs.dev/) 打包。

1. **Clone the repository 克隆仓库**

   ```bash
   git clone https://github.com/xingqimiao/Kira-s-HRT-Tracker.git
   ```

2. **Install dependencies 安装依赖**

   ```bash
   # using npm
   npm install

   # or using pnpm
   pnpm install
   ```

3. **Start the dev server 运行项目**

   ```bash
   npm run dev
   # or: pnpm dev
   ```

   Then open <http://localhost:3000> in your browser.

   然后在浏览器中打开 <http://localhost:3000>。

   The dev server also proxies `/api` to the Node service on `127.0.0.1:8787` (see
   `vite.config.ts`), so the app can be developed against a local backend.

   开发服务器同时把 `/api` 代理到 `127.0.0.1:8787` 上的 Node 服务（见
   `vite.config.ts`），因此可以对着本地后端开发。

---

## Self-hosting 自行托管

The app is a static React build served by any web server, talking to the Node service
in `server/`. That service owns all persistent state: one Postgres database, records
stored as per-account AES-256-GCM ciphertext, and OAuth credentials for whichever
providers you configure.

本应用是一个静态 React 构建产物，用任何 web 服务器托管即可，后端是 `server/` 里的
Node 服务。所有持久状态都在它这里：一个 Postgres 数据库（记录以**按账号封装**的
AES-256-GCM 密文保存），以及你自己配置的 OAuth 凭据。

`server/DEPLOY.md` is the runbook: database and role, the environment variables (at
minimum `DATABASE_URL`, `ENCRYPTION_KEY`, `SERVER_DEK_KEY`, `PUBLIC_ORIGIN`,
`API_ORIGIN`, `BASE_PATH`), the systemd unit, the Caddy site block, and the pre-deploy
ownership check that a hand-run migration will otherwise trip. Read it before your
first deploy — three of its warnings come from outages this project actually had.

`server/DEPLOY.md` 是部署手册：数据库与角色、环境变量（至少 `DATABASE_URL`、
`ENCRYPTION_KEY`、`SERVER_DEK_KEY`、`PUBLIC_ORIGIN`、`API_ORIGIN`、`BASE_PATH`）、
systemd 单元、Caddy 站点配置，以及「手工迁移会踩到」的部署前属主检查。首次部署前请
先读它——其中三条警告都来自这个项目真实发生过的事故。

The two keys can also be supplied as **systemd encrypted credentials** rather than
`.env` lines, which keeps them off the disk they protect; `config.ts` reads the
credential first and falls back to the environment, and logs at boot which one it used.

这两把密钥也可以改用 **systemd 加密凭据**提供，而不是写在 `.env` 里，这样它们就不
与所保护的数据同处一块磁盘；`config.ts` 优先读凭据、缺失时回退到环境变量，并在启动
日志里说明最终用的是哪一种。

Build the web app **with the API origin set**, or every request goes same-origin and
the OAuth buttons silently disappear:

构建前端时**必须指定 API 源**，否则所有请求都会打到同源地址，OAuth 按钮会无声消失：

```bash
VITE_API_ORIGIN=https://your-api-host/hrt npm run build
```

That failure is worth spelling out because nothing else reports it: against the static
host the `/health` request returns the SPA shell with HTTP 200, the app treats an
unreadable answer as "no provider configured", and the sign-in buttons are simply not
rendered. Verify it in the built bundle:

这个失效值得说清楚，因为**没有任何别的东西会报告它**：对着静态主机会让 `/health`
返回 HTTP 200 的 SPA 外壳，应用把「读不出来」当成「没有配置任何 provider」，于是登录
按钮直接不渲染。用下面这条确认构建产物：

```bash
grep -c "your-api-host" dist/assets/index-*.js
```

There is no Docker image and no Cloudflare Worker any more. This repository used to
ship a Worker + D1 + R2 stack with a published container image; both were removed when
the service moved to the Node backend above.

本仓库不再提供 Docker 镜像与 Cloudflare Worker。此前曾随附 Worker + D1 + R2 与已发布
的容器镜像；服务迁移到上面这套 Node 后端之后，两者都已移除。
