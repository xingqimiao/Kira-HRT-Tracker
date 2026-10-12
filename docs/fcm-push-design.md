# Android 推送设计：本地排程为主，FCM 补推为辅

状态：**服务端 + 客户端已实现**（`server/src/push.ts`、`server/test/push.test.ts`、
`src/utils/pushRegister.ts`、`scripts/HrtMessagingService.kt`）。唯一未落地的是把
服务账号凭据放上生产机（见文末），以及一个 APK 构建发布。

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

### 3. 客户端（Web 侧）
- 原生"启用通知"授权后获取 FCM token，`POST /api/push/register` 绑定当前账号。
- 退出登录 / 关闭提醒时注销 token。

## 阻塞

**缺服务端发送凭据**：`google-services.json` 只是客户端配置，能拿 token 但**不能发送**。发送需要**服务账号私钥** JSON（Firebase 控制台 → 项目设置 → 服务账号 → 生成新的私钥，文件含 `"type": "service_account"`）。拿到后放在服务器上（建议走现有的 systemd 凭据 / KMS 机制，不落明文），发送器才能工作。
