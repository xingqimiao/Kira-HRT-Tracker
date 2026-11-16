# Kira HRT Tracker | Agent 全栈安全审计与深度 Bug 排查任务书

> **核心目标**：以可复现的代码证据与自动化测试，全面发现仓库中的**安全漏洞（Security Vulnerabilities）**与**功能/逻辑/数据一致性缺陷（Functional & Logic Bugs）**。审计的目标是暴露真实问题，绝不是“证明代码没有问题”。
>
> **目标仓库**：https://github.com/xingqimiao/Kira-HRT-Tracker （以当前工作区实际 checkout 的 `rewrite` 分支提交为准，开始前必须记录 `git rev-parse HEAD`、`git status` 与各 lockfile 哈希。严禁仅凭 `README.md` 或已有审计文档宣称代码安全或无 Bug）。

---

## 0. 最高优先级操作安全红线：生产环境绝对只读，本地隔离才能测试

**这是一条不可豁免的最高硬约束，优先于后续一切指令。**

1. **生产环境绝对只读**：
   - 生产云服务器、在线数据库、生产 API/MCP（如 `*.kiramyao.com`）、真实 OAuth 提供商、真实 FCM、真实 OCI KMS、真实赞助平台与真实用户设备：**仅允许做被动的只读静态配置观察（且需授权与脱敏）**。
   - **严禁**对任何生产域名、线上 IP、真实云资源发起主动探测、漏洞利用、PoC 请求、端点枚举、Fuzzing、扫描、越权测试、慢速/负载测试、KMS 解密调用、发送测试推送或使用真实账号/Token 测试。禁止将生产地址填入任何自动化测试或扫描工具。
2. **熔断机制**：
   - 若在环境中检测到生产环境变量、线上数据库地址、真实 OCI/OAuth/FCM 密钥或 SSH 目标：**立即中止任何动态运行与破坏性操作**，退回纯离线静态代码审计或切换至纯本地内存/临时隔离环境，并在报告中记录拦截原因。
3. **100% 本地合成环境**：
   - 所有动态测试、Fuzzing、并发竞态与故障注入必须在**本机回环地址（`127.0.0.1` / `localhost`）、隔离容器或本地 Android 模拟器**中执行，且只能使用从零生成的合成数据（Synthetic Fixtures）。
   - PostgreSQL 必须使用仓库自带的本地一次性测试实例（注意 Windows 下 Postgres 不能以管理员提权令牌启动，须遵循 `tools/README.md` 使用低权限 runner）。严禁导入生产数据库 dump。
   - OCI KMS 必须使用仓库内的 `setKmsClientForTesting` 或本地 Mock HSM。
4. **本地 Git 保护**：
   - 审计阶段不自动 commit、不 push、不发 PR、不覆盖工作区未提交修改、不执行无差别的 `npm audit fix` 或大版本依赖升级。只有在初版审计报告完成后，才允许在独立本地分支编写最小修复候选与回归测试。

---

## 1. 标准基线参考：如何高效使用本地 OWASP ASVS 5.0 与 OWASP MASVS

本项目的本地 `doc/` 或 `docs/` 目录中存放有标准参考文件（文件名包含 `OWASP_Application_Security_Verification_Standard_5.0.0_en` 与 `OWASP_MASVS`）。

**Agent 检索与使用规则（严禁一次性全文读入撑爆上下文）**：
1. **定位与索引**：在阶段 1 先使用文件查找工具定位本地 `doc/` 与 `docs/` 下的 OWASP ASVS 5.0 和 OWASP MASVS 文件路径，仅读取其目录结构/章节索引。
2. **裁剪适用等级**：
   - 本项目处理高度敏感的个人医疗健康与用药记录（HRT 记录、化验单、体感日记），服务端与 Web 端默认对照 **OWASP ASVS 5.0 Level 2（关键加密与密钥管理对照 Level 3）**。
   - Android / Tauri 移动端对照 **OWASP MASVS** 全域（重点：`MASVS-STORAGE`、`MASVS-CRYPTO`、`MASVS-AUTH`、`MASVS-NETWORK`、`MASVS-PLATFORM`、`MASVS-CODE`、`MASVS-RESILIENCE`）。
3. **按模块精准映射**：在审计第 3 节的各个模块时，按需检索本地 OWASP 文档中对应的具体章节，逐条核对代码实现，并在发现的问题及测试矩阵中标注具体的控制项编号（例如 `ASVS 5.0 V6.2.x`、`MASVS-STORAGE-1`）。不适用项必须注明 `N/A` 及技术原因，禁止形式主义打勾。

---

## 2. 执行工作流与防上下文丢失协议（增量落盘）

为防止长任务中途丢失细节或流于表面，必须严格按以下顺序分阶段推进，并每完成一个模块立即更新落盘文件：

1. **阶段 0：维护进度看板**：首先创建 `security-audit/PROGRESS.md`，列出所有待审模块、当前状态（`PENDING` / `IN_PROGRESS` / `DONE` / `BLOCKED`）、已发现的 `KHT-SEC-*` 与 `KHT-BUG-*` 计数。每审完一个子模块立即更新该文件。
2. **阶段 1：基线冻结与文档漂移核查**：
   - 记录 commit、OS、工具链版本、依赖锁哈希、环境变量名（绝不输出值）。
   - 阅读 `SECURITY.md`、`README.md`、`server/CODE-AUDIT.md`、`server/ARCHITECTURE.md`、`server/DEPLOY.md`、`server/MCP.md`、`docs/android-app-lock-plan.md`、`docs/sync-incremental-and-dek.md`、`docs/hrt-import-export-protocol*.md`，并定位本地 OWASP ASVS 5.0 与 MASVS 文档。
   - **重点找出“文档声称已实现/已防护”但“代码实际未实现或存在逻辑缺口”的漂移项**，直接记入发现列表。
3. **阶段 2：全量资产、入口与状态机清单（`01-inventory.md`）**：
   - 穷举所有 HTTP 路由、MCP Tool（以运行时实际注册为准）、后台定时/同步任务、Webhook、OAuth 回调、Tauri command/capability、Kotlin `@JavascriptInterface`、Android Manifest 组件、Service Worker、文件解析器、KMS 调用点、数据库表与约束。
4. **阶段 3：威胁建模与业务不变量定义（`02-threat-model.md`）**：
   - 结合 STRIDE 与 OWASP ASVS/MASVS 建立安全威胁模型。
   - 同时定义**核心业务不变量（Business & Data Invariants）**：例如“任何同步冲突或加密失败不得静默丢弃用户的历史用药/化验记录”、“同一账号在不同设备合并后记录集必须收敛一致”、“PK 引擎与校准器在极端输入下不得产生 `NaN`/`Infinity` 污染 UI 或数据库”。
5. **阶段 4：本地现有测试基线运行**：
   - 在确保本地隔离的前提下，运行仓库现有测试、类型检查（`tsc`）与构建脚本，记录真实通过/失败/跳过情况。
6. **阶段 5：逐模块深度静态代码追踪 + 负向安全测试 + 边界 Bug 测试**：
   - 按照第 3 节的 A～K 模块逐一深挖。**每看完一个模块的代码，立刻写对应的本地复现测试（放入 `security-audit/repro/`）并把发现追加写入 `03-findings.md`**，绝不拖延到最后凭记忆汇总。
7. **阶段 6：独立复核与最小修复候选**：
   - 交叉核验所有发现，剔除误报，补齐未覆盖清单；在本地隔离分支针对确认的高优漏洞与 Bug 编写失败测试（Red）与最小修复（Green）。

---

## 3. 必须逐项深挖的 11 大审计域（安全漏洞 + 功能/逻辑 Bug 双轨检查）

### A. API、HTTP、身份认证、会话与 OAuth (`ASVS V1/V2/V3/V4/V13`)
* **重点文件**：`server/src/http.ts`、`accounts.ts`、`oauth.ts`、`session.ts`、`turnstile.ts`、`config.ts`、`src/services/apiClient.ts`、`src/hooks/useCoreSession.tsx`。
* **安全审计**：
  - 构建“路由 × 身份（匿名 / 用户A / 用户B / 过期Session / 已注销Session / MCP Token / 只读分享凭证）”访问控制矩阵，排查 BOLA/IDOR、BFLA、批量赋值（Mass Assignment）。
  - 检查 CSRF/CORS/Origin 校验、Content-Type 绕过、请求体大小上限、慢速连接、代理头（`X-Forwarded-For` 等）伪造导致的限流绕过、计时侧信道、用户枚举。
  - 检查 OAuth（X/Google）的 `state` 绑定、PKCE、redirect URI 严格校验、临时 code 的原子一次性消费（并发重放测试）、账号绑定/解绑时的身份抢占或孤儿账号问题。
  - 验证口令 KDF 参数、超长口令 DoS、Unicode 正规化、修改密码或删除账号后所有存量 Session / MCP Token / 分享链接 / 推送绑定的清理完整性。
* **功能与状态机 Bug**：
  - 并发刷新会话、断网重连、Web/Android 多端同时操作账号设置时的前端状态撕裂（`useCoreSession` 竞态）。
  - 注册/登录/绑定失败时的错误状态恢复、Turnstile 验证超时或重试卡死问题。

### B. MCP 协议与 AI Agent 交互边界 (`ASVS V4/V5/V13`)
* **重点文件**：`server/src/mcp.ts`、`server/src/http.ts`、`server/MCP.md`、`server/test/mcp.protocol.test.ts`。
* **安全审计**：
  - 清点运行时实际注册的每个 MCP Tool，对比文档差异。
  - 用两个合成账号交叉调用全部读写工具，验证是否存在跨用户越权读写/删除。
  - 核查 `hrt_` Agent Token 的权限范围：是否允许通过 MCP 越权修改账号安全设置、管理其他 Token 或绕过仅限 Web 交互的操作？密码重置或设备踢出时 `hrt_` Token 的行为是否与 UI 提示完全一致？
  - **间接提示词注入（Indirect Prompt Injection）**：当笔记（journal）、药物备注、分享标题或导入的记录中包含恶意指令文本时，MCP 返回的结构化内容是否有清晰的数据隔离提示，防止宿主 Agent 被劫持去调用删除/导出/修改工具。
* **功能与协议 Bug**：
  - Streamable HTTP / JSON-RPC 批处理、半包/畸形 JSON、超大参数、未知方法、并发 `tools/call` 时的异常捕获与连接泄漏。
  - MCP 写入记录后，版本号（sync version）、时间戳、字段默认值是否与前端写入完全一致，是否会写入前端无法渲染的脏结构。

### C. PostgreSQL 数据层、SQL 注入与事务并发 (`ASVS V5/V14`)
* **重点文件**：`server/src/db.ts`、`records.ts`、`accounts.ts`、`shares.ts`、`core.ts`、`server/schema.sql` 及所有含 SQL 查询的文件。
* **安全审计**：
  - 逐条审查 SQL 语句（特别关注动态拼接、排序、分页游标、JSONB 操作、批量 `UNNEST`/数组参数）。
  - **逐条核查 `WHERE` 子句中的 `user_id` 所有权绑定**（尤其是 `UPDATE`、`DELETE`、软删除标记、批量同步接口）。
  - 检查数据库表结构约束（Unique、FK、Check、NOT NULL）是否与业务假设一致。
* **功能与并发 Bug**：
  - **增量同步游标竞态**：高并发写入或长事务提交顺序反转时，基于 `version` 的增量拉取是否会漏掉晚提交但低版本号的记录（Lost Sync Update）？
  - 事务边界与部分失败回滚：账户删除、密码重加密迁移、批量写入在中途抛错时是否会留下半成品数据或死锁？连接池在高并发报错时是否会泄漏连接？

### D. 密钥体系（KMS、KEK、DEK、AES-256-GCM）与加密迁移 (`ASVS V6`, `MASVS-CRYPTO`)
* **重点文件**：`server/src/kms.ts`、`session.ts`、`payloadCrypto.ts`、`accounts.ts`、`src/utils/shareCrypto.ts`、`server/test/keyMaterial.test.ts`。
* **安全审计**：
  - 追踪 KEK、DEK、明文记录在内存、缓存、DB、日志中的完整生命周期。
  - 验证 AES-256-GCM 的 IV/Nonce 唯一性、认证 Tag 长度与强校验、**AAD（附加认证数据）是否严格绑定 `user_id` / 记录标识 / 版本**（测试在数据库中把用户 A 的密文列复制到用户 B 名下，验证服务端是否会用 B 的 DEK 尝试解密或报出区分性错误）。
  - 使用本地 Fake KMS 注入故障：KMS 超时、返回畸形密钥、权限拒绝、并发解密同一账户 DEK 时的缓存竞态，验证是否严格 Fail-Closed。
* **功能与数据完整性 Bug**：
  - 密钥轮换、密码重置或旧格式密文升级迁移中途中断后，用户再次登录是否会导致部分记录永久不可读或覆盖丢失？

### E. Android / Kotlin 原生桥 / Tauri 2 / 本地安全存储 (`MASVS-STORAGE/PLATFORM/CODE/RESILIENCE`)
* **重点文件**：`scripts/MainActivity.kt`、`scripts/HrtLockBridge.kt`、`scripts/HrtMessagingService.kt`、`src-tauri/`、`src/utils/appLock.ts`、`src/utils/secureStore.ts`、`src/utils/nativeUpdate.ts` 以及生成的 AndroidManifest / Gradle 配置。
* **安全审计**：
  - 逐一审查 `@JavascriptInterface` 导出方法与 `src-tauri/capabilities/default.json` 权限配置，确认 WebView 无法被诱导访问任意外部 Origin 并调用原生桥。
  - 检查 Deep Link / Intent / FileProvider 配置、导出组件（`android:exported`）、备份标志（`allowBackup`）、网络安全配置（Cleartext HTTP）、剪贴板与后台任务截图防护（`FLAG_SECURE`）。
  - 自更新安全（`nativeUpdate.ts`）：核查更新清单获取、版本号比较逻辑、APK SHA-256 校验、下载目录权限，以及商店构建（`HRT_NO_FCM=1 VITE_NO_SELF_UPDATE=1`）是否彻底剥离了自更新与 Firebase 代码。
* **高优先级跨版本升级与状态机 Bug**：
  - **本地加密与迁移可靠性（最高优先级）**：仔细推演 `secureStore.ts` 与 `HrtLockBridge.kt` 在“旧版明文→新版加密”、“KeyStore 临时读取异常 vs 密钥永久丢失”、“应用启动瞬间未解锁时的后台同步/通知触发”、“生物识别弹窗期间切后台/旋转屏幕/分屏”等边界下的行为。**严禁因单次读取或解密瞬时失败就静默清空或用空数组覆盖本地/云端数据！**

### F. React 前端、TypeScript、PWA 与离线缓存 (`ASVS V5/V8/V14`)
* **重点文件**：`src/App.tsx`、`src/components/`、`src/pages/`、`src/hooks/`、`src/services/`、`vite.config.ts`、`public/firebase-messaging-sw.js`。
* **安全审计**：
  - 排查 DOM XSS、`dangerouslySetInnerHTML`、SVG/动态链接注入、原型链污染、导出文件名/CSV 公式注入。
  - 检查 PWA Service Worker 缓存范围：是否意外缓存了带身份的 API 响应或分享链接数据？用户退出登录、切换账号或擦除数据后，IndexedDB / LocalStorage / CacheStorage / 内存状态是否彻底清零？
* **前端交互与状态 Bug**：
  - 排查 React Hooks 闭包过期（Stale Closure）、异步请求竞态（旧请求晚返回覆盖新状态）、快速连点重复提交（Double Submit）、组件卸载后状态更新、撤销（Undo）操作与自动云同步的时序冲突。

### G. 数据导入/导出与第三方格式解析器 (`ASVS V5/V12`)
* **重点文件**：`src/components/ImportSection.tsx`、`src/utils/foreignImport.ts`、`featherlineBackup.ts`、`src/services/export.ts`、`docs/hrt-import-export-protocol*.md`。
* **安全与健壮性审计**：
  - 针对 Kira 原生格式、Oyama、Transmtf JSON、Featherline `.hrtbackup` 及加密备份编写本地属性测试（Property-based Testing / Fuzzing）。
  - 覆盖：超大文件、深层嵌套、包含 `__proto__`/`constructor` 的 JSON、异常时间戳（负数、0、`NaN`、远古/未来日期）、负剂量/无穷大剂量、未知药物/给药途径枚举、错误密码、被截断的密文/IV/Tag。
* **功能与数据一致性 Bug**：
  - 验证“先完整校验预览 → 用户确认后原子写入 → 同步触发”流程；验证导入失败时不会污染现有数据；验证重复导入同一份备份时的去重（Deduplication）准确性；验证**“导出后再导入”的往返语义等价性（Round-trip Equivalence，无精度退化或字段丢失）**。

### H. 本地 PP-OCR 化验单识别与 ONNX/WASM (`ASVS V5/V12`)
* **重点文件**：`src/utils/ppocr.ts`、`ocrParse.ts`、`scanBoxes.ts`、`src/components/LabScan.tsx`。
* **安全与隐私审计**：
  - 验证图片与识别全流程 100% 在本地完成，绝无外发网络请求或敏感日志残留。
  - 测试畸形图片、极端宽高比、超大分辨率图片引发的内存溢出（OOM）或 Worker 卡死。
* **识别解析 Bug**：
  - 测试 `ocrParse.ts` 与 `scanBoxes.ts` 在多列排版、倾斜/折行、相似项目名称、单位混淆（`pg/mL` vs `pmol/L`、`ng/dL` vs `nmol/L`）、小数点漏识/误识、参考范围被误当成实测值时的解析行为，确保异常值有显著提示且必须经用户人工确认才可入库。

### I. 药代动力学（PK）模型、个体化校准、增量同步与提醒业务 (`核心业务 Bug 重点区`)
* **重点文件**：`logic.ts`、`src/pk/`、`src/hooks/useCoreSync.ts`、`src/utils/syncMerge.ts`、`server/src/records.ts`、`shares.ts`、`push.ts`、`supporters.ts`、`afdianSync.ts`。
* **PK 数学模型与校准算法 Bug（必须深入代码推导与测试）**：
  - **两套引擎（内置引擎 vs Transmtf 引擎）与 4 种校准模式（关闭 / MIPD / EKF / OU-Kalman）**：
    - 当化验数据为空、仅有 1 条极端异常化验值、同一时间点有多条化验值、化验时间早于首次用药时间、或用药记录存在零间隔/大跨度断档时，MIPD / EKF / OU-Kalman 是否会出现**除零、矩阵奇异/非正定、参数发散、`NaN` / `Infinity` 传播**，进而导致整条浓度曲线崩溃？
    - **给药途径细节 Bug**：贴片（Patch）的贴上与摘下配对逻辑（如果未摘下、重复摘下、乱序摘下或删除了关联贴片，佩戴时长与释放曲线如何计算？）；凝胶（Gel）涂抹面积、同涂物质与洗去时间（洗去时间早于涂抹时间或跨天时如何计算？）；舌下（Sublingual）吸收等级切换。
    - **单位换算与抗雄累计量**：`pg/mL` ↔ `pmol/L`、`ng/dL` ↔ `nmol/L` 在图表渲染、校准器输入、化验对比、MCP 输出中的换算系数是否完全统一？抗雄激素累计剂量在编辑/删除历史记录或修改方案后是否准确重算？
* **云同步、分享、通知与 Webhook 审计**：
  - **多端增量同步（`useCoreSync.ts` / `syncMerge.ts`）**：用双客户端模拟“离线修改同一条记录”、“一端修改一端删除（Tombstone 冲突）”、“跨时区/系统时钟偏差”、“分页拉取中途有新写入”，验证合并后数据是否一致且不丢记录。
  - **用药提醒双通道去重**：本地定时通知与服务端 FCM 补推在时区切换、夏令时（DST）跳变、修改方案周期（每日 N 次 / 每 X 小时 / 每 X 天）时，是否会漏报、重复轰炸或锁屏泄露敏感药物名称？
  - **只读分享（`shares.ts`）**：验证分享链接是否严格只包含用户勾选的数据子集，未勾选的日记/历史记录是否会残留在加密负载或接口响应中；验证分享密码爆破限流、过期时间与撤销实时性。
  - **赞助者 Webhook（`supporters.ts` / `afdianSync.ts`）**：验证签名校验（常数时间比较、原始字节）、重放防护、幂等入库，以及恶意赞助者昵称/头像 URL 的 XSS 与 SSRF 防护。

### J. SSRF、出站网络请求、部署配置与供应链安全 (`ASVS V10/V12/V14`)
* **重点文件**：`server/src/urlGuard.ts`、`avatars.ts`、`oauth.ts`、`server/deploy/hrt-server.service`、CI 脚本与所有 lockfiles。
* **安全审计**：
  - 在本地受控 DNS/HTTP Mock 下测试 `urlGuard.ts` 与 `avatars.ts`：重点验证 DNS Rebinding（TOCTOU：校验时返回公网 IP，实际连接时解析到 `127.0.0.1` / `169.254.169.254` / IPv6 内网映射地址）、HTTP 30x 跨跳重定向、超大响应体流式截断、畸形 Content-Type。
  - 审查 `hrt-server.service` systemd 加固项、HTTP 安全响应头（CSP、HSTS、X-Content-Type-Options、Referrer-Policy）、CORS 白名单。
  - 扫描两套 `package-lock.json`、`Cargo.lock` 与 Gradle 依赖：必须结合代码调用链判断 CVE **是否真实可达（Reachable）**，严禁把未调用的开发期依赖告警直接充数报为高危漏洞。

### K. 全局代码质量、异常处理与边界可靠性
* 排查未捕获的 Promise rejection、定时器/事件监听泄漏、国际化（7 种语言）翻译占位符缺失导致的渲染崩溃、极端屏幕尺寸或无障碍模式下的交互阻断。

---

## 4. 发现报告标准与分级规范（拒绝无证据猜测）

所有发现统一编号并分类：
* **安全漏洞**：编号 `KHT-SEC-001`、`KHT-SEC-002`...
* **功能/逻辑/计算/同步 Bug**：编号 `KHT-BUG-001`、`KHT-BUG-002`...

每个条目必须包含以下完整字段：
1. **基本信息**：标题、类型（`SECURITY` / `BUG`）、严重度（`Critical` / `High` / `Medium` / `Low` / `Info`）、证据等级（`CONFIRMED` 本地已动态复现 / `LIKELY` 代码链路确凿但受环境限制未动态跑通 / `HYPOTHESIS` 需进一步验证）。
2. **标准映射**：对应 CWE 编号、OWASP ASVS 5.0 条款号或 OWASP MASVS 控制项（若为功能 Bug 则标注违反的业务不变量）。
3. **精确定位与数据流**：精确到 `文件路径:起止行号`，完整写出“触发入口 → 调用链/状态流转 → 缺失的校验或错误的分支 → 最终危害”。
4. **影响评估**：按以下优先级评估真实影响：
   `跨账号医疗数据泄露 > 用户记录静默丢失/覆盖/损坏 > 远程代码执行/原生桥提权 > PK/校准数值严重失真误导用户 > KMS/Token/凭证泄露 > 账户接管 > 分享越权 > UI崩溃/同步卡死/提醒失效 > 其他缺陷`。
5. **本地可复现 PoC / 测试用例**：给出在 `security-audit/repro/` 下编写的自动化复现测试脚本路径、运行命令、输入数据、预期结果 vs 实际结果（附脱敏输出摘要）。
6. **最小修复建议与回归方案**：给出具体到代码级别的修复方案，并说明是否需要做存量数据修复或兼容迁移。

---

## 5. 最终交付物目录结构（输出至本地 `security-audit/`）

请按模块推进并持续更新以下文件：

1. `PROGRESS.md`：实时审计进度追踪表与问题统计看板。
2. `00-scope-and-guardrails.md`：生产只读确认、本地隔离环境验证记录、工具链基线与文档/代码漂移清单。
3. `01-inventory.md`：全栈入口、路由、MCP 工具、原生桥接口、数据库表与文件解析器全量清单。
4. `02-threat-model-and-invariants.md`：STRIDE 威胁模型、OWASP ASVS 5.0 / MASVS 适用性裁剪基线、核心业务与数学不变量清单。
5. `03-findings.md`：汇总所有 `KHT-SEC-*`（安全漏洞）与 `KHT-BUG-*`（功能/逻辑/PK/同步 Bug）的完整证据报告，按严重度排序。
6. `04-owasp-and-test-matrix.md`：安全边界 × 攻击面 × OWASP ASVS/MASVS 条款 × 业务不变量 × 测试状态（仅限 `PASS` / `FAIL` / `NOT_RUN` / `BLOCKED` / `N/A`）× 证据脚本路径。
7. `05-migration-sync-and-pk-verification.md`：专项报告——Android 覆盖升级与密钥迁移测试、多端增量同步冲突测试、两套 PK 引擎与 4 种校准器边界测试结果。
8. `06-dependencies-and-deployment.md`：依赖可达性漏洞分析、构建渠道隔离（标准包 vs F-Droid 无 FCM/无自更新包）核查、部署配置加固建议。
9. `07-remediation-plan.md`：按“风险 × 可利用性/触发概率 × 用户影响 × 修复回归风险”排序的分阶段修复路线图。
10. `executive-summary.md`：一页纸管理摘要（总体健康度、Critical/High 核心发现、最危险的攻击链与最易触发的数据损坏 Bug、未覆盖盲区、发版建议）。
11. `repro/`：存放所有纯本地、零外部副作用的自动化复现测试与合成测试数据。

---

## 6. 立即启动的五项高优突破口（Phase 1 完成后最先验证）

在完成环境隔离确认与资产盘点后，请率先深入代码并编写测试验证以下 5 个高风险交叉点：

1. **Android 本地加密迁移与异常恢复原子性（`src/utils/secureStore.ts` + `scripts/HrtLockBridge.kt`）**：
   - 核查升级迁移、生物识别锁开关、KeyStore 瞬时报错与真正无密钥的区分逻辑，验证是否存在任何路径会导致旧版明文记录或加密记录被静默清空或被空状态覆盖同步到云端。
2. **多端增量同步冲突与软删除边界（`src/hooks/useCoreSync.ts` + `src/utils/syncMerge.ts` + `server/src/records.ts`）**：
   - 验证版本游标（cursor）推进时机、批量上传部分失败、离线编辑与云端删除冲突、切换账号时的本地残留是否会造成跨账号串数据或记录丢失。
3. **PK 药代动力学引擎与 4 种校准器的极端输入鲁棒性（`logic.ts` + `src/pk/`）**：
   - 针对 MIPD / EKF / OU-Kalman 构造边界化验单与用药序列（零间隔、乱序贴片摘除、极端异常化验值、单位换算边界），验证是否会产生 `NaN`/`Infinity` 或阻塞主线程渲染。
4. **出站请求防护的 DNS Rebinding / TOCTOU 缺口（`server/src/urlGuard.ts` + `avatars.ts`）**：
   - 核实源码中“只检查字面域名、未将解析后的 IP 固定到实际 Socket 连接”的真实可达路径，用本地 Mock 复现并评估实际危害。
5. **Tauri 2 权限能力、Kotlin `@JavascriptInterface` 与 MCP `hrt_` Token 的权限边界**：
   - 交叉核对 `src-tauri/capabilities/default.json`、Kotlin 桥导出方法与服务端 `hrt_` Token 在密码修改/会话注销/删除账号时的完整生命周期闭环。

现在，请严格遵守第 0 节生产只读红线，从 **阶段 0（创建 `security-audit/PROGRESS.md`）与阶段 1（基线冻结、读取本地 `doc`/`docs` 下的 OWASP ASVS 5.0 与 MASVS 目录索引、核对文档与代码漂移）** 开始执行。