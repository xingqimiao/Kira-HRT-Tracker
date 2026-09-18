# 认证与账号绑定设计（云端托管 SaaS）

> 状态：**已实施的规格**。数据库部分已在生产生效；OAuth/绑定接口部分见 §6 的进度表。
> 本文取代任何提到「邮箱」作为登录标识的旧描述。

---

## 1. 目标

一次架构反转的直接结果：**放弃客户端 E2EE**（服务端整包加密、读时解密）。
相应地，认证层的设计前提也变了——服务端已经能解密数据，所以「密钥由谁持有」
不再是认证设计要解决的问题；真正要解决的是**第三方账号失效时用户不能丢数据**。

### 主线目标

1. **双轨登录**：OAuth 2.0（X / Google）与「账号名 + 密码」两条路都可用。
2. **防封禁容灾**（核心）：社交账号被封、注销、或 API 凭证失效时，用户凭自己设的
   账号名 + 密码仍能登录，数据绝对不丢。
3. **身份与凭证解耦**：一个账号可挂多个 OAuth 凭证，可解绑、可换绑。
4. **密码哈希**：Node 原生 `crypto.scrypt` + 随机 salt，零外部原生编译依赖。
5. **会话**：认证通过后下发长效会话（沿用现有 `SESSION_TTL_MINUTES` 滑动续期）。

### 非目标

- 不做邮箱注册、邮箱验证、邮箱找回。登录标识是**自定义账号名**。
- 不做 E2EE。服务端持有 `ENCRYPTION_KEY`，能解密记录——见 §5 的诚实口径。

---

## 2. 为什么登录标识是「自定义账号名」而不是邮箱

| 维度 | 账号名 | 邮箱 |
|---|---|---|
| 注册门槛 | 想一个名字即可 | 需要一个能收信的地址 |
| 找回路径 | **无**（靠绑定的第二种登录方式） | 邮件重置 |
| 依赖 | 无 | 邮件服务商 + 送达率 |
| 隐私 | 不收集联系方式 | 收集了可识别信息 |
| 被用来当门槛 | 不可能 | 邮件商可成为你用药记录的守门人 |

选账号名的代价必须写清楚：**没有邮箱找回**。所以「绑定备用凭据」不是可选优化，
而是这个选择的**唯一兜底**，必须在产品里主动引导（见 §5）。

---

## 3. 数据模型

### 3.1 `users` — 账号本身

```sql
id            uuid PRIMARY KEY DEFAULT gen_random_uuid()
username      varchar(64) NOT NULL UNIQUE   -- 登录标识
display_name  text
password_hash text                          -- 可空：OAuth 账号初始没有
password_set_at timestamptz
wrapped_dek   jsonb                         -- 服务端整包加密的账号密钥material
failed_unlocks integer NOT NULL DEFAULT 0
locked_until  timestamptz
created_at / updated_at timestamptz
CHECK (username = btrim(username) AND length(username) BETWEEN 1 AND 64)
```

**关于 `username` 的两层校验**：

- 数据库：`varchar(64)` + `NOT NULL UNIQUE` + 形状约束（非空、无首尾空白、≤64）。
- 应用：`/^[A-Za-z0-9_-]{3,30}$/`（`accounts.ts:validateUsername`）。

两层都存在是刻意的：应用给用户友好报错，数据库保证「不存在应用永远不会生成的
账号名」。数据库的 64 是存储上限，不是产品规则。

**关于 `password_hash` 可空**：OAuth 账号初始没有密码。但**账号不会因此不可用**——
建号时用 handle 生成一个 username（`usernameFromHandle`，含唯一性重试），
用户随后可改名。这样新账号立即可用，同时留出了绑定密码的位置。

**已移除 `email`**：本设计一度加入过 `email` 列。移除的理由是把「第二个半用的身份列」
留在表里，会诱导后续代码开始依赖它，而产品并不靠它登录。生产库中该列已删除。

### 3.2 `oauth_accounts` — 第三方绑定关系

```sql
id               uuid PRIMARY KEY DEFAULT gen_random_uuid()
user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
provider         varchar(32) NOT NULL          -- 'x' | 'google'
provider_user_id varchar(255) NOT NULL         -- 第三方不可变 id
handle           text                          -- 展示用，可改名
avatar_url       text
linked_at        timestamptz NOT NULL DEFAULT now()
last_login_at    timestamptz
UNIQUE (provider, provider_user_id)
CHECK (provider IN ('x', 'google'))
```

**这是容灾的核心**：身份（`users`）与登录方式（`oauth_accounts`）解耦，
所以社交账号失效只掉一个按钮，不掉账号。

**`provider_user_id` 必须是第三方不可变 id，不能用 @handle**：handle 可改、可被他人
重新注册，用它做键会让一次改名转移访问权。

**`linked_at` 命名**：历史上这张表叫 `oauth_links`，列名沿用至今；它承担 `created_at`
的角色。

### 3.3 `records` — 业务整包加密（与认证共用同一套账号）

见 `schema.sql`。要点：`user_id` / `taken_at` / `category` 明文（寻址与分页），
其余全部业务字段打包成一个 AES-256-GCM 密文。

---

## 4. 认证流程

### 4.1 账号名 + 密码注册

```
POST /auth/register { username, password }
  → validateUsername / validatePassword
  → scrypt 哈希（随机 salt）
  → INSERT users(username, password_hash, ...)
  → 下发会话
```

### 4.2 账号名 + 密码登录

```
POST /auth/login { username, password }
  → 查 users by username
  → verifyPassword（scrypt + timingSafeEqual）
  → 失败计数 failed_unlocks / locked_until 节流
  → 下发会话
```

### 4.3 OAuth 登录（X / Google）

```
1. GET  /auth/{provider}/start      → 302 到第三方（PKCE）
2. GET  /auth/{provider}/callback   → 换 token，取 provider_user_id
3. 查 oauth_accounts(provider, provider_user_id)
     ├─ 命中 → 该 user 登录
     └─ 未命中 → createAccountFromX / createAccountFromProvider
                  （生成 username，无密码）
4. 下发会话
```

### 4.4 绑定备用凭据（容灾路径）

```
POST /auth/credentials/bind { username, password }    (需已登录会话)
  → 校验 username 未被占用
  → 写 users.username + password_hash + password_set_at
```

绑定后，即使用户的 X 账号被封、被注销、或 X 的 API 凭证整体失效，
用户仍可走 §4.2 用账号名 + 密码登录，**记录一条不少**。

### 4.5 解绑 / 换绑 OAuth

```
DELETE /auth/oauth/{provider}     解绑一个 provider
```

**必须拒绝解绑最后一种登录方式**：如果账号既没有密码、又是唯一 OAuth 凭证，
解绑即锁死。此规则要在服务端强制，不能只靠前端隐藏按钮。

---

## 5. 诚实口径（必须与文档/隐私声明一致）

1. **这不是端到端加密。** 服务端持有 `ENCRYPTION_KEY`，读记录时解密。
   能宣称的是「数据库被拖库、没有这把密钥则数据不可读」，**不是**「运营方看不到数据」。
2. **没有邮箱找回。** 登录标识是账号名，忘记密码且 OAuth 也失效时，账号无法自助恢复。
   所以产品必须主动引导绑定（§4.4），这是该设计成立的前提，不是锦上添花。
3. **`provider_user_id` 会存第三方 id。** 可推断「某人的 X/Google 账号与这个账号有关」，
   这是 OAuth 绑定不可避免的元数据。

---

## 6. 实施进度

| 项 | 状态 |
|---|---|
| `users.username` → `varchar(64)` + 形状约束 | ✅ 已在生产生效 |
| 移除 `email` 列与索引 | ✅ 已在生产生效 |
| `oauth_accounts` 改名 + 放开到 `x`/`google` | ✅ 已在生产生效 |
| `records` 表（整包加密） | ✅ 已建表，索引齐 |
| `payloadCrypto.ts`（AES-256-GCM，`ENCRYPTION_KEY`） | ✅ 已实现，启动期校验 |
| `ENCRYPTION_KEY` 写入生产环境 | ✅ 已生成（32 字节）并写入 |
| `crypto.scrypt` 密码哈希 | ✅ **既有实现**（`accounts.ts:188`），无需重写 |
| Google OAuth provider | ⬜ 待做（X 的 PKCE 流程已存在，可抽象复用） |
| 绑定/解绑接口（§4.4 / §4.5） | ⬜ 待做 |
| 前端引导「绑定备用凭据」 | ⬜ 待做 |
| Session Cookie（httpOnly/Secure/SameSite=Lax） | ⬜ 待定：现有实现是 Bearer token，见 §7 |

---

## 7. 待定：会话载体

现有实现是 **Bearer token**（`Authorization: Bearer ks_…`），存在 `localStorage`。
规格里提到可改为 httpOnly Cookie。取舍：

| | Bearer + localStorage | httpOnly Cookie |
|---|---|---|
| XSS 影响 | 脚本可读走 token | 脚本读不到 |
| CSRF | 天然免疫 | 需要 SameSite + CSRF token |
| 前端改动 | 无 | 所有请求加 `credentials`，后端加 CSRF |

当前服务端已有完整的 Bearer 会话体系（含滑动续期、设备列表、撤销），
**改 Cookie 是一次横切改动**，建议作为独立事项排期，不与本次认证重构混做。

---

## 8. 验收方式

- 数据库：`scripts/check-schema-migration.sql`（oauth 改名/约束/索引/CASCADE）、
  `scripts/check-username-schema.sql`（username 类型/形状/64 上限/空名拒绝、
  无 email 列、OAuth-only 账号可表示）。
  两者都**在从生产 dump 恢复的副本上**跑，不是对着空库跑。
- 加密：`scripts/check-payload-crypto.mjs`（13 项）。
- 后端：`server` 测试套件 172/172。
