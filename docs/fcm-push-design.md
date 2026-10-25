<!-- This file is the earlier design note. The implementation, and the
     implementation-facing details (HTTP v1 sender, dedup claim, the native
     data-only handler, and the web push-in-worker wiring), live in the code:
     server/src/push.ts, server/test/push.test.ts, src/utils/pushRegister.ts,
     scripts/HrtMessagingService.kt, public/firebase-messaging-sw.js. -->
# Android 推送设计：本地排程为主，FCM 补推为辅

> **2026-10-26 更新：** 网页与 APK 的提醒传输是互斥的：网页只在页面可见时每 60 秒检查；APK 用系统排程未来 5 天，页面关闭也响。云端同步到的用药方案现在会在 App 的 `medPlan` 变化时触发原生重排（此前只在启动/聚焦/本地编辑时重排，导致网页新建的方案在手机上不响）。详见 `research/pk-continuation-20261025-2324/review/ui-medplan-notifications.md`。

状态：**服务端 + Android 原生 + Web Push 均已实现**（`server/src/push.ts`、
`server/test/push.test.ts`、`src/utils/pushRegister.ts`、`scripts/HrtMessagingService.kt`、
`public/firebase-messaging-sw.js`）。唯一未落地的是把服务账号凭据放上生产机（见文末），
以及一个 APK 构建发布。

## 目标与分工

一条用药提醒有两个时间点、两个通道，分工如下：

| 场景 | 机制 | 原因 |
|---|---|---|
| 到点提醒（如 13:00） | **本地通知**（Tauri notification 插件） | 不依赖网络，离线也会响 |
| 到点后仍未记录（如 13:30） | **FCM**（服务端判断记录状态后下发） | 只有服务器知道"今天还没记" |
| 另一台设备改了提醒 | FCM + 数据同步 | 通知当前设备刷新 |
| 登录 / 安全事件 | FCM | 服务器掌握事件 |
| 同一件事已提醒过 | **去重** | 避免轰炸 |

**核心原则：本地通知负责"到点"，FCM 只负责"追补"，两者永不在同一时刻对同一件事各响一次。**

## 去重（最高优先级）

一个"应服用的剂量实例"用稳定 key 标识：`planId + 该次的应服时间(epoch ms)`。

1. **服务端**：对每个 (账号, planId, 应服时间) 只补推一次。发送前查询"补推记录"表，已推过即跳过；推过则写入。这样即便扫描任务重跑，也不会重复。
2. **设备端**：收到 FCM 后，**先本地复核**——读 `medPlan` 与今日剂量记录，若这剂此刻已被记录（用户可能刚记下），或本地排程通知已就这个 key 展示过，则**不再展示**。设备维护一个已展示 key 集合（跨进程持久化），防止同一 key 因 token 重投 / 多路径到达而二次弹出。
3. 本地排程通知与 FCM 补推**携带同一个 key**，这样设备能判断"这件事已经由本地通知说过了"。

## 载荷设计：必须用 data-only

Android 的 FCM **通知消息**（`notification` 字段）在 App 后台时**由系统直接展示**，客户端代码不一定被调用——那样就没法做上面的本地复核与去重，`notification` + `data` 混用时系统还会优先展示通知部分。

因此本项目 FCM 一律发 **data-only 消息**（只有 `data`，没有 `notification`）：

```json
{ "message": { "token": "<device token>", "data": {
    "kind": "dose_overdue",
    "planId": "...",
    "dueAt": "1730000000000",
    "alias": "补佳乐", "dose": "2mg"
} } }
```

由 App 自己的 `FirebaseMessagingService.onMessageReceived` 解析、复核、决定是否 `NotificationManager.notify`。原生层处理，**不依赖 WebView**（后台时 WebView 可能未运行）。

## 三处改动范围

### 1. Android 原生（`src-tauri/gen/android/`，多数被 gitignore）
`gen/` 是生成物，改动必须通过 `scripts/patch-android-theme.mjs` 落地（与现有 `MainActivity.kt` 同一手法）：

- `app/build.gradle.kts`：加 `com.google.gms.google-services` 插件与 `firebase-messaging` 依赖；根 `build.gradle.kts` 加 plugin classpath。
- `AndroidManifest.xml`：`POST_NOTIFICATIONS` 权限；`FirebaseMessagingService` 子类注册；默认通知渠道。
- 新增 `HrtMessagingService.kt`（由 patch 脚本写入 `Pkg` 下的固定路径）：`onMessageReceived` → 读本地 plan/剂量复核 → 去重 → 发本地通知；`onNewToken` → 上报。
- `MainActivity.kt`：启动/授权后取 FCM token 并交给 JS（或原生直接上报）。
- `google-services.json` 已放入 `app/`（本地，gitignore）。

### 2. 服务端
- 表 `device_tokens(user_id, token, platform, updated_at, PRIMARY KEY(user_id, token))`。
- 表 `push_log(user_id, plan_id, due_at, sent_at)`（去重的服务端一半）。
- 注册接口：`POST /api/push/register`（携带 FCM token）→ 写入 `device_tokens`；退订同理。
- 发送器：FCM **HTTP v1**（`POST https://fcm.googleapis.com/v1/projects/hrt-kiramyao/messages:send`），用服务账号 OAuth2 取 access token。
- 定时任务：按账号扫描已过宽限窗口、无匹配剂量、且未补推过的剂量实例 → 发 data-only。

### 3. 客户端
- 原生"启用通知"授权后由 Android 桥取 FCM token，`POST /api/push/register` 绑定当前账号。
- 退出登录 / 关闭提醒时注销 token。

### 4. 实现补充：Web Push（原设计只覆盖了 Android）

Web 端也接了 FCM，作为**附加**通道（浏览器没有"本地到点提醒"这一半，所以 App 内每
60 秒的检查仍是 web 的主提醒，FCM 只是补一条服务器判定的补推）。

- **Service Worker**：root 作用域只能有一个 SW，所以 FCM 的后台处理不新起
  `firebase-messaging-sw.js`，而是通过 workbox 的 `importScripts` 注入现有的 `sw.js`；
  处理逻辑在 `public/firebase-messaging-sw.js`，其 firebase compat 依赖在构建期从
  node_modules 拷到 `public/firebase/`（同源，不走 CDN）。
- **VAPID**：web 取 token 需要 VAPID 公钥，由 `VITE_FIREBASE_VAPID_KEY` 提供；未设置时
  web push 静默关闭（不影响其它功能）。
- **不走预缓存**：Firebase/FCM 是懒加载 + 可选的，且 `importScripts` 本就每次按需取，
  所以 `globIgnores` 把它排除出 precache（用 `manualChunks` 命名成 `firebase` 才能按名
  排除），避免给每个访客的首装 +~80KB。
- **载荷**：同一套 data-only；web token 不带 `android.priority`，改用 `webpush` 的 TTL。

### 5. 实现补充：通知语言跟随应用内语言设置

本地到点通知走 JS（`medPlanNotify.ts`），文案由 `t()` 给出，本来就是本地化的。但**在
React 之外绘制的两条路径**——`HrtMessagingService` 收到 FCM 补推时、以及 web 的
`firebase-messaging-sw.js`——曾经各自硬编码一句中文兜底（"用药提醒"），于是没有别名和
剂量的方案在任何语言下都会弹中文。

现在：应用从自己的语言包解析出两个兜底串（`plan.notify_title` / `plan.notify_body`），经
`src/utils/notifLocale.ts` 推给两条路径——原生走 `HrtPush.setNotificationFallbacks(json)`
存进 SharedPreferences，web 走 `postMessage` 存进 Cache API（worker 可能被杀，内存变量会丢，
缓存是唯一durable的槽）。App 在语言变化或语言包加载完成时推送（用解析后的字符串做去重键，
因为冷启动时目标语言包可能还没下载完，第一次渲染 `t()` 会答复中文兜底）。**用户的方案别名与
剂量仍然优先**，只有它们为空时才用本地化兜底。

## 阻塞

**缺服务端发送凭据**：`google-services.json` 只是客户端配置，能拿 token 但**不能发送**。发送需要**服务账号私钥** JSON（Firebase 控制台 → 项目设置 → 服务账号 → 生成新的私钥，文件含 `"type": "service_account"`）。拿到后放在服务器上（建议走现有的 systemd 凭据 / KMS 机制，不落明文），发送器才能工作。
