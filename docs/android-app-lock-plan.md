# Plan — Android 生物特征应用锁（记录密钥 + 时钟伪装）

- **状态**：P0–P5 已实现，2026-10-21 在 Android 15 模拟器（API 35，x86_64）完成核心场景验证；通知锁屏/FCM 路径待验证
- **前置闸门**：2.0（当前 `rewrite` 分支）完成并稳定后再动工；不得混入 1.2.x 维护版
- **影响面**：Android 原生壳 + Web 启动流程 + 设置页；**服务端零改动**
- **日期**：2026-10-21

---

## 1. 目标

让「解密记录的密钥 K」在冷启动时只能通过系统生物识别取出。没有通过生物校验，就永远拿不到 K，从而打不开任何用药 / 化验 / 日志记录。

开启后：

1. 冷启动先完整播放现有开屏动画。
2. 动画结束后显示解锁页，唤起系统 `BiometricPrompt`。
3. 通过 → 取回 K → 进入应用。
4. 连续失败达到阈值（或系统返回 lockout）→ 整个应用变成一个**时钟界面**：沿用应用自己的 M3E 排版与令牌，与系统时间同步，但不含 logo、应用名或任何记录，返回键只能退出应用。
5. 重新打开应用 → 再次进行生物校验；通过则恢复正常，失败则继续停留在时钟界面。

---

## 2. 验收标准（可测试）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 已开启，冷启动 | 开屏动画完整播放 → 解锁页 → 系统生物弹窗 → 通过后进入，且能看到历史记录 |
| 2 | 已开启，未认证 | WebView 中的业务页面**不挂载**（不是遮罩），记录数据不会被解密到内存 |
| 3 | 读取应用沙箱文件 | `hrt-*` 记录仍是 AES-GCM 密文；找不到明文 K |
| 4 | 连续失败 ≥ 阈值 / 系统 lockout | 立即进入时钟页；无应用名、无图标、无导航；时间与系统一致 |
| 5 | 时钟页按返回 | 退出应用（回桌面），不回到记录页 |
| 6 | 时钟页杀掉重开 | 再次出现生物校验；通过后清除时钟态并进入应用 |
| 7 | 关闭应用锁 | 需先通过一次认证；关闭后恢复旧存储方式，记录可读 |
| 8 | 从 1.2.3 升级且已开启 | 旧记录无需重新加密即可读取（K 不变，只换包裹层） |
| 9 | Web / PWA | 完全无感知，功能入口隐藏 |
| 10 | 云端同步 | 解锁后同步、导出、分享均与现在一致 |
| 11 | 设备锁屏收到提醒 | 只显示通用文案（FCM 精确为「有一条提醒」；本地提醒为系统默认遮罩），解锁手机后在通知栏显示完整内容 |
| 12 | 后台锁开关 | 关：切后台再回来不打断；开：`onStop` 超过 5 秒回前台要求认证 |
| 13 | 后台锁 + 外部流程 | OAuth 授权、选图/选文件、跳系统设置回来不弹锁 |
| 14 | 本地存储全量 | 除 5 个 boot 键外，所有 `localStorage` 值都是 AES-GCM 密文；check 脚本零违规 |
| 15 | 重置入口 | 解锁页底部独立 `.btn.danger-wide`「重置」；打开面板后需二次确认才会擦除 |
| 16 | 未录入生物识别 | 设置项不置灰且有行内提示；点击弹出说明与「去系统设置录入」；返回后自动继续开启；仍未录入则再次提醒并保持关闭 |
| 17 | 无强生物硬件 / 仅弱生物 / 仅 PIN | 不可开启；点击必须弹出明确原因，不能静默失败；不创建 B、不改 K、不置位 |

---

## 3. 现状（已核实）

- 手机版是 **Tauri 2 Android 壳**。2026-10-21 已按 `AGENTS.md §4` 重建：`src-tauri/`（Tauri 2.12.4 / tauri-build 2.7.3）、`scripts/patch-android-theme.mjs` 恢复并在 `build:android` 中调用，`MainActivity.kt` / `HrtMessagingService.kt` / `HrtLockBridge.kt` 为 canonical 副本。
- `src/utils/secureStore.ts` 用 `tauri-plugin-secure-storage-api` 保存一个 32 字节随机密钥 K（`hrt-local-data-key`）。
- 插件原生实现（`SecureStoragePlugin.kt`）确实使用 `AndroidKeyStore` + `AES/GCM/NoPadding`，但它的 Keystore 密钥**没有** `setUserAuthenticationRequired`：拿到应用沙箱即可在无需认证的情况下解出 K。
- K 在 WebView 内用于 AES-GCM 加密这些 `localStorage` 键：
  `events`、`lab-results`、`dose-templates`、`quick-doses`、`journal`、`deletions`、`hrt-med-reminders`。
- `index.tsx` 在 `createRoot` 之前 `await initSecureStore()`；`App` 的 `useAppData` 在挂载时同步读取这些键。
- 开屏动画是 `App` 内部的 overlay，**不是 gate**，应用在动画下方已经挂载。
- 当前**没有任何** biometric / app lock 代码。
- 通知有两条独立路径：Web 侧 `medPlanNotify`（Tauri 通知插件排程）与原生 `HrtMessagingService`（FCM 补推）。

---

## 4. 密钥层级（核心设计）

```
AndroidKeyStore
└── B  (AES, 不可导出, 绑定 BIOMETRIC_STRONG, 每次使用都要求认证)
     └── 包裹 K  →  SharedPreferences "hrt-lock" 中的密文 envelope
                    K = 32 字节随机密钥（不变）
                    └── WebView 内 AES-GCM 解密 localStorage 记录
```

- **K 不变**：记录文件不需要重新加密，迁移只更换 K 的包裹层。
- **B 不可导出**且要求生物认证；没有成功认证，`Cipher.init` 抛 `UserNotAuthenticatedException`，拿不到 K。
- 开启锁后，必须**删除**旧插件里的 `hrt-local-data-key` 条目，否则锁可被绕过。
- 已知边界（要写进隐私说明）：解锁后 K 存在于 WebView 内存，直到进程结束。本方案保证的是「冷启动 / 进程重启后无认证拿不到 K」，不是运行期防注入。若要彻底不让 K 进入 JS，需要把记录存储整体搬到原生，属于另一个量级的重构，不在本计划内。

### 4.1 Keystore 参数

```kotlin
KeyGenParameterSpec.Builder(alias, PURPOSE_ENCRYPT or PURPOSE_DECRYPT)
    .setBlockModes(BLOCK_MODE_GCM)
    .setEncryptionPaddings(ENCRYPTION_PADDING_NONE)
    .apply {
        if (Build.VERSION.SDK_INT >= 30) {
            setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG) // 每次使用都认证
        } else {
            @Suppress("DEPRECATION")
            setUserAuthenticationValidityDurationSeconds(0)          // API < 30 等价路径
        }
        setInvalidatedByBiometricEnrollment(false)                    // 见 §8.3
    }
    .build()
```

- **只允许 `BIOMETRIC_STRONG`，不提供设备 PIN 回退**（符合「只能生物」的要求）。
- `androidx.biometric:biometric:1.1.0`（`TauriActivity` 继承自 `AppCompatActivity`，可直接使用 `BiometricPrompt`）。
- 清单需加入 `USE_BIOMETRIC`（normal 权限）。
- API 23–29 走 `setUserAuthenticationValidityDurationSeconds(0)` 的兼容分支；实现时必须真机覆盖低版本。

---

## 5. 状态机

```
                ┌──────────── 锁未开启 ────────────┐
                │                                  │
  cold start ──►│  splash ──► App（现状）           │
                │                                  │
                └──────────────────────────────────┘

  cold start（锁已开启）
        │
        ▼
   splash（完整播放，不挂载 App）
        │ onFillDone + HOLD_MS
        ▼
   UnlockScreen ──► BiometricPrompt
        │                 │
        │ 成功            │ 失败 / 取消
        ▼                 ▼
   K 导入 Web Crypto    failure++ ──► 未达 lockout/阈值 ? 重试解锁页
        │                              达到 lockout / 兜底 5 次
        ▼                                     │
   mount <App/>                               ▼
        │                              AppClockScreen（React，M3E）
        │                                     │ 返回键 → 原生退出应用
        │                                     │ 重新打开 → 再次认证
        └─────────────────────────────────────┘
```

- **时钟态是进程级的**，不持久化：杀掉重开 = 重新获得一次认证机会（符合「除非重新打开然后通过生物校验」）。
- 应用在后台被系统回收再恢复，同样回到认证流程。
- 未解锁时**不挂载 `App`**，否则 `useAppData` 会以空数据初始化，并且 Web 侧定时器、同步、通知排程会提前启动。
- **后台回前台是否重新锁由用户决定**：设置里提供独立开关（默认关闭 = 只在冷启动时锁），见 §5.1。

### 5.1 后台重锁开关（用户可选）

| 开关 | 行为 |
|---|---|
| 关（默认） | 只有冷启动 / 进程重启才要求生物认证；切到后台再回来不打断 |
| 开 | `onStop` 后进入未认证态，回前台显示 `UnlockScreen` 并要求认证 |

- 判定用 `onStop` 而不是 `onPause`：通知权限弹窗、相册选择器、系统设置等会触发 `onPause`，用 `onPause` 会把人锁在门外。
- **明确豁免的外部流程**（这些流程离开应用是预期行为，回来不锁）：

| 流程 | 处理 |
|---|---|
| OAuth 登录 / 授权（X、Google） | 不锁；回调经 `kira-hrt://oauth/callback` 返回后结束豁免 |
| 选择图片 / 文件 / 拍照（OCR、导入） | 不锁；原生 `onShowFileChooser` 自动进入豁免 |
| 跳系统设置（通知权限、安装未知应用） | 不锁 |
| 用户自己回桌面 / 切到其它应用 | 按开关执行，5 秒后锁 |

- 实现：原生维护一个 `externalFlowDepth`，以上流程开始时 +1，返回结果或 `onResume` 后清零；`onStop` 时 `depth > 0` 不锁。
- 兜底：未知来源的离开仍按 **5 秒宽限期**；超过 5 秒才锁。另设 3 分钟硬上限，防止豁免状态被长期挂住。
- 重锁只覆盖界面并要求重新认证，**不重载 WebView、不重建 React 树**：否则会丢掉 OCR 流程、滚动位置和未提交表单。已在内存里的记录数据属于「解锁后可见」的既有边界（§4）。
- 5 秒宽限期内不触发，进程若在此间被杀，下次仍是冷启动流程。
- 后台重锁同样走失败计数：连续失败到阈值也进入时钟页。此路径下 `App` 已挂载，时钟只是替换界面，内存中仍有已解密数据——与「解锁后数据在内存」的既有边界一致，不额外承诺清空。

---

## 6. 交互时序

1. `index.tsx` 读取一个**同步可读**的开关：`localStorage['app-lock'] === '1'`（与原生 `SharedPreferences("hrt-lock").getBoolean("enabled")` 双写；清数据时两者一起消失）。
2. 未开启 → 完全走现有路径。
3. 已开启 → 先渲染一个极小的 bootstrap root：只挂 `<SplashScreen mode={…}/>`；`mode` 从 `localStorage['hrt-mode']` 同步读取。
4. `SplashScreen.onDone` 后渲染 `<UnlockScreen/>`，同时调用 `window.HrtLock.authenticate()`。
5. 原生弹 `BiometricPrompt`：
   - 成功 → 解密 envelope → 通过 `evaluateJavascript` 派发 `hrt-lock-result`（携带 K 的 base64）。
   - 失败/取消 → 计数并回传错误码。
6. JS 收到 K 后调用 `initSecureStore(k)` 的注入分支，再 `createRoot(...).render(<App/>)`。
7. 达到阈值时原生派发 `hrt-lock-result { error: 'lockout' }`，JS 切换到 `AppClockScreen`，并调用现有 `HrtBack.setCanPop(false)`，让系统返回直接退出应用。
8. 解锁成功后派发 `hrt-lock-state = unlocked`，随后按正常启动流程挂载 `App`（同步、提醒排程由现有逻辑接管）。

### 6.1 时钟伪装（要求：沿用应用自己的 M3E 设计语言）

**实现位置**：React（`AppClockScreen`），与 Splash / Unlock 同属 bootstrap 层，可复用 `m3e.css` 的令牌与字体栈。原生只负责触发和返回键，不单独画一套 View——照抄一遍令牌迟早会和应用本体走样。

> 伪装界面不是安全边界，K 才是。即使有人绕过 React 看到这个页面，未认证也拿不到任何记录。

**版式**（沿用 M3E 的 display 型排版：大字号、负字距、圆润留白）

```
┌─────────────────────────────┐
│                             │
│                             │
│          23:47              │   ← 92–104px / 800 / letter-spacing -3px
│                      18     │   ← 24px / 700 / 基线对齐
│                             │
│       10 月 21 日 星期二      │   ← 15px / 600 / var(--var) / 字距 0.5px
│                             │
│                             │
└─────────────────────────────┘
```

- 背景：`var(--bg)`，中间叠一层由 `var(--sc)` 到透明的柔和径向渐变（约 40% 不透明度），避免平铺死板。
- 时间：`var(--on)`，`font-family: var(--font-display)`，`font-variant-numeric: tabular-nums`，字距 `-3px`。
- 秒数与日期：`var(--var)`；日期格式跟随系统 Locale，24/12 小时制跟随系统设置。
- 允许的装饰：一条 1px、宽 56px、`var(--out)` 25% 不透明度的短分隔线（圆角 1px）；不加 logo、不加应用名、不加主色按钮。
- 时间源：每秒读取 `new Date()`，不做自维护偏移；系统改时间立即跟随。秒数变化只做 120ms 透明度过渡，不做位移/弹跳。
- 动效遵循 `prefers-reduced-motion`。
- 返回键：时钟态调用 `HrtBack.setCanPop(false)`，现有 `OnBackPressedCallback` 保持禁用，系统返回直接结束 Activity，不进入 Web 返回栈。
- 时钟页与解锁页都设置 `FLAG_SECURE`，避免最近任务缩略图泄露。
- 重新获得认证机会：任务被切到后台后再从启动器进入时，`onNewIntent`/`onResume` 触发一次生物认证；失败则继续停在时钟。为兼容启动器复用任务，Activity 使用 `singleTask` 并在 `onNewIntent` 里处理。

---

## 7. 原生接口（JS ↔ Kotlin）

沿用仓库现有的 `@JavascriptInterface` 桥风格（`HrtBack` / `HrtNotif` / `HrtPush`），新增 `HrtLock`：

| 方法 | 方向 | 说明 |
|---|---|---|
| `isEnabled(): Boolean` | JS → Kotlin | 同步查询 |
| `enable(callbackId)` | JS → Kotlin | 先认证 → 创建 B → 包裹 K → 删除旧条目 → 置标志 |
| `disable(callbackId)` | JS → Kotlin | 先认证 → 还原 K 到旧存储 → 删除 envelope / B → 清标志 |
| `authenticate(callbackId)` | JS → Kotlin | 弹生物识别；结果事件携带 `{ ok, key?, error? }` |
| `lockNow()` | JS → Kotlin | 立即进入未认证态 |
| `setBackgroundLock(enabled)` | JS → Kotlin | 写入原生 pref；`onStop` 判定用 |

异步结果统一通过 `window.dispatchEvent(new CustomEvent('hrt-lock-result', { detail }))` 回传（与 `hrt-back`、`hrt-oauth-callback` 一致）。

> 备选：做成正式 Tauri 插件（Rust + Kotlin）。本计划推荐先用桥，等 2.0 之后原生壳稳定再决定是否插件化；桥方案不新增 Rust 依赖，改动面更小。

### 7.1 为什么不用现有 secure-storage 插件

它的 Keystore 密钥固定为「无认证要求」，JS 侧 `access` 参数在 Android 上被忽略。要支持认证绑定只能改上游源码；按仓库约定不改 vendored 上游文件，因此新建独立实现。

---

## 8. 迁移与兼容

### 8.1 首次开启

**硬规则：没有录入强生物特征，不能开启。**

原因不是产品保守：开启的实质是把 K 换成一个「必须生物认证才能解」的包裹。如果设备上没有任何可用的强生物认证，这一步做完就等于把本地数据锁死。因此「至少已录入一个 `BIOMETRIC_STRONG`」和「开启前成功认证过一次」是两个前置条件。

#### 8.1.1 预检（`BiometricManager.canAuthenticate(BIOMETRIC_STRONG)`）

| 返回值 | 设置页表现 | 点击开关时 |
|---|---|---|
| `BIOMETRIC_SUCCESS` | 可开启 | 走 §8.1.2 的正常流程 |
| `BIOMETRIC_ERROR_NONE_ENROLLED`（有硬件、没录入） | **不置灰**，行内提示「需要先录入指纹或面容」 | **弹出说明面板**（不能静默返回）：说明「应用锁需要指纹或面容，当前设备尚未录入」；主按钮「去系统设置录入」，次按钮「取消」 |
| `BIOMETRIC_ERROR_NO_HARDWARE` | 置灰并写明「此设备不支持生物识别」 | 点击整行也弹出同一说明，明确告知无法开启 |
| `BIOMETRIC_ERROR_HW_UNAVAILABLE` | 置灰，注明「暂时不可用」 | 弹提示「生物识别暂时不可用，请稍后重试」；不做任何写入 |
| 只有弱生物特征 / 只有 PIN | 置灰，写明「需要指纹或面容（不支持设备 PIN）」 | 弹说明，明确告诉用户为什么不能开启 |

关键：**任何不可开启的情况都必须有明确提示，不能只给一个灰色死开关、更不能点了没反应**。`NONE_ENROLLED` 是最常见的情况，必须能一键跳到系统录入页；从系统设置返回后（`onResume`）重新预检：

- 已录入 → 自动继续 `§8.1.2` 的开启流程（直接弹认证）。
- 仍未录入 → **再次提醒**「仍未检测到生物识别，应用锁未开启」，保持关闭。

补充判定：`canAuthenticate(BIOMETRIC_STRONG)` 返回 `NONE_ENROLLED` 时，再查一次 `BIOMETRIC_WEAK` 来区分文案——`WEAK` 为 `SUCCESS` 说明设备只录入了弱生物（部分 OEM 人脸），提示「应用锁只支持强生物识别，请改用指纹或重新录入」；两者都不是 `SUCCESS` 才是「尚未录入」。

设备 PIN / 图案不作为回退，这是「只能生物」这条需求的直接结果，文案要把这一点说清楚，避免用户以为是 Bug。

#### 8.1.2 开启步骤（顺序即安全）

1. `canAuthenticate == SUCCESS` 后，弹一次认证。**认证失败或取消 → 整个开启流程终止，什么都不写。**
2. 在认证回调里创建 auth-bound 的 Keystore 密钥 B，并用它加密 K 的 base64 → 写入 `hrt-lock.envelope`。
3. **同一次原生事务**里写 `enabled=true`（原生 pref 用 `commit()`，同步落盘）→ 再同步写 `localStorage['app-lock']='1'`。
4. 确认第 3 步成功后，才删除 secure-storage 里的 `tauri-storage_hrt-local-data-key`。
5. 任一步失败：回滚——删 envelope、保留旧 K、`enabled` 保持 false。

#### 8.1.3 崩溃安全

- 删除旧 K 之前不能出现「标志已置位但旧 K 还在」以外的中间态。
- 启动恢复规则：
  - `enabled=true` 且旧 K 仍存在 → 补删旧 K（锁已经生效，旧条目属于泄漏面）。
  - `enabled=false` 且 envelope 存在 → 删除 envelope（回滚），继续用旧 K，应用正常启动。
- 绝不出现「envelope 存在、旧 K 已删、`enabled=false`」——这会让应用无锁启动却拿不到 K。上面的写入顺序就是为排除它。

### 8.2 关闭

1. 必须先认证拿到 K。
2. 写回 secure-storage（旧机制）。
3. 校验写回成功后删除 envelope、Keystore 别名 B、`enabled` 标志。

### 8.3 密钥失效

- `setInvalidatedByBiometricEnrollment(false)`：新增指纹/人脸不会作废 B，避免用户录入新指纹后**永久打不开本地数据**。代价是「拿到已解锁手机并能录入生物特征的人」也能解 B；在应用锁的威胁模型内可接受。
- 若用户把系统里的生物特征**全部删除**：B 仍要求认证但系统无可用认证 → 本地数据暂时不可解。
  - 大多数情况重新录入生物特征即可恢复，不需要重置。
  - 只有 Keystore 被清、从备份恢复、OEM 异常等永久失效场景才需要重置。
- 不提供密码/PIN 回退（按需求）。
- Android Auto Backup 会把加密后的 `localStorage` 备份走，但 Keystore 密钥不会。建议 `allowBackup=false`（或在 `dataExtractionRules` 中排除 WebView 数据与 `hrt-lock`），避免恢复出一堆永远解不开的密文。

**「重置」按钮（解锁页底部，独立长条）**

不是文字链接，而是解锁页最底部一条独立的 M3E 危险操作按钮：

```
┌──────────────────────────────────┐
│          （生物识别提示）           │
│                                  │
│                                  │
│                                  │
│  ┌────────────────────────────┐  │
│  │  ↺   重置                   │  │  ← .btn.danger-wide
│  └────────────────────────────┘  │     100% × 54 / 圆角 27
└──────────────────────────────────┘
```

- 位置：解锁页底部安全区内，左右各 16px，单独占一行，与上方内容至少 24px 间距。
- 样式：复用既有 `.btn.danger-wide`（`m3e.css:179`），不新造样式——宽 100%、高 54、圆角 27、背景 `--errc`、文字与图标 `--err`、左对齐内边距 20、图标 22（`RotateCcw`）、字号 15/700。
- 文案：按钮上只有「重置」；作用域写在点击后的面板里，避免误解为「重置设置」。
- 点击后打开 `AdaptiveSheet`（移动端底部抽屉 / 桌面居中模态），内容：
  1. 一句后果说明：会销毁本机密钥与尚未同步的记录。
  2. `SegmentedList` 两项：**重新录入生物识别**（跳系统设置）、**重置本地数据并重新登录**（危险项）。
  3. 危险项二次确认：按钮改为「确认重置」并明确列出会删除的内容；采用二次点击而不是长按（长按对无障碍不友好）。
- 无障碍：54dp 已超过 48dp 最小触控目标；`aria-label="重置本地数据"`；危险语义不只靠颜色传达。

重置的代价：

- 只存在于本机、尚未同步的记录会丢失；已同步的记录不受影响。
- 必须二次确认（第一次说明后果，第二次确认执行），并建议在联网时操作。
- 重置后 K 重新生成，云端记录会以新 K 重新落盘。

### 8.4 加密范围：整个数据包（已定）

**默认策略**：本地所有用户数据与凭据都走 K；只有「解锁前必须同步读取」的极少数键保持明文。

**明文白名单（boot shell，5 个）**

| 键 | 为什么必须明文 |
|---|---|
| `app-theme` | `applyStoredTheme()` 在首帧前同步读取，splash / 解锁页 / 时钟页都依赖它 |
| `app-key-color` | 同一个函数在解锁前读取 `key-blue`，否则蓝色用户会先看到粉色强调色 |
| `hrt-lang` | 解锁页与时钟页的文案在 K 到手前就要渲染 |
| `hrt-mode` | `SplashScreen` 的血量瓶形态要它 |
| `app-lock` | 决定启动走不走解锁流程，必须在 K 之前可读 |

**其余全部加密**（`secureStore`）：

- 记录：`events`、`lab-results`、`dose-templates`、`quick-doses`、`journal`、`deletions`
- 提醒与方案：`hrt-med-reminders`、`hrt-med-plan`、`hrt-med-plan-at`、`hrt-med-plan-notification-ids`、`hrt-med-plan-notified-v1`、迁移标记
- 凭据：`hrt_core_token`、`hrt_core_user`、`hrt_core_keep`
- 其它用户数据：`hrt-start`、`app-gel-products`、`hrt-fcm-token` / `hrt-push-token`、`hrt-milestone`、`hrt-grid`、`hrt-engine-glyph`
- 设置：`app-chart-style`、`app-reading-decimals`、`app-hide-aa`、`app-timezone`、`app-auto-backup`

**实现要求**

1. 把现有直接 `localStorage.getItem/setItem` 的模块逐个改为走 `secureStore`（`useCoreSession`、`medPlan`、`medPlanNotify`、`hrtStart`、`gelProducts`、`pushRegister`、`hrtMilestone` 等）。
2. `secureStore` 的判定从「记录键正则」改为**白名单外一律加密**；新增键默认受保护，忘记加白名单只会导致「解锁前读不到」，不会泄漏。
3. 新增一个 check 脚本（`scripts/check-local-storage.mjs`）扫描 `src/`：除 5 个白名单键外，不允许出现裸 `localStorage` 读写，防止回潮。
4. 原生侧不受影响：`HrtMessagingService` 只读服务端下发字段与自身的 `hrt-push` pref，不读 WebView 存储。
5. 同步、导出、分享都发生在解锁之后，行为不变。
6. **异步写入窗口**：`secureStore.set()` 先写内存、再异步落密文。全量加密后，登录成功等关键节点要 `await flush()` 再继续，避免刚拿到 token 就被杀进程导致下次掉线；普通记录写入沿用现状。
7. **升级迁移**：首次启动时 `initSecureStore` 已会把「明文且属于加密集合」的旧值就地重写为密文，扩大集合后自动覆盖 token / 方案 / 提醒等存量键，无需额外脚本。

---

## 9. 失败计数与防暴力

| 事件 | 计数 | 动作 |
|---|---|---|
| `onAuthenticationFailed`（单次指纹不匹配） | +1 | 停留在解锁页，系统允许继续 |
| `ERROR_USER_CANCELED` / `ERROR_NEGATIVE_BUTTON` | +1 | 回到解锁页，可重新发起 |
| `ERROR_LOCKOUT` / `ERROR_LOCKOUT_PERMANENT`（系统自身已判定尝试过多） | 直接触发 | 进入时钟页 |
| 连续失败达到 **5** 次且系统仍未报 lockout | 兜底触发 | 进入时钟页 |
| 认证成功 | 清零 | 进入应用 |

- **以系统 lockout 为主判据**：Android 自身在多次失败后返回 `ERROR_LOCKOUT` / `ERROR_LOCKOUT_PERMANENT`，正常情况下轮不到我们的计数。5 次只是某些 OEM 不返回 lockout 时的兜底，不是主要规则。
- 计数**进程内**；冷启动清零（符合「重新打开再试」的交互）。
- 额外：持久化记录跨启动的失败次数，超过 10 次时给下一次启动加 1s→2s→4s 的递增延迟，降低自动化试探；不做账号锁定（避免把自己锁死）。

---

## 10. 通知（已定：不做隐藏）

**应用锁与时钟页都不处理通知**：FCM 补推与本地提醒照常发出、照常展示，不因为进入时钟伪装而延迟、取消或脱敏。时钟页被通知戳破是可接受的行为。

唯一要做的，是**设备锁屏**上的内容遮罩（与 App 锁无关，是系统通知隐私）：

| 场景 | 期望 |
|---|---|
| 手机锁屏（未解锁设备） | 只显示通用提示「有一条提醒」，不显示药名、剂量、化验信息 |
| 解锁手机后（通知栏） | 完整标题与正文 |

实现方式：

1. **统一设 `Visibility.Private`**。`@choochmeque/tauri-plugin-notifications-api` 的通知默认已是 `VISIBILITY_PRIVATE`，但要在 `createChannel` 时显式设置 `lockscreenVisibility`，避免渠道覆盖。
2. **FCM 路径（`HrtMessagingService.show()`，我们自有代码）**：加 `.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)` + `.setPublicVersion(publicNotification)`，public 版本只放一条本地化文案「有一条提醒」。
3. **本地提醒路径（Tauri 通知插件排程）**：插件只暴露 `visibility`，**不支持** `setPublicVersion`。未提供 public 版本时，系统锁屏显示的是系统级遮蔽文案（AOSP 为「内容已隐藏」，部分 OEM 为「1 条通知」），不是我们指定的「有一条提醒」。
   - **推荐**：先接受系统默认文案，真机确认观感；FCM 路径保持精确文案。
   - 若必须两条路径文案完全一致：把本地提醒的排程改为自有原生桥（AlarmManager + BroadcastReceiver + 自有 Builder）。这会重写一个已经稳定运行的核心提醒链路（精确闹钟权限、重启恢复、语言回退都要重做），不建议为了这句文案承担该风险。
4. 应用锁开启前已排入系统的提醒不需要取消；解锁后由 Web 重新排程的逻辑保持现状。

---

## 11. 改动清单

### 11.1 原生（`src-tauri/gen/android/`，通过 patch 脚本落地，不直接改生成物）

| 文件 | 改动 |
|---|---|
| `app/build.gradle.kts` | `androidx.biometric:biometric:1.1.0` |
| `AndroidManifest.xml` | `USE_BIOMETRIC`；（可选）`allowBackup=false` |
| `MainActivity.kt`（canonical: `scripts/MainActivity.kt`） | 注册 `HrtLock` 桥；`onStop` 后台锁判定；`onShowFileChooser` / 外部 Intent 的豁免计数；`singleTask` + `onNewIntent`；`FLAG_SECURE` |
| 新增 `HrtLockBridge.kt`（或并入 MainActivity） | Keystore B、envelope、BiometricPrompt、失败计数 |
| `MainActivity.kt` 返回键 | 时钟态下直接退出，不交给 Web |
| `HrtMessagingService.kt` | 通知加 `VISIBILITY_PRIVATE` + `setPublicVersion("有一条提醒")`；**不做锁态丢弃** |

### 11.2 Web

| 文件 | 改动 |
|---|---|
| `index.tsx` | bootstrap 状态机：splash → unlock → App；不再无条件 `initSecureStore` |
| `src/utils/secureStore.ts` | 支持注入 K；判定改为「boot 白名单外一律加密」（§8.4） |
| `useCoreSession` / `medPlan` / `medPlanNotify` / `hrtStart` / `gelProducts` / `pushRegister` / `hrtMilestone` | 直接 `localStorage` 读写改为走 `secureStore` |
| 新增 `scripts/check-local-storage.mjs` | 禁止白名单外的裸 `localStorage` 读写 |
| 新增 `src/components/AppUnlockScreen.tsx` | M3E 解锁页（不含记录数据）；底部独立 `.btn.danger-wide`「重置」+ 重置确认 `AdaptiveSheet` |
| 新增 `src/components/AppClockScreen.tsx` | M3E 时钟伪装页（§6.1） |
| `src/pages/CoreAccountSettings.tsx` 或 `Settings.tsx` | 「应用锁」主开关 +「进入后台后重新锁定」子开关、状态、不可用提示 |
| `src/utils/medPlanNotify.ts` | `createChannel` 时设置 `lockscreenVisibility: Private`（§10） |
| `src/utils/appLock.ts` | 桥封装、`app-lock` 双写、事件 |
| `src/i18n/langs/*.ts`（7 个） | 新增文案键 |
| 隐私 / 说明文案 | 写清「解锁后密钥在内存中」的边界 |

**新增文案键（7 语言：zh / zh-TW / en / ja / ko / tr / yue）**

- `settings.app_lock.*`：`title`、`desc`、`enable_failed`、`enroll_required_title`、`enroll_required_desc`、`still_missing`、`unavailable.no_hardware`、`unavailable.not_enrolled`、`unavailable.weak_only`、`unavailable.hw_busy`、`enroll_cta`、`enroll_return_hint`
- `lock.*`：`unlock_title`、`unlock_hint`、`auth_failed`、`reset`、`reset_title`、`reset_desc`、`reset_re_enroll`、`reset_wipe`、`reset_confirm`、`reset_confirm_desc`、`reset_done`
- `notif.hidden_line`：设备锁屏通用文案「有一条提醒」
- 时钟页的日期走系统 Locale，不需要文案键

### 11.3 不改

- 服务端、同步协议、PK 引擎、分享链接、Web/PWA 行为。
- 现有 AES-GCM 记录格式（K 不变）。

---

## 12. 测试计划

**JS 单测**
- bootstrap 状态机：未开启直接挂载；已开启必须先 unlock；失败阈值进 clock。
- `secureStore` 注入 K 后能正确解出既有密文；token/user 进入加密集合后读写一致。

**真机 / instrumented（至少覆盖：Pixel Android 14、一台 API 28/29 设备、小米或 OPPO 一台）**
1. 未录入生物特征时无法开启。
2. 开启 → 杀进程 → 冷启动 → splash → 认证 → 进入。
3. 系统报 lockout（或 OEM 不报时连续 5 次失败）→ 时钟页；返回键退出；重开 → 认证通过 → 恢复。
4. 开启后新增一个指纹 → 仍能解锁（`invalidated=false`）。
5. 删除全部生物特征 → 解锁页给出重置出口，不崩溃、不白屏。
6. 从 1.2.3 升级 → 旧记录可读 → 开启锁 → 记录仍可读（K 未被换）。
7. 关闭锁 → 杀进程 → 冷启动不再弹认证。
8. 设备锁屏：FCM 补推显示「有一条提醒」，本地提醒显示系统默认遮罩；解锁手机后两者都显示完整药名与剂量。
9. 后台锁开关：关闭时切到相册/设置再回来不弹认证；打开时离开超过 5 秒回前台弹认证，5 秒内回来不弹。
10. 后台锁 + OAuth：登录 X/Google 授权页再回来不弹锁；回调仍能正常落回应用。
11. 后台锁 + 选图/文件：OCR 选图、数据导入选文件再回来不弹锁。
12. 全量加密：解锁后逐项检查 `localStorage`，白名单外没有明文；`scripts/check-local-storage.mjs` 通过。
13. 重置入口：底部按钮为 100% × 54dp、圆角 27、`--errc` 背景；点击只打开面板，未二次确认前不删除任何键。
14. 重置执行后：本地密文与 K 被清空，回到登录页，登录后云端记录完整恢复。
15. 时钟页排版：沿用应用 M3E 令牌与字体栈，时间等宽不跳字、24/12 小时制跟随系统、深浅色跟随系统；无 logo、无应用名、无记录数据。
16. 会话令牌在未解锁时不可用（登出/重置后重新登录正常）。
17. 全新设备未录入生物识别：点击开关**必须弹出说明面板**（不能无反应）→ 去系统录入 → 返回后自动弹认证 → 开启成功。
18. 引导后未录入就返回：**必须再次提醒**「仍未检测到生物识别」，保持关闭，旧 K 未被改动。
19. 模拟器（无硬件）或只有 PIN：点击开关弹出明确原因；强行调用开启接口被拒绝，`enabled=false`。
20. 开启流程中取消认证：`enabled=false`、envelope 不存在、旧 K 仍可读。

**对抗性**
- `adb shell run-as <pkg> cat shared_prefs/*`：只有密文 envelope，无明文 K。
- 时钟态下旋转、分屏、最近任务缩略图不泄露内容。
- 时钟态下 `adb shell am force-stop` 后重开必须重新认证。

---

## 13. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 生物特征全部移除 / 密钥失效 | 本地记录永久不可解 | `invalidated=false`；明确重置 + 云端恢复出口 |
| 返回 K 给 JS | 解锁后内存可见 | 仅在解锁后持有；不使用时不缓存到 localStorage |
| 低版本 / OEM 生物实现差异 | 部分设备弹窗失败 | API 分支 + 真机矩阵；`canAuthenticate` 预检 |
| 本地提醒锁屏文案 | 插件不支持 public version，只能显示系统默认遮罩，与 FCM 的「有一条提醒」不一致 | 先真机确认观感；确有必要再接管本地排程（§10） |
| 后台重锁打断正常流程 | 选图/授权回来要重新认证 | 5 秒宽限期 + 用 `onStop` 判定 |
| `src-tauri/` 不在工作树、`patch-android-theme.mjs` 已删除 | 原生改动无法落地 | **已解决（2026-10-21）**：壳已重建，patch 脚本恢复并接入 `build:android` |
| 启动时序改动影响 2.0 的 splash 交叉淡入 | 视觉回归 | 未开启锁时保持现有 overlay 结构不变；只对已开启分支走 bootstrap |

---

## 14. 决策记录（已全部拍板）

1. ~~本地提醒在锁屏/时钟态是否隐藏~~ → **不隐藏**，通知照常显示；只做设备锁屏的内容遮罩（§10）。
2. ~~后台回前台是否重锁~~ → **用户开关**，默认关闭；OAuth、选图/文件、系统设置等外部流程豁免（§5.1）。
3. ~~加密范围~~ → **整个数据包**，仅 5 个 boot 键明文（`app-theme`、`app-key-color`、`hrt-lang`、`hrt-mode`、`app-lock`），见 §8.4。
4. ~~失败阈值~~ → **以系统 lockout 为主**；5 次仅作 OEM 不报 lockout 时的兜底（§9）。
5. ~~重置入口位置~~ → **解锁页底部独立 M3E 长条「重置」按钮**；打开 `AdaptiveSheet`，两项（重新录入生物识别 / 重置本地数据并重新登录），危险项二次确认（§8.3）。

---

## 15. 实施顺序（2.0 之后）

> 2026-10-21：P0–P5 已完成代码实现并通过 `tsc` + Android 构建（14 MB APK）。P4 时钟页与返回键随 P2 一并落地；P5 的加密边界已改为「除 5 个 boot 键外全部加密」，`scripts/check-local-storage.mjs` 已接入 `build:android` 与 `postbuild`。通知渠道已设 `Private`，FCM 路径带 `setPublicVersion` 通用文案。
>
> 同日模拟器验证（API 35）：开启/关闭应用锁、冷启动解锁、取消后重试、系统 lockout 进入时钟页、点击时钟重新验证、后台 >5 秒重锁、2 秒内返回不锁、选文件外部流程豁免、重置回 onboarding、1.2.3 → 2.0 升级后旧记录可读且开启锁后仍可读，均通过。安全区在状态栏/手势导航栏内只显示背景。未验证：锁屏通知文案（需要真实排程/FCM）与 OEM 低版本设备。

1. **P0 前置**：重建 `src-tauri/`，恢复原生 patch 落地机制；确认 `TauriActivity` 的 AppCompat 基类与 minSdk。
2. **P1 原生锁服务**：Keystore B、envelope、BiometricPrompt、计数、`HrtLock` 桥。
3. **P2 JS 启动状态机**：splash → unlock → App；`secureStore` 注入与迁移。
4. **P3 设置开关 + 预检引导**：未录入时弹说明并跳系统设置，返回后自动续开；再补 i18n（7 语言）。
5. **P4 时钟伪装**（M3E 版式）与返回键、最近任务保护。
6. **P5 全量本地数据加密 + 锁屏通知遮罩**（§8.4、§10）。
7. **P6 真机矩阵测试 + 升级路径回归**。
8. **P7 版本号、latest.json、签名发布**（沿用 `server/DEPLOY.md` 的 Android 流程）。

> 本文件只是计划。在 2.0 完成前不创建分支、不改原生工程、不动 `MainActivity.kt`。
