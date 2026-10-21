# 赞助者名单 · Webhook 接入与日常操作

面向维护者。三件事：**Buy Me a Coffee 自动入榜**、**爱发电 API 轮询自动入榜（历史赞助者不导入）**、**审核 / 改名 / 删除**。

## 0. 端点一览

| 用途 | 方法 | URL（生产） |
|---|---|---|
| 公开名单 | GET | `https://api.kiramyao.com/hrt/api/supporters` |
| 加密货币申请 | POST | `https://api.kiramyao.com/hrt/api/supporters/apply` |
| BMC webhook | POST | `https://api.kiramyao.com/hrt/api/supporters/bmc` |
| 爱发电 webhook（旧方案，可选） | POST | `https://api.kiramyao.com/hrt/api/supporters/afdian` |
| 待审核列表 | GET | `https://api.kiramyao.com/hrt/api/supporters/admin/pending` |
| 改名 | PATCH | `https://api.kiramyao.com/hrt/api/supporters/admin/<id>` |
| 通过 | POST | `https://api.kiramyao.com/hrt/api/supporters/admin/<id>/approve` |
| 删除 | DELETE | `https://api.kiramyao.com/hrt/api/supporters/admin/<id>` |

管理接口都需要 `Authorization: Bearer $SUPPORTERS_ADMIN_TOKEN`。

---

## 1. 服务端配置

在 `hrt-server` 的环境里加两个变量（systemd 的 `Environment=` 或 `EnvironmentFile=`），然后重启：

```bash
# 32 字节随机，BMC 的 Signing Secret 就填这个
openssl rand -hex 32        # → BMC_WEBHOOK_SECRET

# 至少 24 字符，只给你自己用
openssl rand -hex 24        # → SUPPORTERS_ADMIN_TOKEN
```

```ini
Environment=BMC_WEBHOOK_SECRET=<第一步生成的值>
Environment=SUPPORTERS_ADMIN_TOKEN=<第二步生成的值>

# 可选：爱发电 Open API（开发者后台的 user_id 与 API Token）。
# 配了它，订单会自动解析赞助者昵称并直接上墙；不配则进入待审核队列。
Environment=AFDIAN_USER_ID=<开发者后台的 user_id>
Environment=AFDIAN_API_TOKEN=<开发者后台的 API Token>
```

> **API Token 只放环境变量 / `.env`，永远不要写进源码或提交 Git。**
> 本地开发用 `server/.env`（已被 `.gitignore` 覆盖），`npm run dev` 会自动读取；
> 生产用 systemd 的 `Environment=` / `EnvironmentFile=`。模板见 `server/.env.example`。

重启后 schema 会自动迁移（`supporters` 表）。用下面的命令确认服务起来了并认识这两个变量：

```bash
curl -s https://api.kiramyao.com/hrt/health
curl -s https://api.kiramyao.com/hrt/api/supporters
# 期望：{"supporters":[]} 或已有名单
```

> 没配 `BMC_WEBHOOK_SECRET` 时，BMC 端点返回 **503**；没配 `SUPPORTERS_ADMIN_TOKEN` 时，管理端点返回 **404**（等于关闭）。这是故意的，避免误以为已经接好。

---

## 2. Buy Me a Coffee：自动入榜

### 2.1 在 BMC 后台创建 webhook

1. 登录 [buymeacoffee.com](https://www.buymeacoffee.com/) → 左侧 **Integrations**。
2. 点 **New webhook**。
3. **Webhook name**：`Kira HRT supporters`（随便起，方便以后找）。
4. **Endpoint URL** 填：

   ```
   https://api.kiramyao.com/hrt/api/supporters/bmc
   ```

5. **Add events**：勾选这些（后台显示名 → 线上 `type`）：
   - `Support created` → `donation.created`
   - `Support refunded` → `donation.refunded`
   - `Monthly support started` → `membership.started` / `recurring_donation.started`
   - 如果列表里还有 `Monthly support updated` / `cancelled`，一并勾上
     （改名 / 取消订阅需要它们；暂停 `paused` 不会移除名单，因为暂停后还可能恢复）
6. **Save**。

> 后台的复选框写的是 **Support created**，线上 payload 里的 `type` 是 `donation.created`——两套命名是平台自己的 UI 文案和协议字段，不是一回事。服务端两套都认（`support.created` / `support.refunded` 也接受），所以平台以后改显示名不会让真实赞助被静默丢掉。月付同理：界面是 `Monthly support started`，线上是 `membership.started` 或 `recurring_donation.started`。
7. 打开刚创建的 webhook 详情页，找到 **Signing Secret**，复制它。
8. 把它填到服务端的 `BMC_WEBHOOK_SECRET`，重启 `hrt-server`。

### 2.2 验证

1. 在 webhook 详情页点 **Send test event** → 选 `donation.created` → **Send test**。
   - 期望：HTTP 200，响应 `{"ok":true,"ignored":"test"}`。
   - `live_mode:false` 的测试事件**不会**写进名单。
2. 自己捐一笔最小金额（例如 $1）。
   - 期望：几秒内出现在 `GET /api/supporters` 和 App 的「感谢名单」里。
   - 未填名字的匿名捐款会被跳过（不猜测、不公开匿名者）。
3. 退款一笔 → `donation.refunded` 会把对应名字移除。

### 2.3 失败排查

BMC 详情页的 **Event deliveries** 会显示每次请求的 payload 和响应：

| 响应 | 原因 |
|---|---|
| `503 webhook not configured` | 服务端没配 `BMC_WEBHOOK_SECRET`，或没重启 |
| `401 invalid signature` | Signing Secret 复制错 / 轮换后没更新服务端 |
| `200` 但名单没变 | `live_mode:false`（测试事件）、匿名、`data.status != succeeded`，或者对应的月付事件没有勾选 |
| 403 / 1010 / 挑战页 | Cloudflare 的 Bot Fight / WAF 拦了 POST。给 `/hrt/api/supporters/*` 加一条 Skip 规则，或把 API 主机设为 DNS only |

连续 10 次投递失败后 BMC 会自动停用 webhook 并发邮件，修好后记得在详情页把 **Delivery status** 打开。

---

## 3. 爱发电：API 轮询（不用 webhook）

爱发电的 webhook 客户端 TLS 版本太旧，Cloudflare 会拒绝握手；同时它的订单 payload
不带昵称。因此服务端改为定时调用 Open API 拉取赞助者（默认每 30 分钟），**只导入部署之后的新赞助**。

### 3.1 不用 Webhook：改用 Open API 轮询

爱发电的 webhook 客户端 TLS 版本太旧，Cloudflare 会直接拒绝：

```
SSL routines:SSL23_GET_SERVER_HELLO:tlsv1 alert protocol version
```

**不要为了它降低 Cloudflare 的 TLS 下限。** 服务端改为定时调用一次
`/api/open/query-sponsor` 拉取赞助者，不需要 webhook：

1. 在爱发电后台把之前配置的 Webhook **删除或停用**（如果已经配了）。
2. 确认环境变量里有：
   ```ini
   AFDIAN_USER_ID=<开发者后台的 user_id>
   AFDIAN_API_TOKEN=<开发者后台的 API Token>
   ```
3. 重启 `hrt-server`。启动日志会出现：
   ```
   hrt-server: Afdian sponsor sync on (30-minute poll)
   ```

**历史赞助者不会显示。** 第一次轮询只记录一个基准时间（`supporter_sync_state`），
不导入任何人；之后只有 `last_pay_time` 晚于基准的赞助者才会进入名单。之前支持过、
但最近没有再付款的人不会出现；如果老赞助者再次付款，`last_pay_time` 会更新，那时才会加入。

如果确实想导入全部历史赞助者（一般不要）：

```sql
-- 让下一次轮询把所有历史赞助者都视为“新”
UPDATE supporter_sync_state SET since = '1970-01-01' WHERE source = 'afdian';
```

### 3.2 轮询细节（排错时看）

- 请求：`POST https://ifdian.net/api/open/query-sponsor`，form 表单：
  `user_id`、`params`（JSON 字符串，如 `{"page":1,"per_page":100}`）、`ts`、`sign`。
- 签名：`md5(token + "params" + params + "ts" + ts + "user_id" + user_id)`。
- 读取字段：`user.user_id`、`user.name`、`last_pay_time`。
- 去重：`supporters.afdian_user_id` 唯一索引；同一赞助者重复出现只更新昵称。
- 页面最多拉 10 页 × 100 条；API 失败时这一轮跳过，30 分钟后重试，不影响 HTTP 服务。
- webhook 路由 `/api/supporters/afdian` 仍然保留（带 RSA 验签），但不配置也能正常工作；
  如果爱发电以后修好 TLS，可以再启用。

### 3.3 审核与上墙

**API 轮询模式下不需要人工审核。** 新赞助者在下一次轮询（最多 30 分钟）时自动以
`approved` 上墙。没配 API 凭据时不会轮询，也不会产生 pending 记录。

管理员命令仍然保留，用来删除 meme 转账或改名：

```bash
export HRT_API_BASE=https://api.kiramyao.com/hrt
export SUPPORTERS_ADMIN_TOKEN=<你的 token>

# 看待审核（只有旧 webhook 模式才会产生）
node server/scripts/supporters.mjs pending

# 改名 / 通过 / 删除
node server/scripts/supporters.mjs rename <id> "Mika"
node server/scripts/supporters.mjs approve <id>
node server/scripts/supporters.mjs delete <id>
```
```

`list` 命令显示的是公开名单，可以用来确认上墙结果。

### 3.4 加密货币申请（自动核验）

App 的「申请加入感谢名单」表单会 `POST /api/supporters/apply`。**服务端会直接去链上确认这笔交易是否到达捐赠地址，确认到账就立即上墙，不需要人工审核。**

按哈希格式自动判断链：

| 哈希 | 查询的链 | 认可的付款 |
|---|---|---|
| `0x` + 64 hex | Ethereum / BNB / Base / Arc（并行查） | 原生币，或 USDT/USDC 的 `Transfer` 到捐赠地址 |
| 64 hex（无 0x） | Bitcoin + Tron（并行查） | BTC 输出到捐赠地址；TRX 原生转账，或 TRC-20 USDT |
| base58 64–88 | Solana | SOL 余额增加，或 SPL Token 余额增加 |

- Bitcoin 要求至少 1 个确认；EVM 要求 receipt 成功；Tron 要求区块已产生且 receipt 为 `SUCCESS`。
- 只认已知稳定币合约（防止有人往你地址 mint 一个垃圾币来骗上墙）。
- 同一交易哈希只能申请一次；结果缓存 60 秒。
- 三个门控：
  - Turnstile（`action=donate`），生产环境未通过直接 403；
  - 每 IP 每分钟 3 次 + 每小时 10 次；
  - 全局每分钟最多 30 次链上查询（保护公共 RPC，避免被限流）。
- 失败会返回明确原因，表单会显示：

  | 状态码 | `code` | 含义 |
  |---|---|---|
  | 422 | `NOT_FOUND` | 链上还没找到，可能刚发出或哈希错 |
  | 422 | `UNCONFIRMED` | 找到了但未确认，等确认后再试 |
  | 422 | `NOT_RECEIVED` | 交易存在，但没有转到捐赠地址 |
  | 503 | `VERIFY_UNAVAILABLE` | 公共节点暂时不可用 |
  | 409 | `DUPLICATE_TX` | 这个哈希已经提交过 |
  | 429 | `RATE_LIMITED` | 触发频率门控 |
  | 403 | `TURNSTILE` | 人机验证失败 |

不再需要手动 `approve`；管理员入口只用于删除 meme 转账或改名。

---

## 4. 数据与隐私

- 公开接口只返回 `id / name / source / at`，**不返回**交易哈希、BMC 支付 id、爱发电订单号或邮箱。
- 公开名单只含 `status='approved'`；`pending` 永远不出现。
- BMC 匿名捐款（没有 `supporter_name`）不写入。
- 旧 webhook 模式留下的 `Afdian supporter` 只会在 `pending` 里，不会公开；现在默认不产生这种记录。
- 删除是硬删除（`DELETE`），用于退款、meme 转账和误报。

---

## 5. 上线检查单

- [ ] `BMC_WEBHOOK_SECRET` 已配置并重启
- [ ] `SUPPORTERS_ADMIN_TOKEN` 已配置并重启
- [ ] `AFDIAN_USER_ID` + `AFDIAN_API_TOKEN` 已放进环境变量 / `.env`（不要提交）
- [ ] Turnstile 已配置（`TURNSTILE_SECRET` + `TURNSTILE_HOSTNAMES`）
- [ ] `GET /api/supporters` 返回 200
- [ ] BMC 测试事件返回 `{"ok":true,"ignored":"test"}`
- [ ] BMC 真实小额捐款出现在名单
- [ ] 月付：勾选 `Monthly support started`，真实订阅后出现在名单
- [ ] 爱发电后台的 Webhook 已删除 / 停用（TLS 报错就是它造成的）
- [ ] 首次轮询后，历史赞助者不在名单；新赞助者 30 分钟内自动出现
- [ ] 加密货币：真实小额转账提交后自动上墙；假哈希返回 422
- [ ] Cloudflare 未拦截 `/hrt/api/supporters/*` 的 POST
- [ ] App 捐赠页能看到最新赞助者与全屏名单
