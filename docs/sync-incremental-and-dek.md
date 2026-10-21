# 增量同步与「客户端持 DEK」——设计、决定与测试清单

- 状态：3.1 已实现（工作区，未提交）；3.2 评估后**放弃**（收益窄、代价长期）；分享链接改为客户端加密已实现（见文末）
- 关联：`src/services/coreSync.ts`、`src/services/recordDocs.ts`、`server/src/records.ts`、`server/src/session.ts`
- 前置阅读：`docs/auth-design.md`（密钥层级；明确写了「不是端到端加密」）

---

## 3.1 增量同步

### 结论（已实现）

每次推送只发「合并后与服务器已有副本不一致」的记录，不再把整份状态转成 records 上传。

### 决定 1：增量以「本次同步已经做的那次读」为基准，不引入第三方状态

`syncWithCore` 本来就先 GET 远端再合并（不快照就没法安全写入）。因此增量所需的输入已经在该函数手里：
`outgoing`（合并结果）与 `remote`（刚读到的远端）。

被否掉的方案：

- **维护每记录 last-pushed fingerprint（落盘）**：需要新存储、跨设备不可比、缓存丢失后要么全量重推要么漏推，而且清缓存/换设备就退化为全量。
- **服务端返回 manifest（id + updated_at）**：多一个接口，且 `updated_at` 是服务器时钟，无法直接与本地 `updatedAt` 比较（只能比「是否变过」，不能比内容）。

以刚读到的远端为基准的优点是**自纠正**：本地缓存丢了、上一轮写失败、服务端被 MCP 改过 —— 下一次同步的读会如实反映，增量自然重算，不存在需要修复的持久化状态。

### 决定 2：相等判断复用合并引擎自己的记录身份，不另写一套

`mergeSyncStates` 判定「两条同 id 记录是不是同一条」用的是 `syncMerge.ts` 的 `contentFingerprint(kind, record)`（按 kind 列出字段，排除 `updatedAt` 这类记账字段）。
增量判断必须与它一致，否则会引入已记录过的 ping-pong：

- 若用整条 `JSON.stringify` 比较：两台设备持有同一枚 quick dose、`createdAt` 不同（导入会补写）时，合并认为相同、增量认为不同 → 每次同步都重推 → 永不收敛。这正是 `fingerprintState` 注释里那起事故。
- 若比较字段比 `contentFingerprint` 更少：合并认为变了、增量认为没变 → 云端永远收不到这次编辑。

因此 `recordDocs.ts` 在拆分 payload 时同时算出每条记录的身份串：

| 记录 | 身份 |
|:--|:--|
| `dose:` / `lab:` / `tpl:` / `quick:` / `journal:` | `contentFingerprint(kind, record)` |
| `del:<mode>:<kind>` | tombstone map 排序后的 `id=at` 串 |
| `scalar:weight` / `pkParams` / `medPlan` | `stableString(value)@stamp` |
| `scalar:appSettings` | 见决定 3 |

`stableString` 做键排序与数字归一（`4`、`4.0`、`"4"` 等价），与合并引擎相同。

### 决定 3：`scalar:appSettings` 用「服务端合并语义」下的子集判断

服务端 `mergeIncomingAppState` 对设置包做**按键并集**（incoming 覆盖 prior，prior 独有键保留），不是整包替换。
所以「本地包是远端包的子集且同 stamp」时，写上去服务端不会有任何变化。

若仍按等值判断：本地包比服务端少一个键（典型是 agent 用 `PATCH /api/settings` 写进 `timezone`，而本地 stamp 更旧导致整包取值落在本地）时，每轮同步都会重推同一个 doc，服务端再并集一次 —— 写放大但不丢数据。用子集判断后，这类 doc 不再发。

真正的「删键」在当前协议里无法表达（服务端永远并集），所以子集判断没有语义损失。

### 决定 4：推送响应默认不再回传整份状态（`echoState: false`）

`POST /api/records/batch` 原本每次写完都 `buildExportPayload`：解密并重组**全部**记录再返回。
增量之后一次编辑只发 1 条，却仍要为它重组 354 条 —— 响应体和服务器 CPU 都随历史增长。

客户端从未使用响应里的 `state`（`useCoreSync` 只读 `summary`），所以：

- 请求体新增可选 `echoState: false`；
- 为 false 时服务端跳过 `buildExportPayload`，只返回 `{ written, rejected }`；
- 缺省仍为 true，保持旧客户端与其他调用方（含 `server/test/records.test.ts` 对 `body.state` 的断言）不变。

### 一并修掉的旧缺陷：读分页的复合游标

`readCoreState` 只传 `before`（时间戳），不传 `before_id`。服务端早就实现了 `(taken_at, id)` 元组游标，客户端却没用 —— 当第 1000/1001 条记录落在同一时刻（批量导入常见）时，页边界会跳过整组。
增量同步让这次读更重要（它是增量的基准），所以一并补上：翻页时同时发送本页最后一行的 `taken_at` 与 `id`。

### 验收（对应 handoff）

| 验收项 | 结果 |
|:--|:--|
| 大账号（>64 KiB）不再触发 keepalive 限制 | 空闲同步发送 0 条；单条新增 body ≤ ~300 B，`keepalive` 生效 |
| 新记录 1 秒内上传 | 不变：`PUSH_DEBOUNCE_MS = 1000`，增量只缩短上传时间 |
| 删除不复活 | tombstone doc 仍按并集比较，本地新增即上传 |
| 两端交替编辑不 ping-pong | 身份定义与合并引擎同源；`check-sync-merge.mjs` 新增用例覆盖 |
| 不新增合并规则 | `mergeSyncStates` 一行未改 |

### 已知边界（未做，记录在案）

- **读仍是全量**（分页到读完）。再往下要 `GET /api/records?since=<server updated_at>`：`records.updated_at` 列已存在，删除以 `del:` 记录本身传递，`settings` 行单独按 stamp 取。属于下一阶段，不在本次范围。
- **首次同步仍是全量**：新设备/新账号首推 ~350 条 ≈ 200 KB，走非 keepalive 请求（已在 2.0 实测可用）。路由上限 8 MB，未做分块。

---

## 3.2 客户端持 DEK、上传密文（中间方案）

### 目标与非目标

- 目标：上传 body 与中间日志里不再出现明文；服务端收到后用同一 DEK 解开再落库。
- **不是 E2EE**：服务端仍持 KMS 包裹的 DEK 副本（`server/src/session.ts` 的 server wrapper），MCP、分享、校准、导出、`buildExportPayload` 都依赖「服务端能读」。任何文档不得暗示相反结论。

### 3.2.1 密钥交付

新增 `GET /auth/dek`（挂在已有会话解析之后，与 `/auth/sessions` 同级）：

- 返回 `{ dek: <base64>, caps: { sealed: 1 } }`；`dek` 即 `AuthContext.dek`（记录密钥 R = DEK ⊕ H，32 字节 base64）。
- 必须 `Cache-Control: no-store`；不得进任何日志。
- 与 `/api/records` 同样的两道门：401（locked，需要口令）与 403 `account_incomplete`。
- 安全边界没有变化：今天拿到 `ks_` token 就能 `GET /api/records` 读到明文，这个端点只是把同一权限显式化。
- 客户端只在**内存**持有：登录/解锁后取一次，登出、账号切换、应用锁重锁时丢弃。禁止写 localStorage / secureStore 之外的任何持久化（`scripts/check-local-storage.mjs` 已经禁止裸写，需确认新代码不触发）。
- 刷新页面后 token 仍有效 → 重新取；取不到就退回明文上传，同步不因密钥不可用而失败。

### 3.2.2 线格式

`data` 字段二选一：

```
{ ...明文对象 }                                   // 旧客户端，服务端继续接受
{ enc: 'aes-256-gcm', iv: b64, ct: b64 }          // 新客户端；ct 末尾 16 字节是 GCM tag
```

- 用 WebCrypto：`crypto.subtle.encrypt({name:'AES-GCM', iv}, key, utf8(JSON.stringify(data)))`，输出为 `ciphertext||tag`，与 node 的 `cipher.update()+final()` 加 `getAuthTag()` 不同，**不能直接复用** `payloadCrypto.decryptPayload` 的 `iv:tag:ct` 解析。服务端解密时 `ct` 按最后 16 字节切 tag。
- 信封不带版本号之外的语义；`enc` 是唯一的判别字段（未知 `enc` → 拒绝该条，不猜测）。
- 不用 `v2:` 前缀：那是**存储**层的标记（`payloadCrypto.DEK_SEALED_PREFIX`），线上与存储必须能区分，否则服务端会把自己的密文当客户端密文再解一次。

### 3.2.3 服务端改动点（一次只碰一个函数）

1. `prepareRecord` 之前解包：新增 `openIncoming(ctx, item)`，只处理 `data` 为信封的情况，解不开 → `{ok:false, id, reason:'data: undecryptable'}`。
2. **顺序**：`putMany` 里 `openIncoming` 必须在 `mergeIncomingAppState`、`readTombstoneMaps`、`scalarOf` **之前**执行 —— 这三个函数都直接读 `data` 的明文结构（设置包并集、墓碑清扫、标量投影）。`put` 单条写入同理。
3. 解包后仍走现有 `seal()` 落库：存储格式保持单一（`v2:` + DEK），轮换密钥 `reencryptAll` 不受影响。
4. 拒绝而不是降级：解不开时**不能**把信封原样落库（否则 MCP/分享读到的是密文），也不能当明文存。按 id 报 `rejected`，客户端视为失败并重试明文 —— 这条是「失败回退不丢数据」的实现。
5. 读路径不变：`GET /api/records` 继续返回明文（服务端解密），所以 Web 端读逻辑零改动。这是中间方案的边界，也是下一阶段（读也封印）的入口。

### 3.2.4 风险与边界

- DEK 进入 JS 内存后的暴露面与现有「解锁后本地密钥在内存」同级；XSS 本来就能读明文，不比现状更差。
- 不解决服务端可见性，也不改变「运营商可读」的事实。
- 两种客户端必须能共存：明文客户端与密文客户端写同一批 id，服务端都接受，合并规则不变。
- 若将来把 `GET /auth/dek` 换成口令派生（真 E2EE），本线格式可直接复用，只需换密钥来源。

### 3.2.5 测试清单（实现前先写成用例）
服务端（`server/test/records.test.ts` / 新增 `server/test/sealedUpload.test.ts`）：

1. WebCrypto 形状的信封被正确解开并落库：随后 `GET /api/records` 返回明文等价对象。
2. 篡改 `ct` 一个字节 → 该 id 被 `rejected`，数据库无此行，其余记录照常写入。
3. 用另一账号的 DEK 加密 → 拒绝，不落库。
4. 明文 `data` 仍然接受（旧客户端）。
5. `scalar:appSettings` 以密文上传 → 服务端并集仍生效（顺序 bug 的回归用例）。
6. `del:<mode>:<kind>` 以密文上传 → 墓碑清扫仍执行。
7. `scalar:weight` 以密文上传 → `user_settings.body_weight_kg` 仍被投影。
8. `GET /auth/dek`：401 locked / 403 incomplete / `Cache-Control: no-store` / 返回 32 字节 base64。
9. `syncWithCore(..., { sealed: true })` 端到端：写入后 `readCoreState` 能读回，且 MCP 的 `hrt_get_settings` 读到同一份设置。

客户端（`scripts/check-sealed-upload.mjs` 纯函数检查 + 现有 sync 检查）：

10. 信封解析/构造与 WebCrypto 输出一致（tag 在末尾、长度校验）。
11. DEK 只进内存：登出/锁屏后清空；`check-local-storage.mjs` 仍通过。
12. 服务端拒绝密文时自动重试一次明文（不得重复业务写入，id 幂等）。
13. `caps.sealed` 缺失时不发密文（旧服务端兼容）。

---

## 3.2 的结论：不做

评估后的判断：**按「只封上传」的范围，收益窄、代价长期**。

- 密钥和密文走同一条通道：能读请求体的中间层同样能读取密钥的响应。
- 读路径不变：每次同步的 `GET /api/records` 仍返回完整明文，经过同一层代理与日志。
- 服务端仍持 KMS 副本，MCP / 分享 / 校准 / 导出都依赖它，所以「运营商看不到」没有改变。
- 1.2.3 仍在生产，明文路径必须保留，「加密」变成每个客户端自愿打开的开关。
- 长期成本：双格式、每个服务端读取 `data` 的地方都要记得先解包、密钥生命周期与失败回退。

要真正收窄范围，正确做法是配置层不记请求体，或直接做 E2EE（代价是忘记密码即丢数据）。3.2 停留在「花 E2EE 级复杂度、买几行日志里没有明文」，不划算。

---

## 附：分享链接改为客户端加密（已实现）

3.2 里唯一划算的一半——「本地生成」——用在了分享链接上，因为它不需要服务端读：

- 浏览器用一次性随机 256-bit 密钥（AES-256-GCM）加密快照，只上传信封；密钥放在链接的 `#k=` 片段里，浏览器不会把片段发给服务器。
- 服务端 `shares.snapshot` 存 `{ sealed, mode }`，不解释内容；`mode` 是唯一明文元数据，供分享者的列表与实时链接匹配。
- 旧链接（明文快照）与 MCP `hrt_create_share`（服务端生成）继续按原样工作；必要时两条路径共存。
- 实时链接每次刷新都要用同一把密钥重新封装，所以密钥按 share id 存在本机 `secureStore`；另一台设备没有这把钥匙，就无法刷新该链接（会跳过，不发明文）。
- 明文路径的实时刷新被 SQL 条件 `NOT (snapshot ? 'sealed')` 挡住，旧客户端不会把信封覆盖成明文。
- 代价：服务端再也无法运行 `assertShareable`（「快照里不许有化验/体重」）。该保证现在只由浏览器构建快照时承担，`server/src/shares.ts` 的注释已写明。

验证：`scripts/check-share-crypto.mjs`（9 项：往返、错误密钥、篡改、IV、片段解析）、`server/test/shares.test.ts` 新增 4 项（信封往返且数据库无明文、畸形信封被拒、实时只改被点名的 live 链接、明文刷新不能覆盖信封）。
