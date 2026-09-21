# 密钥放在哪里 — Cloudflare Secrets Store 能不能解决问题

**结论（先说不顺耳的）：不能。Cloudflare Secrets Store 只是把密钥从「你一台上有一份的磁盘文件」
换成了「你另一台机器上有一份、并且每次用都要从网络上取回来的副本」。它**不减少任何**已经持有
数据库转储 + 源站 Cloudflare 凭据的攻击者的能力，反而新增一条网络依赖和一个新的长期凭据。**

Every statement below is labelled:

- **[fact <source>]** — verified in the tree (`path:line`) or in a cited official document.
- **[decision]** — a choice made in this document.
- **[judgement]** — an assessment, not verified by a source or a test.

---

## 0. 现状 — 密钥到底在哪

**[fact `server/src/records.ts:59-67`]** 每一个业务载荷都用同一个平台密钥封：

```ts
function requireKey(): Buffer {
    const key = getConfig().encryptionKey;
    if (!key) throw new Error('ENCRYPTION_KEY is not configured; refusing to write records');
    return key;
}
```

**[fact `server/src/records.ts:122`]** 写：`encryptPayload(body.data, requireKey())`。
**[fact `server/src/records.ts:196,206,250`]** 读：`decryptPayload(row.payload_encrypted, key)` / `requireKey()`。

**[fact `server/src/config.ts:267-285`]** `encryptionKey` 来自 `ENCRYPTION_KEY`，启动时校验，
生产环境缺失直接拒绝启动（`config.ts:268-273`）。**[fact `server/src/payloadCrypto.ts:51-67`]** 32 字节。

**[fact `server/src/payloadCrypto.ts:6-12`]** 这个模块自己写得很清楚：这是**静态加密**，
不是端到端加密；能兑现的承诺只有「a stolen database dump is useless without this key」。
**[fact `server/src/records.ts:16-21`]**、**[fact `server/schema.sql:421-424`]** 重复同一句。
**[fact `server/src/session.ts:4-11`]** 再次重复，并明确 `SERVER_DEK_KEY` 也在同一台机器上。

**[judgement]** 这个仓库的文档一致性是它最大的优点，也是最该被保护的资产。任何改动**不许**
让某处注释开始承诺比 `payloadCrypto.ts:6-12` 更强的东西。

**关键事实 —— 其实有两把平台密钥，不是一把：**

| 密钥 | 作用 | 出处 |
|---|---|---|
| `ENCRYPTION_KEY` | 封 `records.payload_encrypted` | `server/src/records.ts:60` |
| `SERVER_DEK_KEY` | 解封**每一个**账户的 DEK | `server/src/config.ts:248-258` |

**[fact `server/src/accounts.ts:213-215`]** `serverDekFor` 用 `SERVER_DEK_KEY` 打开账户的
server wrapper。**[fact `server/src/accounts.ts:401-402,411-415`]** `resolveApiContext` 对
`ks_` session token 和 `hrt_` API token 两条路径都调它，取不到就 `{ denied: 'locked' }`。

**[judgement — 这一点决定了整个方案]** 只把 `ENCRYPTION_KEY` 搬进 Cloudflare 而把
`SERVER_DEK_KEY` 留在 `/srv/hrt/.env`，等于没搬：拿得到源站磁盘的人照样拿到
`SERVER_DEK_KEY`，而它足以打开每个账户的 DEK。**要搬就得两把一起搬，于是源站要么同时向
Cloudflare 取两把（延迟和可用性翻倍），要么承认没搬干净。**

---

## 1. Secrets Store 今天到底是什么

### 1.1 只有 Worker 能读 —— 文档原话

**[fact — Cloudflare 官方文档]** 概览页把兼容范围说得很死（
https://developers.cloudflare.com/secrets-store/ ）：

> "Secrets Store is currently compatible with **Cloudflare Workers** and **AI Gateway**.
> Integrations with other products will be added in the future."

**[fact — 官方文档 `/secrets-store/manage-secrets/`]**（
https://developers.cloudflare.com/secrets-store/manage-secrets/ ）：

> "Once a secret is added to the Secrets Store, it can no longer be decrypted or accessed
> **via API or on the dashboard**. **Only the service associated with a given secret will be
> able to access it.**"

**[fact — 官方文档 `/secrets-store/access-control/`]**（
https://developers.cloudflare.com/secrets-store/access-control/ ）把「service」具体化为两条
scope：

> "The currently supported scopes are: `workers` — allows the secret to be bound to a Worker.
> `ai-gateway` — allows the secret to be associated with an AI Gateway."

> "**Account Secrets Store Read**: Allows the caller to view metadata for secrets ... This
> permission **does not grant access to the value of a secret**."

**[fact — 官方文档 `/secrets-store/integrations/workers/`]**（
https://developers.cloudflare.com/secrets-store/integrations/workers/ ）读出方式是
**binding 注入 + 异步 `get()`**：

> "To access the secret you first need an asynchronous call."
> `const APIkey = await env.<BINDING_VARIABLE>.get()`

**[fact — 官方文档，Containers 页]**（
https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/ ）——**这是唯一的
`workers` scope 之外的使用例子，而它仍然是绕道 Worker**：

> "Secrets can be passed into a Container by using Worker Secrets or the Secret Store, **then
> passing them into the Container as environment variables**."

**[judgement — 决定性]** **文档里不存在任何「非 Worker 源站直接读取密钥」的路径。**
没有 REST 端点返回密钥值（Read 权限明确只给 metadata），没有 dashboard 查看，没有 CLI
导出。**能拿到密钥值的只有绑定它的那个 Worker。**

**[fact — 文档沉默处]** Cloudflare 文档**没有**单独写明 Secrets Store 需要哪个套餐。
`/secrets-store/plans/` 不存在（抓取失败 / 404）。唯一相关的官方表述是 2025-05-27 的
changelog「Increased limits for Cloudflare for SaaS and Secrets Store **free and
Pay-as-you-go plans**」（https://developers.cloudflare.com/changelog/post/2025-05-19-paygo-updates/ ），
它说 Secrets Store 在 free 和 PAYG 套餐上都在，并把上限提到 100 secrets/account。
**[judgement]** 因此「必须付费」是我的**误判风险区**：按官方 changelog，免费套餐可用。
但**它仍然需要一个 Worker**，而 Worker 需要 Workers 运行环境（免费套餐每天 10 万请求；
https://developers.cloudflare.com/workers/platform/pricing/ ）。**这一点必须实测确认，
本文不把它当结论。**

**[fact — 官方文档，limit]** 「up to 100 secrets per account. Also, there can only be
**one store per account**.」以及「a secret must be a string that does not exceed **1024 bytes**」
（`/secrets-store/manage-secrets/`）。**[fact]** 32 字节 base64 密钥 `openssl rand -base64 32`
约 44 字符 —— **远在 1024 字节内**，尺寸不是障碍。

### 1.2 Worker 能不能把密钥交给外部服务器

**[judgement — 文档没有正面回答，但答案是「能，代码上当然能」]** `get()` 返回一个普通
字符串（官方示例把它塞进 `Authorization` header 发给 `api.example.com`）。所以 Worker 完全
可以把密钥放进响应体发给你源站。

**[judgement — 代价在这里]** 但**源站必须能证明「我是那个源站」**，否则任何人打这个
Worker 端点都拿到密钥。源站能拿什么证明？

1. 一个**另一个长期共享密钥**（存在 `/srv/hrt/.env`）—— **这是循环论证**：密钥还是躺在
   同一块磁盘上，攻击者拿到磁盘就拿到它，照样去 Worker 取 `ENCRYPTION_KEY`。**[judgement]
   净改善为零。**
2. 一个 **mTLS 客户端证书** —— 私钥仍然是一个磁盘上的长期凭据。同样循环。
3. **Cloudflare Access / 源站 IP 白名单** —— 但源站是 Cloudflare 后面的 Caddy，
   Worker 出站 IP 也不固定。**[judgement]** 工程上很脆。

**[judgement]** 结论：Worker 方案在密码学上不可能消除「源站必须持有某个长期凭据」这件事。
它只能把那个凭据**换成另一个**。

---

## 2. 中间的 Worker 到底改变了什么威胁模型

逐个攻击者过一遍：

### (a) 拿到磁盘镜像 / 一份遗留备份的人

- **现在**：`/srv/hrt/.env`（`-rw-------`）被读走 → `ENCRYPTION_KEY` + `SERVER_DEK_KEY` 全丢。
  **[judgement]** 这是**整个方案想防的那个人。**
- **搬进 Secrets Store 后**：`.env` 里没有 `ENCRYPTION_KEY` 了 —— **有改善。** 但：
  - **[fact `server/src/config.ts:253-258`]** 生产环境**强制**要求 `SERVER_DEK_KEY`。
    只要它还在 `.env` 里，攻击者仍然能解出每个账户的 DEK。
  - **[judgement]** 除非两把都搬走，否则 (a) 的收益是「半个数据库」而不是「整个数据库」。
    这确实不是零，但它也不是 Owner 想象中的那个数字。
- **[judgement]** 而且**必须**换掉所有历史备份：磁盘镜像里还有旧 `.env`。

### (b) 拿到 root / 内存的人

- **[judgement]** **零改善，绝对的。** 密钥必须进进程内存才能做 AES-GCM。
  任何能读 `/proc/<pid>/mem`、能 `gdb`、能注入、能改 `server/src/records.ts` 的人，
  在下一次同步时就能拿到明文。
- **[fact `server/src/session.ts:21`]** 仓库自己就承认：「An **unlocked** session holds the DEK
  in process memory for a bounded time.」**[judgement]** 平台密钥只会更长命 —— 它是启动时读一次
  的模块级常量。
- **[judgement]** 这是**热路径**：`records.ts:196` 每次 `list()` 都调 `requireKey()`。
  真要按请求去 Cloudflare 取，那就是每个列表请求一次网络往返（见 §3）。

### (c) 数据库转储 + 源站自己的 Cloudflare 凭据

- **[judgement]** **这才是诚实评估里最该被说出来的那一条：这个方案对 (c) 毫无帮助，
  而且可能让它更容易。**
- **[fact]** 源站要取密钥，必须持有某个能访问 Worker 端点的凭据 —— 而这个凭据**必然**在
  磁盘上（`.env`、systemd unit、或一个证书文件）。
- **[judgement]** 于是攻击者路径变成：**转储 + 一个文件 = 全部明文**。和今天完全一样，
  只是那个文件从 `ENCRYPTION_KEY` 变成了 `WORKER_FETCH_TOKEN`。
- **[judgement — 反而更糟的一点]** 今天攻击者需要**同时**拿到磁盘上的密钥**和**数据库。
  搬走之后，**光拿到那个 fetch 凭据（比如它被写进了 CI、被日志打出来、被 `ps` 看到）
  就够了** —— 因为密钥可以随时从 Worker 现取，不需要数据库在场。**凭据的泄露面变大了**，
  不是变小了。

### 小结表

| 攻击者 | 现状 | 全搬进 Secrets Store + Worker |
|---|---|---|
| (a) 磁盘镜像 / 备份 | 全丢 | **有改善**（前提：两把都搬，且旧备份全部作废） |
| (b) root / 内存 | 全丢 | **无改善** |
| (c) 转储 + 源站凭据 | 全丢 | **无改善**，且新增一个「只需凭据」的更快路径 |
| 新的：Cloudflare 账号被盗 | 无此风险 | **新增**：密钥现在也在 Cloudflare 手上 |
| 新的：网络依赖 | 无 | **新增**（见 §3） |

**[fact — 官方文档沉默处]** Cloudflare 文档**没有**对「Secrets Store 的密钥 Cloudflare 自己
能不能读」给出密码学层面的承诺说明（是否有客户自持密钥、HSM 细节、谁能访问）。
**[judgement]** 我无法引用文档证明「Cloudflare 员工读不到」。因此搬过去严格来说是
**把信任从「自己的一块磁盘」转移到「Cloudflare 的运维 + 你的 Cloudflare 账号安全」**，
不是无条件的安全提升。

---

## 3. 延迟与可用性

### 每次取 vs 缓存在内存

**[fact — 官方文档 `/secrets-store/integrations/workers/`]** 取值是
`await env.BINDING.get()` —— **异步**，且文档强调必须先 await。**[judgement]** 这是
一次真实的 RPC，不是本地变量读取。

- **每请求取**：
  - **[fact `server/src/records.ts:196`]** `list()` 每个请求调一次 `requireKey()`；
    `get()`(`:250`)、`put()`(`:122`) 同样。**每次读写一条 API 调用 = 一次 Cloudflare 往返。**
  - **[judgement]** 从一台 Ubuntu 到 Cloudflare 边缘，RTT 典型量级 **10–40 ms**；加上 Worker
    冷启动和 `get()` 的开销。**[fact `server/src/records.ts:170`]** 单次 `list` 上限 1000 条，
    **[fact `:277-285`]** `all()` 最多翻 100 页 —— **[judgement]** 一次全量导出会变成
    **最多 100 次额外的密钥往返**。
  - **[judgement]** 用一个数量级估计：每次往返 +20 ms，在 `all()` 的最坏情况下就是 +2 s
    纯等待，而且**每一次都可能是新的失败点**。
- **缓存在内存**：**[judgement]** 立刻退回**等价于今天**的状态 —— 密钥在进程内存里，
  且启动时被取一次。差别只在「启动时从磁盘读」还是「启动时从网络读」。

**[judgement — 关键自相矛盾之处]** 要么每请求取（延迟爆炸），要么缓存（那 (b) 攻击者
照样拿得到，且磁盘上**没有**改善的只是冷启动那一瞬间）。**这两种模式里没有第三种。**

### Cloudflare 不可达时

**[fact — 官方文档沉默处]** Secrets Store 文档**没有**写明 `get()` 失败时的行为、
没有 SLA、没有离线模式说明。**[judgement]** 按文档我只能说：**文档对此沉默**。

**[judgement — 推断]** 若密钥是必需的：

- **缓存模式**：已启动的进程继续跑；**进程重启即死**。**[fact `server/src/config.ts:267-273`]**
  现在 `ENCRYPTION_KEY` 缺失是**启动期** `ConfigError`（拒绝启动）。搬走之后，Cloudflare
  抖动 = **源站无法重启**。**[judgement]** 这是把一次「Cloudflare 中断」升级成一次
  「你自己部署能力的无关中断」。
- **每请求模式**：Cloudflare 一挂 → **整个记录读写全挂**。

### 对 offline-first 的客户端意味着什么

**[fact `src/hooks/useCoreSync.ts:40`]** `ready` ：「True once the data layer holds this
account's records — **never sync before**」。**[fact `:60`]** 推送去抖 `PUSH_DEBOUNCE_MS = 3_000`。
**[fact `src/services/coreSync.ts:1-32`]** 客户端发**明文 JSON**、收**明文 JSON**，
「Sealing and opening happen server-side under `ENCRYPTION_KEY`」。

**[fact `src/services/coreSync.ts:109-114`]** 失败分类已经存在：
`401` → `CoreSyncError(..., locked = true)`；`403` → `accountIncomplete = true`；
其余 → 普通错误。

**[judgement — 这是本方案最被低估的伤害]** 密钥取不到时，源站会返回 `401`（因为
`resolveApiContext` 走 `{ denied: 'locked' }` → `server/src/http.ts:713` 的 401）。
客户端**已经**把 401 解释成 **「账户被锁了，去输密码」**
（`src/services/coreSync.ts:99-100,110`：「A 401 here means the account is locked,
not that the token is bad」）。

**于是一次 Cloudflare 抖动会让 UI 告诉用户「你的账户锁了，请输入密码」——而密码根本
修不好它。** **[judgement]** 这是一个**错误归因**，比单纯的「同步失败」糟糕得多：
它会让用户去做一件无用的事，并且开始怀疑自己的数据是不是没了。

- **同步**：`useCoreSync` 的 `status` 会停在 `'error'`，本地 localStorage 数据**不丢**
  —— **[fact `src/hooks/useCoreSync.ts:21`]** 状态机含 `'error'`。**[judgement]** 这点是真的好，
  offline-first 在这里救了场。
- **首次加载**：**[fact `src/hooks/useCoreSync.ts:40`]** `ready` 之前不 sync。**[judgement]**
  全新设备、缓存为空、Cloudflare 不可达 → 用户看到**空的历史**。数据还在服务器上，
  但用户看到的是「我什么都没记过」。

**[judgement]** 用一个 10–40 ms 的常态往返 + 一个新的全站故障点 + 一个会误导用户的
错误归因，去换 §2 表里**只有 (a) 部分成立**的收益 —— 这笔账不划算。

---

## 4. 替代方案，按「真正买到什么」排序

### 4.1 ★ 用已有的 per-user DEK（最便宜，收益最大）

**这是本仓库里已经写好、但 `records.ts` 从来没用过的东西。**

**[fact `server/src/types.ts:15-18`]** `AuthContext` **本身就带密钥**：

```ts
export interface AuthContext {
  userId: string;
  dek: string;
}
```

**[fact `server/src/types.ts:10-13`]** 注释把它说成是刻意设计：
「Services accept this instead of a user id **precisely so a caller cannot act on an account
it holds no key for**.」

**[fact `server/src/accounts.ts:392-417`]** `resolveApiContext` 两条路径都在**填充** `dek`：
`{ userId: session.userId, dek: sessionDek }`（`:403`）和 `{ userId, dek: serverDek }`（`:416`）。
失败时 `{ denied: 'locked' }`（`:402`、`:415`）。

**但是：**

**[fact `server/src/records.ts:107`]** `put` 的签名只收 `{ userId: string }` —— **丢掉了 `dek`**。
**[fact `server/src/records.ts:167`/`:235`/`:269`/`:291`/`:300`]** `list`、`get`、`all`、
`count`、`countByCategory` **全部只收 `{ userId: string }`**。

**[fact `server/src/records.ts:122,196,206,250`]** 全部调 `requireKey()`（平台密钥），
**从来没有 `ctx.dek`**。

**[fact `server/src/core.ts:173,237,258,266,271`]** `core.ts` 一路传的是完整 `AuthContext`，
所以 `dek` **一直在手上**，只是在 `records.ts` 的入口被类型签名抹掉了。

**[fact `server/src/session.ts:19-24`]** DEK 是**每用户随机**的：
「The **DEK** is random per user and is what actually encrypts records.」并且它同时被
password KEK 和 server key 各包一层（`session.ts:108-112`）。

**[judgement — 它买到什么]** 把 `requireKey()` 换成 `ctx.dek`：

- **一个用户密钥泄露 ≠ 整个数据库泄露。** 这正是 Owner 想要的那个性质。
- **不需要 Cloudflare，不需要新凭据，不需要新网络依赖。**
- **[fact `server/src/session.ts:26-28`]** 注释已经写明 DEK 间接层的理由：「password change
  then re-wraps one row instead of re-encrypting every record」——**机制已经建好了。**
- **[judgement]** 剩下要做的只是：把 5 个方法的签名从 `{ userId }` 换成 `AuthContext`、
  把 3 处 `requireKey()` 换成 `ctx.dek`、加一个「读不出来的 key 版本」标记。
  **这是我在这份文档里看到的性价比最高的改动。**

**[judgement — 诚实的边界]** 它**不**解决 (b)（root 照样能读内存里的 DEK），
也**不**解决 (c)（`SERVER_DEK_KEY` 还在磁盘上，能替**任何**用户解出 DEK）。
**必须同时承认：只要 `SERVER_DEK_KEY` 还在 `/srv/hrt/.env` 里，
per-user DEK 提供的隔离就是「需要多一步」而不是「需要多一把密钥」。**
这是一个真实的削弱，不该被藏起来。

### 4.2 用 `systemd-creds` / `LoadCredential=` 让密钥不是磁盘上的明文文件

**[fact — 无法验证]** 任务要求检查已部署的 unit
`/etc/systemd/system/hrt-server.service`。**我读不到它** ——
`read C:\etc\systemd\system\hrt-server.service` 返回 not found，
`Get-ChildItem /etc/systemd/system -Filter 'hrt*'` 无输出（exit 1）。
**[fact — 仓库内也没有]** `glob **/*.service` 在 `E:\HRT` 下**零结果**；
`glob deploy*` 同样零结果。**[judgement]** 也就是说**部署单元不在这个仓库里**，
我没有任何依据说它现在长什么样。**这是一个明确的 gap，不是「大概是这样」。**

**[judgement — 如果 unit 用的是 `EnvironmentFile=/srv/hrt/.env`]**（这是最可能的形态，
因为 `getConfig()` 只读 `process.env`），那么：

- **[judgement]** 换成 `LoadCredential=encryption_key:/srv/hrt/encryption.key` +
  `systemd-creds encrypt`，可以让密钥以**主机绑定的密钥**（`/var/lib/systemd/credential.secret`）
  加密存储，进程通过 `$CREDENTIALS_DIRECTORY` 拿到 tmpfs 上的解密副本。
- **[judgement — 买到什么]** 防的是**离线**攻击者：一份磁盘镜像或一份 `rsync` 备份
  不再直接含明文密钥。**(a) 有真实改善。**
- **[judgement — 买不到什么]** root 在**运行中**的机器上可以调 `systemd-creds decrypt`
  或用 `/var/lib/systemd/credential.secret` 解密。**(b) 无改善。** 而且
  `credential.secret` 和数据库**还是同一块磁盘** —— 与 Owner 抱怨的
  「这个密钥放边上也太……」是同一个问题，只是包装了一层。
- **[judgement — 改动量]** 比 4.1 **更小**：改 unit + 一个启动脚本，
  **生产代码一行不用动**（`getConfig()` 照旧从 env 读，只是这个 env 由 systemd 注入）。
- **[fact]** 这需要我拿到 unit 文件才能给出确切 diff —— 见上面的 gap。

### 4.3 用第二把离线密钥加密数据库快照

**[judgement]** 针对的威胁是「dump / 快照被搬走」。**这与 (a) 高度重叠，但不重叠 (b)(c)。**

- **[judgement — 买到什么]** 如果 `pg_dump` / WAL 归档 / 快照都先用一把**只在离线介质上**
  的密钥加密再落地，那么磁盘镜像里的**备份**是安全的。这直接命中「stray backup」。
- **[judgement — 买不到什么]** 它**保护不了活着的 `postgres` 数据目录** ——
  **[fact `server/schema.sql:433-445`]** `payload_encrypted` 是 TEXT，
  **[judgement]** 能读 pgdata 的人 read 到的就是密文，这一层**已经**由 `ENCRYPTION_KEY` 提供了。
  所以快照加密**叠加的边际收益有限**，主要是防「备份落到对象存储/异地」这类场景。
- **[judgement — 复杂度]** 需要新的备份脚本、密钥托管流程、以及**恢复演练**，
  否则「加密了但恢复不了」比不加密更糟。**[judgement]** 在现有代码里改动量最小（零），
  但在运维上最重。

### 4.4 ★ 两张表：它们要防的其实是不同的人

| 方案 | 防 (a) 磁盘/备份 | 防 (b) root/内存 | 防 (c) 转储+凭据 | 生产代码改动 | 新增依赖 |
|---|---|---|---|---|---|
| Cloudflare Secrets Store + Worker | 部分 | **否** | **否** | 中（取密钥通路） | **Worker + 新凭据 + 网络** |
| **4.1 per-user DEK** | **是** | 否 | 否 | **小（改签名 + 3 处调用）** | **无** |
| **4.2 systemd-creds** | **是** | 否 | 否 | **零** | 无（systemd 自带） |
| 4.3 快照密钥 | 部分 | 否 | 否 | 零 | 新的备份流程 |

**[judgement]** 4.1 + 4.2 各自都比 Secrets Store 强，而且**都更便宜**。
4.1 管「一把密钥开全部」，4.2 管「密钥是磁盘上的明文」——
**这两个加起来正好覆盖了 Owner 抱怨的那件事，而且不需要 Cloudflare 登台。**

---

## 5. 建议

**[judgement — 结论]** **Secrets Store 不解决问题，别做。**

三条具体理由：

1. **[fact §1.1]** 只有 Worker 能读。源站要么不能读，要么必须新增一个读取通路 ——
   而那个通路需要一个源站凭据，**于是循环回到「磁盘上有一把长期密钥」**（§1.2、§2(c)）。
2. **[judgement §2]** 它让 (a) 有部分改善，但 (b)、(c) **完全无改善**，同时新增
   「Cloudflare 账号被盗」和「网络不可达」两类**现在不存在**的风险。
3. **[judgement §3]** 对一个 offline-first 的应用，它会把一次 CDN 抖动变成
   **「账户已锁定，请输入密码」**（`src/services/coreSync.ts:110`）——
   一个用户无法用密码修复的错误提示。

### 最小改动方案

**[decision] 第一步（立刻，零生产代码）：systemd-creds。**
把 `ENCRYPTION_KEY` 和 `SERVER_DEK_KEY` 从 `.env` 移到
`systemd-creds encrypt` 加密的文件，unit 用 `LoadCredential=`。
**[judgement]** 半天以内，`config.ts` 一行不用改，直接命中 (a)。
**前提是拿到 `/etc/systemd/system/hrt-server.service` 的实际内容**（见 §4.2 的 gap）。

**[decision] 第二步（真正的结构性收益）：让 `records.ts` 用 `ctx.dek`。**
把 `RecordService` 各方法的 `ctx` 类型从 `{ userId: string }`
（`records.ts:107,167,219,235,269,291,300`）换成 `AuthContext`，
把 `requireKey()`（`:122,196,250`）换成 `ctx.dek`。
**[judgement]** `core.ts` 已经在传完整 `AuthContext`，`resolveApiContext` 已经在填 `dek`
（`accounts.ts:403,416`），**这条链路是通的，只是末端被丢了。**
这是唯一一个能让「一个用户密钥泄露 ≠ 整个数据库泄露」成真的改动，
而它**不需要 Cloudflare，也不需要新凭据**。

**[decision] 不做**：Cloudflare Secrets Store + Worker。

**[judgement — 诚实的收尾]** 即使做完这两步，只要 `SERVER_DEK_KEY` 和数据库在**同一台机器**
上，能拿到 root 的人就还能打开一切。彻底解决这件事要么需要用户在每次读取时提供密钥
（那会毁掉 offline-first 的产品承诺），要么需要把 `SERVER_DEK_KEY` 放到一台**真正独立**的
机器上 —— 而 Cloudflare Secrets Store **不是**那样一台机器，它只是又一个需要源站凭据
才能访问的服务。

---

## 6. 我没能确定的

- **[gap]** `/etc/systemd/system/hrt-server.service` 的**实际内容**。本地路径读不到
  （`C:\etc\systemd\system\hrt-server.service` not found），仓库里也没有 `.service` 文件
  （`glob **/*.service` 零结果）。§4.2 的具体 diff 在拿到它之前只能是推测。
- **[gap]** **Secrets Store 的套餐要求**。文档没有 `/secrets-store/plans/` 页面；
  只有 2025-05-27 changelog 提到 free 和 PAYG 都包含它。
  **[judgement]** 我倾向「免费套餐可用」，但**没有直接的一手表述**，需要实测。
- **[gap]** **`get()` 失败时的具体行为、超时、SLA。** 官方文档对此**完全沉默**。
  §3 的可用性分析是从「文档没承诺」推出来的，不是引用的。
- **[gap]** **Cloudflare 是否能读 Secrets Store 中的密钥值。** 文档没有给出密码学承诺
  （HSM、客户自持密钥、运维访问边界）。因此「搬到 Cloudflare 更安全」在文档层面
  **无法被证实**，只能被当作信任转移。
- **[gap]** 真实的网络延迟数字。§3 的 10–40 ms 是**量级判断**，不是本项目的实测值。
  要给出确切结论需要在这台 Ubuntu 上实测到 Cloudflare 边缘的 RTT。
- **[gap]** `records.ts` 改成 `ctx.dek` 之后的**数据迁移方案** —— 现有行是用平台密钥封的，
  需要 key 版本标记 + 惰性重封或一次性重封。**[judgement]** 这是 4.1 的**真实成本**，
  我没有把它算进「小改动」里，因为它取决于 Owner 愿意接受哪种迁移形态。
