# 更新日志

本文件记录每个发布版本相对上一个发布版本的变化。当前仓库为 **2.0.2**，基线为 `v1.2.3`
（tag `25d82a5`）加上 `2809a71` 与 2.0.x 的整轮重构。

> **状态**：2.0.2 已于 2026-10-22 部署（网站、Android 标准版与 F-Droid 版、GitHub Release）。

---

## 2.0.2 —— 2026-10-22

### 更新提示改版，并修好"检查更新"没反应

- 安卓更新提示从顶部卡片改为 **M3E 底部抽屉**：手机从底部弹出，宽窗口为居中对话框。
  更新说明、下载按钮与进度条都在同一个面板里，不会再出现"进度画在别处"的情况。
- 修复设置里「检查更新 → 确定」点了没反应：确认框的确定回调里再开对话框时，
  紧跟的 `setIsOpen(false)` 把新对话框一起关掉了。现在先关再执行回调。
  同时，设置里的检查不再用文字确认框，而是直接打开同一个抽屉。
- 下载完成后若用户取消了系统安装，回到应用会自动恢复为可重试状态，不会卡在"安装中"。

---

## 2.0.1 —— 2026-10-22

### 同步：从"每次全量读"改为增量

- 服务端为每次写入打上账号级的 `sync_version`，`GET /api/records?since=N` 只返回之后的变更，
  按 `(sync_version, id)` 升序分页；水位在读取**之前**捕获，因此不会越过本次没读到的行。
- 客户端按账号保存水位与"上次成功推送的身份表"：拉取是增量，推送也只发本机改动的记录，
  不再需要把云端整份状态拿在手里比对。
- 水位或身份表缺失（新设备、清过站点数据、服务端从旧备份恢复）自动回退为全量读。
- 迁移只是加两列一个索引，存量记录保持 `sync_version = 0`，升级后第一次同步自然是全量。

### 界面

- 修复浅色模式下更新提示与快捷记录提示仍是深色：M3E 令牌按 `:root[data-theme="light"]`
  切换，而运行时只切换了 class。`AppContent` 与 `themeInit` 现在同时写入 `data-theme`。
- 两类提示条都支持手机端下滑关闭；桌面窗口多一个关闭按钮。

---

## 2.0.0 —— 未发布

规模：已跟踪文件 **154 个改动（+13,366 / −15,058）**，另有 **62 个新文件**。
改动最集中的是 Web 界面（M3E 重构）、同步层、Android 壳、分享链接与新增的捐赠支持者功能。

### 一览

| 模块 | 主要变化 | 用户能感知到什么 |
|:--|:--|:--|
| Web 界面 | 全站 **M3E（Material 3 Expressive）** 重构，五页 + 新增/编辑用药面板 | 全新的圆角形变、弹簧动效、磁贴与连接式按钮组；手机/桌面两套布局 |
| 同步 | 推送改为**增量**；不再回传整份状态；分页用复合游标 | 空闲同步 0 次写入；改一条只传一条；大账号不再卡在上传 |
| 分享链接 | 快照在**浏览器加密**，钥匙放在链接 `#` 后 | 服务端与日志里只有密文；链接缺了 `#` 部分打不开（有专门提示） |
| 安全 | 分享密码强度与逐链接锁定、应用锁（生物识别）、本地密钥三道防线 | 分享密码不再允许弱口令；APK 可加锁；升级不再“看起来像丢数据” |
| 用药 / PK | `logic.ts` 升级到 2026 文献参数；新增 7 种仅记录化合物、注射溶剂、自定义凝胶产品 |  progesterone 等可记录；EC 水剂/油剂可区分；自定义凝胶按自己的参数画曲线 |
| 体检 / OCR | 识别引擎从 tesseract.js 换成 **PP-OCR**（onnxruntime-web，本机运行） | 扫描更快、更准，模型可选档；照片不出手机 |
| Android | Tauri 2 壳重建 + `HrtLock` / `HrtExport` 原生桥 | 应用锁、系统“另存为”导出、后台重锁、锁屏通知不显示药名 |
| 捐赠 | 新增支持者页、BMC/Afdian webhook、链上交易校验 | 感谢名单页；支持者可提交交易号等待审核 |
| 服务端 | 支持者路由、2 张新表、密封分享、推送去重、MCP 描述补全 | 见下文「服务端 / 云端」 |

---

### 一、界面：M3E 全站重构

- 新增设计层：`src/m3e.css`（769 行）、`src/ui/proto/`（17 个原语，641 行）、
  `src/proto-compat.css`（旧 class 别名，237 行）、`src/onboarding.css`（682 行）、
  `src/components/dose_form/m3e-add-dose.css`。
- 五个主页面按 `docs/m3e-prototype.html` 重写：概览、记录、体检、设置、账户。
  设置页为桌面主从 + 手机钻取（含三级子页）；体检页桌面双栏、手机钻取；记录页支持批量操作。
- 新增 `TimePage`（内联时间选择）、`CalibrationAnimation`（校准设置实时预览曲线）、
  `AppLockGuard` / `AppUnlockScreen` / `AppClockScreen`（应用锁）、`dose_form/catalog.ts`（化合物目录）。
- 删除旧实现：`CreditsRoll`（开发者彩蛋/字幕）、`DateTimePicker`、`ImportModal`、
  `AnimatedNumber`、`CustomSelect`、`HomeQuickAdd`、`OnboardingCurve`、`OnboardingFeatures`、
  `PixelMark`、`dose_form/` 下 6 个字段组件（改由 catalog + 动态字段渲染）。
- 新增原型与参考：`docs/m3e-prototype.html`、`docs/m3e-add-dose-prototype.html`、
  `docs/m3e-onboarding-prototype.html`、`docs/onboarding-reference.md`。

### 二、记录与同步

- **增量推送**：`changedRecords(local, remote)` 以合并引擎自己的记录身份为准，只上传服务端没有的版本。
  空闲同步不再产生写请求；改动一条只上传一条。见 `docs/sync-incremental-and-dek.md`。
- **不再回传整份状态**：`POST /api/records/batch` 支持 `echoState: false`，避免一次小推送解密重组全部历史。
- **复合分页游标**：客户端读取时同时发送 `before` + `before_id`，同一时刻的多条记录不再跨页丢失。
- **本地密钥三道防线**（升级事故修复）：读取失败重试 3×200 ms；已有密文却读不到密钥时拒绝生成新密钥；
  生成后回读校验。`src/utils/secureStore.ts`。
- 合并规则本身**未改**：`mergeSyncStates` 的 tombstone 与 newest-wins 保持一套实现。

### 三、安全与账户

- **分享密码硬化**：`src/utils/passwordStrength.ts`（254 行，前后端共用同一套熵估算）、
  最低 40 bits、逐链接失败锁定（5 次 15 分钟 / 6 次 30 分钟 / 7+ 次 60 分钟）、
  短期签名的 `viewerPass` 让已解锁的读者继续轮询。
- **应用锁（Android）**：`HrtLockBridge` + `src/utils/appLock.ts` + `lockCopy.ts`。
  冷启动生物识别、5 秒以上后台重锁、文件选择器/OAuth 外部流程豁免、5 次失败进入系统 lockout。
  方案见 `docs/android-app-lock-plan.md`。
- **锁屏通知不泄露药名**：通知携带 `notif-hidden` 标记，锁屏只显示“你有一条提醒”。
- **原生文件导出**：`HrtExport` 桥（`ACTION_CREATE_DOCUMENT`），WebView 不再因不支持 `<a download>` 而静默失败。
- **OAuth 深链**：`kira-hrt://oauth` intent-filter 在壳重建后补回，回调不再打开浏览器。

### 四、分享链接：客户端加密

- 快照用一次性随机 256-bit 密钥在浏览器加密（AES-256-GCM），只上传信封；
  密钥放在 URL 片段 `#k=…`，浏览器不会把它发给服务器。
- 服务端存 `{ sealed, mode }`，`mode` 是唯一明文元数据（分享者列表与实时链接匹配用）。
- 旧链接（明文）与 AI 助手在服务端生成的链接继续可用；明文实时刷新被 SQL 守卫
  （`NOT (snapshot ? 'sealed')`）挡住，永不会覆盖密封链接。
- 链接缺片段时显示专门的“链接不完整”页；7 种语言的文案同步更新为“本服务读不到”。
- 代价：服务端无法再校验“快照里没有化验/体重”，该保证移到浏览器构建快照时。

### 五、用药与 PK

- `logic.ts` 升级到 2026 文献参数（260 行改动）。
- 新增仅记录、不建模的化合物：**P4、MPA、NET、RALOX、FIN、DUT、GNRH**；曲线自动跳过它们，不因未知化合物拒算整份记录。
- 注射新增**溶剂**维度：油剂 / 水剂（仅 EC），影响吸收。
- 自定义凝胶产品：`gelProductId ≥ 1000` 的账户自有产品，带自己的浓度、面积与吸收参数；
  服务端按请求作用域注入目录（`withGelProductCatalogue`），不污染全局注册表。
- 用药面板整体重做（`DoseForm.tsx` 2,717 行改动），舌下分层、贴片佩戴、凝胶细节、撕下关联等动态字段。

### 六、体检与 OCR

- 识别引擎由 `tesseract.js` 换成 **PP-OCR**（`src/utils/ppocr.ts`）：onnxruntime-web 跑检测 + 识别两阶段，
  模型、字典与 WASM 全部本地（`public/ocr/`），照片不出设备。
- 体检页重构：手机“文字记录 → 子页”、桌面常驻双栏；化验结果区分模型估算与实测点。
- 监测提示、化验表单、复查提醒的布局与逻辑同步更新。

### 七、Android 应用

- 壳重建为 **Tauri 2.12**（Rust 端 2.12.4，CLI 依赖 2.12.3；`src-tauri/` 本地存在、不入库）。
- `scripts/MainActivity.kt` 新增 `HrtLock`、`HrtExport` 两个 JS 桥；`HrtMessagingService.kt` 配合推送。
- 后台重锁、外部流程豁免、安全区绘制、预测式返回、系统浏览器打开外链。
- `scripts/patch-android-theme.mjs` 负责深链、FCM、主题与桥的落地。

### 八、捐赠与支持者（新功能）

- Web：`DonateSettings`、`SupportersList`、`useSupporters`、`supporterValidation`、品牌图标
  （支付宝/Afdian、Buy Me a Coffee、BTC/ETH/SOL/TRX/BNB/BASE/ARC）。
- 服务端：`supporters.ts`（434 行）、`afdianSync.ts`（161 行）、`chainVerify.ts`（436 行），
  与一组新路由（公开名单、申请、BMC webhook、Afdian webhook、管理端待审/通过/改名/删除）。
- 审核语义：**BMC** 通过 HMAC 签名校验后直接发布；**链上交易**提交时即查链验证
  （BTC / ETH / BNB / Base / Arc / TRON / Solana 的公开端点，只认约定币种），验证通过才出现，
  重复交易号直接拒绝；**Afdian** webhook 带昵称时直接发布、匿名则先 `pending`，
  API 轮询（默认 30 分钟，增量）导入已赞助者。管理端可对待审条目通过 / 改名 / 删除。
- 文档：`docs/supporters-webhooks.md`。

---

## 服务端 / 云端

### 已上线（1.2.3 部署基线）

以仓库与交接文档为准，当前生产运行的是 1.2.3 对应的服务端：逐账户 DEK、口令 KEK + OCI KMS
双重包裹、记录密文入库、MCP 适配器、基础分享链接、本地提醒 + FCM 补推。
**本次没有连接服务器核对**，以上状态来自仓库历史与交接记录。

### 待部署（2.0.0 工作区）

| 类别 | 变化 | 部署动作 |
|:--|:--|:--|
| 数据库 | `shares` 增加 `failed_attempts`、`locked_until`；新增 `supporters`、`supporter_sync_state` 及 5 个索引 | 执行 `server/schema.sql`（全部 `IF NOT EXISTS`，可重复执行） |
| 分享 | 接受/返回密封信封 `{ sealed, mode }`；逐链接实时刷新；明文刷新不覆盖密封行 | 与 Web 2.0 一同发布；旧客户端继续发明文，兼容 |
| 记录 | `POST /api/records/batch` 支持 `echoState: false` | 无迁移 |
| 推送 | 同一药物同一时刻只推一条，与客户端去重身份一致 | 无迁移 |
| MCP | 酯列表改为从引擎枚举派生；补全仅记录化合物、溶剂、凝胶目录的说明 | 无需重启客户端，工具描述随服务端更新 |
| PK | 服务端模拟注入账户自定义凝胶目录（按请求作用域） | 无迁移 |
| 支持者 | 新增一路由组（7 条路径 / 8 个处理入口）与 3 个模块 | 配置下文环境变量 |
| 清理 | 删除 4 个一次性迁移/取证脚本、3 个临时 MCP 探针 | 无 |

新增环境变量（`server/.env.example` 已列出）：

```bash
BMC_WEBHOOK_SECRET=          # Buy Me a Coffee webhook 签名密钥（缺失时该路由 503）
SUPPORTERS_ADMIN_TOKEN=      # 管理端 Bearer token，≥24 字符（缺失时管理路由 404）
AFDIAN_USER_ID=              # Afdian Open API，两个一起配置或都不配
AFDIAN_API_TOKEN=
AFDIAN_SYNC_INTERVAL_MINUTES=30
```

部署顺序（完整命令见 `server/DEPLOY.md`）：跑 schema → 配置上述变量 → 重启服务 →
构建并发布 Web（`VITE_API_ORIGIN=… npm run build`）→ 需要时再发 APK。分享密封与增量同步
都要求 Web 2.0，旧客户端不会因此报错。

---

## 构建与依赖

- 版本号 `1.2.3 → 2.0.0`。
- 升级：React 19.3.1、Vite 8.3.4、TypeScript 7.0.2、Tauri CLI 2.12.3、uuid 14、reicon 1.2.5、
  jspdf-autotable 5.0.9、@tauri-apps/plugin-opener 2.7.2。
- 新增：`@alerix/m3-loading-indicator`、`tslib`。
- 移除：`tesseract.js`（换 PP-OCR）、`reicon-mcp`（开发期 MCP）。
- 构建门禁：`build:android` 与 `postbuild` 增加 `check-local-storage.mjs`（明文只允许 11 个启动壳文件）。
- 开发代理新增 `/auth`；7 种语言共 1,203 个键，覆盖率检查无缺口。

---

## 删除的内容（避免误以为是回退）

- 界面：开发者彩蛋/字幕（`CreditsRoll` 及 `public/audio/easter-egg-music.mp3`）、
  旧 `DateTimePicker`、`ImportModal`、`AnimatedNumber`、`CustomSelect`、`HomeQuickAdd`、
  旧引导组件、`PixelMark`、旧剂量字段组件。
- 资源：`public/featherline.png`、`kiraequal-logo.png`、`mihari.jpg`、`transmtf.png`、
  `intro-avatar.webp`（迁到 `scripts/assets/` 供 OG 生成脚本使用）、
  `src/flag_svg/` 下 7 个不再渲染的国旗 SVG。
- 服务端：4 个已完成的一次性迁移/取证脚本、3 个临时 MCP 探针；6 处死代码
  （`pushMedPlan`、废弃的 `isRecordKey`、`accountRecordCounts`、两个未使用的校验器、两个未使用的测试导出）。

---

## 上线前仍需完成

1. 提交工作区（2.0.0），打 tag；按 `server/DEPLOY.md` 部署服务端并执行 schema。
2. 真机回归：应用锁全流程、覆盖升级后旧记录可读、分享链接在聊天软件里转发后能打开、
   增量同步后账户页时间正常、锁屏通知不显示药名。
3. 分享链接上线后检查一次数据库：`SELECT snapshot->>'sealed' …` 确认新链接只有信封，
   旧链接仍为明文且可读。
4. 观察一版：同步错误率、`/api/records/batch` 请求体大小、支持者 webhook 签名失败日志。

---

## 已修复的文档漂移

README（中/英）此前描述“仓库根目录 `android/` 是纯原生 Kotlin + Compose 工程”，
与仓库现状不符（`android/` 不存在，Android 走 Tauri 2 壳）。两处说明与构建命令已更正。
