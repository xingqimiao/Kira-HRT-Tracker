# HRT Recorder Web

**HRT Recorder Web** — A privacy-focused, web-based tool for simulating and tracking estradiol levels during Hormone Replacement Therapy (HRT).

**HRT Recorder Web**（HRT 网页记录工具）——一个注重隐私的网页工具，用于在激素替代疗法（HRT）期间模拟和追踪雌二醇水平。

---

## Algorithm & Core Logic 算法逻辑

The pharmacokinetic algorithms, mathematical models, and parameters used in this simulation are derived directly from the **[HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test)** repository.

本模拟中使用的药代动力学算法、数学模型与相关参数，直接来源于 **[HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test)** 仓库。

We strictly adhere to the `PKcore.swift` and `PKparameter.swift` logic provided by **@LaoZhong-Mihari**, ensuring that the web simulation matches the accuracy of the original native implementation (including 3-compartment models, two-part depot kinetics, and specific sublingual absorption tiers).

我们严格遵循 **@LaoZhong-Mihari** 提供的 `PKcore.swift` 与 `PKparameter.swift` 中的逻辑，确保网页端模拟与原生实现在精度上保持一致（包括三室模型、双相肌注库房动力学以及特定的舌下吸收分层等）。

---

## Features 功能

- **Multi-Route Simulation**: Supports Injection (Valerate, Benzoate, Cypionate, Enanthate), Oral, Sublingual, Gel, and Patches.

  **多给药途径模拟**：支持注射（戊酸酯 Valerate、苯甲酸酯 Benzoate、环戊丙酸酯 Cypionate、庚酸酯 Enanthate）、口服、舌下、凝胶以及贴片等多种给药方式。

- **Real-time Visualization**: Interactive charts showing estimated estradiol concentration (pg/mL) over time.

  **实时可视化**：通过交互式图表展示随时间变化的雌二醇估算浓度（pg/mL）。

- **Sublingual Guidance**: Detailed "Hold Time" and absorption parameter (θ) guidance based on strict medical modeling.

  **舌下服用指导**：基于严格的医学建模，提供详细的"含服时间（Hold Time）"与吸收参数（θ）参考。

- **Privacy by Default**: The app works offline-first — what you enter is kept in your browser and shown immediately. Once you are signed in your records are also stored on the server, **encrypted as a whole AES-256-GCM payload**, with only the timestamp and category left readable for paging. This is not end-to-end encryption: the key lives on the server, so the honest claim is that a stolen database dump is useless without it — not that the operator cannot see your data. A share link uploads a read-only copy of the dosage history, modelled curve, and timezone until its expiration; optional live links refresh that copy when the signed-in app is open. Share links never include lab results, weight, profile details, or account data.

  **默认保护隐私**：应用可以离线优先使用——你录入的内容保存在浏览器中并立即显示。登录之后记录同时保存在服务器上，并以**整包 AES-256-GCM 密文**存储，只有时间戳与类别保持明文以便分页。这**不是**端到端加密：密钥在服务器上，所以诚实的说法是「数据库被拖走、没有这把密钥则读不出来」，而**不是**「运营方看不到你的数据」。分享链接会保存一份只读的用药记录、模型曲线和时区副本，直到链接过期；其中不会包含检查结果、体重、个人资料或账户数据。

- **Agent Access Tokens**: Connecting an AI assistant (MCP) uses a long-lived token you paste into its config. The token is a full credential for your records: the server holds a copy of your data key, so the assistant reads and writes them with no browser session, no unlock, and no expiry. Signing out does not stop it — only revoking the token in Settings or changing your password does. Treat it exactly as you would treat your password. Anything the assistant reads leaves this system and is governed by that provider's privacy policy.

  **AI 助手访问令牌**：连接 AI 助手（MCP）需要把一个长期令牌粘贴进它的配置。该令牌是你的记录的**完整凭据**：服务器持有你数据密钥的副本，所以助手无需浏览器会话、无需解锁、也不会过期。退出登录拦不住它——只有在设置中吊销该令牌或修改密码才行。请像对待密码一样对待它。助手读到的任何内容都会离开本系统，并受该服务商隐私政策约束。

- **Internationalization**: Native support for **Simplified Chinese**, **English**, **Cantonese**, **Russian**, **Ukrainian**, and more.

  **多语言支持**：原生支持简体中文、英语、粤语、俄语、乌克兰语等多语言界面。

---

## 🧪 Run Locally 本地运行

This project is built with **React** and **TypeScript**, bundled with [Vite](https://vitejs.dev/).

本项目基于 **React** 与 **TypeScript** 构建，使用 [Vite](https://vitejs.dev/) 打包。

1. **Clone the repository 克隆仓库**

   ```bash
   git clone https://github.com/SmirnovaOyama/Oyama-s-HRT-Tracker.git
   cd Oyama-s-HRT-Tracker
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

---

## Self-hosting 自行托管

The app is a static React build served by any web server, talking to the Node service
in `server/`. That service owns all persistent state: one Postgres database, records
stored as whole-payload AES-256-GCM ciphertext, and OAuth credentials for whichever
providers you configure.

本应用是一个静态 React 构建产物，用任何 web 服务器托管即可，后端是 `server/` 里的
Node 服务。所有持久状态都在它这里：一个 Postgres 数据库（记录以整包 AES-256-GCM
密文保存），以及你自己配置的 OAuth 凭据。

`server/DEPLOY.md` is the runbook: database and role, the environment variables (at
minimum `DATABASE_URL`, `ENCRYPTION_KEY`, `SERVER_DEK_KEY`, `PUBLIC_ORIGIN`,
`API_ORIGIN`, `BASE_PATH`), the systemd unit, the Caddy site block, and the pre-deploy
ownership check that a hand-run migration will otherwise trip. Read it before your
first deploy — three of its warnings come from outages this project actually had.

`server/DEPLOY.md` 是部署手册：数据库与角色、环境变量（至少 `DATABASE_URL`、
`ENCRYPTION_KEY`、`SERVER_DEK_KEY`、`PUBLIC_ORIGIN`、`API_ORIGIN`、`BASE_PATH`）、
systemd 单元、Caddy 站点配置，以及「手工迁移会踩到」的部署前属主检查。首次部署前请
先读它——其中三条警告都来自这个项目真实发生过的事故。

Build the web app **with the API origin set**, or every request goes same-origin and
the OAuth buttons silently disappear:

构建前端时**必须指定 API 源**，否则所有请求都会打到同源地址，OAuth 按钮会无声消失：

```bash
VITE_API_ORIGIN=https://your-api-host/hrt npm run build
```

There is no Docker image and no Cloudflare Worker any more. This repository used to
ship a Worker + D1 + R2 stack with a published container image; both were removed when
the service moved to the Node backend above.

本仓库不再提供 Docker 镜像与 Cloudflare Worker。此前曾有一套 Worker + D1 + R2 以及
发布到镜像仓库的容器镜像，在服务迁移到上面的 Node 后端时一并删除。

---

## Deployment & Hosting 部署与托管

You are **very welcome** to deploy this application to your own personal website, blog, or server!

我们**非常欢迎**你将此应用部署到自己的个人网站、博客或服务器上！

We want this tool to be accessible to everyone who needs it. You do not need explicit permission to host it.

我们希望所有需要这款工具的人都能方便地使用它。你无需额外获得授权即可自行托管与部署。

**Attribution Requirement 署名要求**

If you deploy this app publicly, please: / 如果你将该应用公开部署，请：

1. **Keep the original algorithm credits**: Visibly link back to the [HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test) repository.

   **保留原始算法的鸣谢信息**：在显眼位置添加指向 [HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test) 仓库的链接。

2. **Respect the license**: Ensure you follow any licensing terms associated with the original algorithm code.

   **遵守许可协议**：确保你遵循原始算法代码所适用的全部许可条款。

---

I wish you a smooth transition and Happy Estimating! 🏳️‍⚧️
祝你性转顺利，快乐估测(>^ω^<)

同时，祝所有用此 webapp 的停经期女性身体健康 ❤️

At the same time, I wish good health to all the women using this web app who are going through menopause. ❤️


---

## License 许可

本项目遵守 MIT License。See [LICENSE](./LICENSE) for details.

**这不覆盖全部内容。** 药代动力学模型并非 MIT 授权，而是由版权持有人单独授予的
**非商业** 许可 —— 详见 [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md)。

The MIT licence covers the web application, which is forked from an MIT-licensed
project. **It does not cover everything in this repository:** the pharmacokinetic
model is used under a separate **non-commercial** grant from its author, so this
project may not be sold or monetised on the strength of MIT alone. See
[THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md) for the terms and what they
cover.
