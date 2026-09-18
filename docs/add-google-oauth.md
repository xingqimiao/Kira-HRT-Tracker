# 如何添加 Google OAuth 登录

> 现状（2026-09-19）：**X 已实现，Google 尚未实现。**
> 数据库与类型已经就绪（`oauth_accounts.provider` 已放开到 `'x' | 'google'`，
> 见 `server/schema.sql`），缺的是 provider 实现与配置。
> 预计工作量：**半天以内**，其中一半是 Google Cloud Console 的点击。

---

## 0. 为什么容易加：现有实现已经是「一个 provider 的形状」

`server/src/oauth.ts` 里只有 **3 个常量和 1 个映射函数**是 X 专属的，其余（PKCE
生成、state、code 交换、错误类型）与 provider 无关：

| 位置 | 内容 | Google 对应 |
|---|---|---|
| `oauth.ts:24` | `AUTHORIZE_ENDPOINT` | `https://accounts.google.com/o/oauth2/v2/auth` |
| `oauth.ts:25` | `TOKEN_ENDPOINT` | `https://oauth2.googleapis.com/token` |
| `oauth.ts:26` | `PROFILE_ENDPOINT` | `https://openidconnect.googleapis.com/v1/userinfo` |
| `oauth.ts:45` | `SCOPE = 'users.read tweet.read'` | `openid email profile` |
| `oauth.ts:149-197` | `XProfile` 类型 + `fetchProfile` 映射 | Google 的 userinfo 形状 |
| `oauth.ts:199` | `upgradeAvatarSize` | **X 专属**，Google 不需要（头像本来就是 96px+） |

`buildAuthorizeUrl` / `exchangeCode` **本来就是通用的**——它们只接收端点与 client 凭据。
所以正确的做法是**把它们参数化**，而不是复制一份 `google.ts`。

---

## 1. 第一步：在 Google Cloud Console 建凭据（你自己做，约 15 分钟）

1. 打开 <https://console.cloud.google.com/>，新建（或选择）一个项目。
2. **APIs & Services → OAuth consent screen**
   - User type：**External**
   - App name、support email、developer contact 必填
   - **Scopes**：只加 `openid`、`email`、`profile` 三个。**不要**申请任何 Gmail / Drive 权限
     （会触发 Google 的敏感权限审核，几周起步，而我们只需要知道"你是谁"）
   - Test users：开发阶段把你的 Google 账号加进去（否则 `External` + 未发布状态下只有测试用户能登录）
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type：**Web application**
   - **Authorized redirect URIs** 必须**逐字**填（Google 是精确匹配，多一个斜杠都会失败）：
     ```
     https://api.kiramyao.com/hrt/auth/google/callback
     ```
   - 开发用再加一条本地的（见 §4）
4. 保存后拿到 **Client ID** 与 **Client secret**。

> **发布状态**：`External` + `Testing` 状态下 refresh token 7 天过期、且只有测试用户能登录。
> 要让所有人用，需要在 consent screen 点 **Publish app**。因为只申请了三个基础 scope，
> 通常不需要 Google 人工审核，但**会显示"未验证应用"警告**，用户需点「高级 → 继续」。

---

## 2. 第二步：改代码（4 处）

### 2.1 `config.ts`：把 X 配置泛化成 provider 表

```ts
// 现在
x: XOAuthConfig | null;

// 改成（保留 x 便于过渡，新增 google）
google: XOAuthConfig | null;
```

在 `loadConfig` 里照 `x` 的写法加一段（`config.ts:256-273` 附近）：

```ts
const gClientId = env.GOOGLE_CLIENT_ID?.trim();
const gClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
let google: XOAuthConfig | null = null;
if (gClientId || gClientSecret) {
  if (!gClientId) throw new ConfigError('GOOGLE_CLIENT_ID is required when Google login is configured');
  if (!gClientSecret) throw new ConfigError('GOOGLE_CLIENT_SECRET is required when Google login is configured');
  google = {
    clientId: gClientId,
    clientSecret: gClientSecret,
    redirectUri: env.GOOGLE_REDIRECT_URI?.trim()
      ?? `${apiOrigin}${basePath}/auth/google/callback`,
  };
}
```

### 2.2 `oauth.ts`：端点参数化 + Google 的 profile 映射

把 3 个常量收进一个 provider 描述表，`buildAuthorizeUrl` / `exchangeCode` 接收它：

```ts
export interface OAuthProvider {
  name: 'x' | 'google';
  authorizeEndpoint: string;
  tokenEndpoint: string;
  scope: string;
  /** true 时 token 端点需要 client_secret（X 的 confidential client 走 Basic，Google 走表单） */
  clientSecretInBody: boolean;
}

export const PROVIDERS: Record<'x' | 'google', OAuthProvider> = {
  x: { name: 'x', authorizeEndpoint: '…/i/oauth2/authorize', tokenEndpoint: '…/oauth2/token', scope: 'users.read tweet.read', clientSecretInBody: false },
  google: {
    name: 'google',
    authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    clientSecretInBody: true,
  },
};
```

> **一个真实差异，必须处理**：Google 的 authorize 端点要求 `access_type=offline`
> 才发 refresh token，而**我们不需要 refresh token**——我们只在登录那一刻读一次
> userinfo。所以**不要**加 `access_type=offline`，少一个长期凭据就少一个泄露面。

`fetchProfile` 加一个 Google 分支，返回统一形状：

```ts
export interface OAuthProfile {
  providerUserId: string;   // 不可变 id
  handle: string | null;
  avatarUrl: string | null;
}
```

Google 的 `userinfo` 返回 `{ sub, email, email_verified, name, picture }`：

```ts
// sub 是 Google 的不可变用户 id —— 和 X 的数值 id 一样，绝不能用 email 当键：
// 邮箱可变、可被回收再分配给他人，用它做键会让一次邮箱变更转移账号访问权。
providerUserId: body.sub,
handle: body.email ?? null,
avatarUrl: typeof body.picture === 'string' ? body.picture : null,
```

**必须校验 `email_verified === true`** 再把它当 handle 展示。未验证的邮箱不属于用户，
展示它等于替 Google 说谎。

### 2.3 `accounts.ts` / `http.ts`：加路由

现有路由（`http.ts:430-496`）是 X 专属的路径 `/auth/x/start`、`/auth/x/callback`。
加同样的两条：

```
GET /auth/google/start     → { authorize_url }
GET /auth/google/callback  → 302 回前端，带一次性 code
```

`createAccountFromX` 已经做了「按 `(provider, provider_user_id)` 查 → 没有则建号」，
把它泛化成 `createAccountFromProvider(provider, profile)` 即可。**注意建号时仍要生成
username**（`usernameFromHandle`，Google 用 email 的 @ 前部分），并做唯一性重试。

`oauth_states` 表已存在，`state` 里记 provider 即可，不必改表。

### 2.4 前端：登录页加一个按钮

`CoreAuthForm.tsx:604` 现在是 `{xAvailable && (…)}`。加一个同形状的 Google 分支，
`coreAuth.xAvailable()` 相应改为返回 `{ x: boolean, google: boolean }`
（它读的是 `/health`，服务端加 `google_login` 字段即可，照 `http.ts:308` 的 `x_login` 写）。

---

## 3. 第三步：环境变量与上线

在 `/srv/hrt/.env` 追加（**不要**覆盖已有内容）：

```bash
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
GOOGLE_REDIRECT_URI=https://api.kiramyao.com/hrt/auth/google/callback
```

`.env` 的权限是 `600 hrt:hrt`，照旧。然后：

```bash
# 本地：提交 → 构建 → 上传 → 重启   见 DEPLOY.md
sudo systemctl restart hrt-server
sudo journalctl -u hrt-server --since "-1min" --no-pager | tail -3
# 期望看到启动行里出现 google=on（照 x_login=on 的写法加一个）
```

---

## 4. 第四步：验证

**顺序很重要，先验证配置再验证功能**，否则一个错配会伪装成代码 bug。

```bash
# 1. 配置被读到了吗（服务端启动行应打印 google=on）
sudo journalctl -u hrt-server --since "-1min" --no-pager | grep -i google

# 2. start 端点返回授权 URL，且 redirect_uri 与 Console 里逐字一致
curl -s 'https://api.kiramyao.com/hrt/auth/google/start' | python3 -m json.tool
#    把返回的 authorize_url 里的 redirect_uri 参数抄出来，与 Google Console
#    里填的那条对比：**必须完全一致**，差一个字符就是 redirect_uri_mismatch
```

**然后走一遍真实的登录**（浏览器，注意先清 service worker，否则会看到旧前端）：

1. 登录页应出现 Google 按钮
2. 点进去 → Google 授权 → 回到应用并已登录
3. `psql` 确认绑定行：
   ```sql
   SELECT provider, provider_user_id, handle FROM oauth_accounts WHERE provider = 'google';
   ```
4. **关键一条**：这个新账号应当**没有密码**，登录方式总览应报 `recovery_risk = true`
   ```
   GET /auth/login-methods   → { has_password: false, providers: ["google"], recovery_risk: true }
   ```
   看到 `recovery_risk: true` 说明防封禁引导会正确提示他绑定账号名+密码——
   这正是整个绑定机制存在的理由。

**本地开发**：Console 里再加一条 `http://localhost:5173/auth/google/callback`（或你的端口），
并且 Google 只接受 `http` 的 **localhost**，其他域必须是 `https`。

---

## 5. 三个容易踩的坑

1. **`redirect_uri_mismatch`**：Google 精确匹配，包括协议、端口、路径、结尾斜杠。
   注意生产路径带 `/hrt` 前缀（`BASE_PATH`），漏掉就是错配。
2. **用 email 当账号键**：绝对不要。用 `sub`。邮箱可改、可回收，
   用它可以转移账号访问权。这是 `oauth_accounts` 表把 `provider_user_id` 独立出来的原因。
3. **`External` + `Testing` 忘了发布**：只有测试用户能登录，别人会看到
   "Access blocked"。上线前记得 Publish，并接受那个"未验证应用"警告页。

---

## 6. 完成后应当仍然成立的两条不变量

- `oauth_accounts.provider` 已有 `CHECK (provider IN ('x', 'google'))`，无需改表。
- **不允许解绑最后一种登录方式**（`unlinkProvider`，已实现）。Google 接入后这条自动适用：
  一个只有 Google 的账号必须绑定了账号名+密码才能解绑 Google，否则会被拒绝。
