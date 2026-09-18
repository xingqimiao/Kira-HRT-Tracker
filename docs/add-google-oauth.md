# Google OAuth：现状、Console 配置与品牌验证

> 更新：2026-09-19。**Google 登录已实现并已接入前端**；本文分成「实现现状」、
> 「Console 怎么填」、「品牌验证为什么会被打回」三部分。

---

## 1. 实现现状（代码已完成，不用再改）

| 位置 | 内容 |
|---|---|
| `server/src/oauth.ts:244` | `GOOGLE_SCOPE = 'openid'` —— **只申请 `openid`** |
| `server/src/oauth.ts:287` | `parseGoogleIdToken`：只读 ID token 的 `sub`/`aud`/`iss`/`exp`/`nonce` |
| `server/src/oauth.ts:337` | `exchangeGoogleCode`：client secret 放在表单体里 |
| `server/src/config.ts:291` | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` |
| `server/src/http.ts:437` | `GET /auth/google/start` → `{ authorize_url }` |
| `server/src/http.ts:453` | `GET /auth/google/callback` → 302 回前端，带一次性 code |
| `server/src/http.ts:323` | `/health` 的 `google_login` 标志，前端据此决定是否显示按钮 |

三条与「常见写法」不同、且是有意的决定：

1. **身份取自 ID token，不调 userinfo。** `sub` 是 Google 保证恒定、永不复用的账号
   id，token 里就有，所以不需要第二次 HTTP 请求，也不需要 `profile` 权限。
2. **不要 `email`，也不要 `profile`。** 我们只需要「同一个人」，不需要邮箱或姓名
   （Google 自己说 email 声明可能不唯一、可能不是本账号的）。少一个权限，就少一
   项要向 Google 证明「你为什么要它」的说明义务，也就少一次敏感权限审核。
   代价是账号没有可显示的名字与头像 —— 这是刻意的，见
   `parseGoogleIdToken` 里 `handle: null, avatarUrl: null` 的注释。
3. **不用 PKCE，不取 refresh token。** Google 的 web client 用 client secret 认证；
   我们只在登录那一刻读一次身份，之后不再代表用户调用任何 Google API。没有长期
   凭据，就没有长期凭据可泄露。

**不加 `access_type=offline`**：那会换来一个 refresh token，而我们没有任何用途。

---

## 2. Google Cloud Console 怎么填

### 2.1 凭据

OAuth client 类型 **Web application**，Authorized redirect URIs **逐字**填
（Google 精确匹配，大小写、协议、路径、结尾斜杠都算）：

```
https://api.kiramyao.com/hrt/auth/google/callback
```

`authorized JavaScript origins` **留空**：我们走服务端流程（code 换 token 在后端
完成），浏览器从不直接跟 Google 说话。

本地开发另加一条 `http://localhost:5173/auth/google/callback` —— Google 只对
localhost 放行 `http`，其他域名一律 `https`。

### 2.2 同意屏幕（新版 Console 叫 Google Auth Platform）

| 字段 | 填什么 |
|---|---|
| User type | **External** |
| App name | `Kira Tracker` |
| User support email | 你自己的邮箱（Google 会往这里发审核邮件，必须是你在看的地址） |
| Application home page | `https://hrt.kiramyao.com/` |
| Application privacy policy link | `https://hrt.kiramyao.com/privacy` |
| Application terms of service link | **留空**（见下） |
| Authorized domains | `kiramyao.com` |
| Scopes | 只加 `openid`；**不要**加 Gmail / Drive / Calendar 等 |

**Terms of service 留空。** Google 明确写了它是 optional。本仓库此前有过一个
`/terms`，后来被删掉，理由是：去掉与「不是医疗器械、不构成医疗建议」重复的部分
之后，剩下的（适用法律、管辖、责任上限）都是对一个并不存在的法律主体所做的猜测
（见 `DEPLOY.md` §1）。一条编出来的条款比没有条款更糟，所以这一次没有再写一份。
医疗免责声明仍然放在用户真正要做决定的地方：应用内的 `DisclaimerModal`，以及分享
图表下方那一行。

**Authorized domains 填的是「top private domain」，不是主机名。**
home page、privacy、以及 redirect URI 的主机（`api.kiramyao.com`）全都归到同一个
`kiramyao.com`，所以这里**只有一行**。

### 2.3 域名所有权（最容易漏的一步）

必须用**与 Cloud Console 项目同一个 Google 账号**，在
[Search Console](https://search.google.com/search-console/about) 里把
`kiramyao.com` 验证为 owner。Google 的品牌验证会自动去核对这一点，没验证过就会
以「无法确认域名所有权」打回，而且这条通常不会在自动检查里说得那么直白。

---

## 3. 品牌验证要求与本次被打回的原因

Google 官方要求（[Submit for brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)）
的原文有两条是硬性的：

> **Home page:** Your home page must be publicly accessible, and not just accessible
> to your site's logged-in users. The relevance of your home page to the app that's
> under review must be clear.

> **Privacy policy:** The privacy policy must be visible to users, **hosted within the
> same domain as your application's home page**, and linked to on the OAuth consent
> screen … the home page must include a description of the app's functionality, as
> well as **links to the privacy policy** and optional terms of service.

对照本次实测到的状态：

| 要求 | 打回时的实际状态 | 已做的修复 |
|---|---|---|
| 首页能说明应用是什么 | `hrt.kiramyao.com/` 是客户端渲染的 SPA，初始 HTML 只有 12 个可见字符，而校验器**不执行 JavaScript** | `index.html` 里 `#root` 内写入真实静态内容（应用名、用途、功能列表、隐私政策链接）；`index.tsx` 首次渲染前 `replaceChildren()` 清掉，浏览器不会看到两份 |
| 隐私政策与首页**同域** | `kiramyao.com/privacy` 是真实政策，但**不同域**；`hrt.kiramyao.com/privacy` 返回空 SPA 外壳 | 新增 `public/privacy/index.html`，实际部署为 `hrt.kiramyao.com/privacy` |
| 首页有 privacy 链接 | 无 | 首页静态内容里已加 |
| 隐私政策写明 Google 数据怎么用 | 原政策未提及 Google | 新增页面第 2 节：只申请 `openid`、只收到 `sub`、只用于识别同一次登录，并附 Limited Use 声明 |
| 条款页可达 | `hrt.kiramyao.com/terms` 是空外壳 | **不修**：这一项 Google 标为 optional，而本仓库此前已决定不发布条款页（理由见 §2.2） |

**`/privacy` 当时为什么是空壳**（两个原因叠在一起，都已解决）：

1. `/srv/hrt-web/` 下没有 `privacy/` 目录，Caddy 的
   `try_files {path} {path}/index.html /index.html` 于是回退到 SPA 外壳。
   Caddyfile 里那段注释记的就是这次踩坑：`{path}/index.html` 必须写在 `try_files`
   里，且不能用 `not file` 匹配器改写 —— `file` 只看「是不是文件」，目录会被判为
   未命中。Caddy 侧已经不需要再改，**只要目录存在就会被正确服务**。
2. service worker 的导航回退会把 `/privacy` 也换成预缓存的 `index.html`，而且是
   **从缓存里换**，在线也一样。这会让「装过应用的老人」永远看到应用外壳，只有从没
   装过的人（比如 Google 的审核员）看到真页面 —— 也就是说问题会伪装成没问题。
   `vite.config.ts` 的 `navigateFallbackDenylist` 已加入 `^/privacy`。

> 隐私政策还必须**写明如何使用 Google 用户数据**。`public/privacy/index.html`
> 第 2 节直接写了「只申请 `openid`、只收到 `sub`、只用于识别同一次登录」，并带上
> Limited Use 声明 —— 这三句必须与代码一致，改 `GOOGLE_SCOPE` 时请连着改它。

---

## 4. 环境变量与部署

在 `/srv/hrt/.env` 追加（**不要**覆盖已有内容）：

```bash
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
GOOGLE_REDIRECT_URI=https://api.kiramyao.com/hrt/auth/google/callback
```

`.env` 权限保持 `600 hrt:hrt`。然后按常规流程：提交 → 构建 → 上传 → 重启。

```bash
sudo systemctl restart hrt-server
sudo journalctl -u hrt-server --since "-1min" --no-pager | tail -5
```

---

## 5. 验证

**顺序很重要：先验证配置，再验证功能**，否则一个错配会伪装成代码 bug。

```bash
# 1. 服务端认为 Google 可用
curl -s https://api.kiramyao.com/hrt/health | python3 -m json.tool | grep google_login

# 2. start 端点返回授权 URL，并核对 redirect_uri 与 Console 里逐字一致
curl -s https://api.kiramyao.com/hrt/auth/google/start | python3 -m json.tool

# 3. 静态页真的被服务（不能是 2,837 字节的 SPA 外壳）
curl -s https://hrt.kiramyao.com/privacy | wc -c      # 期望 ~12,000，不是 ~2,800
curl -s https://hrt.kiramyao.com/privacy | grep -c 'openid'   # 期望 >= 1
# 首页也要有可见文字，且能读到应用名与政策链接
curl -s https://hrt.kiramyao.com/ | grep -c 'Kira Tracker'
curl -s https://hrt.kiramyao.com/ | grep -c '/privacy'
```

再走一遍真实登录（浏览器**先清 service worker**，否则看到的是旧前端）：

1. 登录页出现 Google 按钮；
2. 点进去 → 授权 → 回到应用且已登录；
3. 确认绑定行：

   ```sql
   SELECT provider, provider_user_id, handle FROM oauth_accounts WHERE provider = 'google';
   ```

4. **关键一条**：这个账号**没有密码**，登录方式总览应报 `recovery_risk = true`：

   ```
   GET /auth/login-methods  →  { has_password: false, providers: ["google"], recovery_risk: true }
   ```

   看到 `recovery_risk: true` 说明「绑定账号名 + 密码」的引导会正确出现 —— 这正是
   整个绑定机制存在的理由：Google 账号被封时，记录还进得去。

---

## 6. 三个坑

1. **`redirect_uri_mismatch`**：Google 精确匹配。生产路径带 `/hrt` 前缀，
   漏掉就是错配。
2. **用 email 当账号键**：绝对不要，用 `sub`。邮箱可改、可回收，用它做键会让一次
   邮箱变更转移账号访问权。
3. **忘了 Publish**：`External` + `Testing` 状态下只有测试用户能登录，其他人看到
   "Access blocked"。上线前点 Publish；因为只申请 `openid`，通常不需要人工审核数据
   权限，但品牌信息仍需通过品牌验证，且**未验证时用户会看到「未验证应用」警告页**。
