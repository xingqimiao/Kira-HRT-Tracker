# F-Droid 上架准备清单

> 状态：**物料已备好，未提交**。提交动作为在 `gitlab.com/fdroid/fdroiddata` 开一个
> MR，新增 `metadata/org.kiramyao.hrt.yml`（草稿见同目录）。等确认后再发。

## 1. 已经做了什么

| 项 | 位置 | 说明 |
|:--|:--|:--|
| 移除 FCM | `scripts/strip-fcm.mjs` | app 模块、manifest、Tauri notifications 插件的 Firebase 依赖与服务全部剥掉；dex 里 `com/google/firebase` 引用为 0 |
| 移除自更新 | `VITE_NO_SELF_UPDATE=1` | `checkNativeUpdate` 直接返回空；更新清单 URL 被常量折叠掉；设置里的「检查更新」入口不再渲染 |
| 强制成对 | `scripts/strip-fcm.mjs` | 只设了 `HRT_NO_FCM` 而没设 `VITE_NO_SELF_UPDATE` 时构建直接失败，防止再产出一个不合格包 |
| 渠道资产剔除 | `scripts/strip-store-assets.mjs` | 商店包里不再内嵌 `android/latest.json`、Firebase worker 与其 compat SDK |
| 商店文案 | `fastlane/metadata/android/{en-US,zh-CN}/` | 标题、短描述、完整描述、2000003 更新日志 |
| 图标 | 同上 `images/icon.png` | 512×512，取自 `src-tauri/icons/icon.png` |
| 截图 | 同上 `images/phoneScreenshots/` | 由 AVD 实拍 |
| 构建配方草稿 | `docs/fdroid/org.kiramyao.hrt.yml` | `Builds:` 段需要和 F-Droid 一起打磨 |

## 2. 提交前必须确认的（真正的阻碍）

1. **`src-tauri/gen/` 由 Tauri 生成**（仓库里只有壳源码，`gen/` 与构建产物不入库）。
   配方里需要跑 `tauri android init` 之后再构建。
2. **构建服务器要能跑 Rust + Node + Android NDK**。这是 Tauri 应用进 F-Droid 的主要成本；
   `Builds:` 里的 Rust/NDK 版本必须和出包时一致，crates 需要 `cargo vendor` 离线化。
3. **仓库必须是公开可匿名克隆的**（现在 `xingqimiao/Kira-HRT-Tracker` 满足）。
4. **需要一个带版本号的 tag**，且 tag 指向的提交能构建出当前这个包（`v2.0.3`）。
5. **反特性声明**：应用提供可选的 Google / X 登录，二者都是非自由网络服务。
   在 MR 里主动说明「不登录也能完整使用」，由 F-Droid 判定是否记 `NonFreeNet`。

## 3. 提交时用到的信息

- 包名：`com.kiramyao.hrt`
- 版本：`2.0.2-fdroid` / versionCode `2000002`（同一份 2.0.2 代码，只加后缀）
- 许可证：MIT（`LICENSE`）
- 网站：<https://hrt.kiramyao.com>
- 源码：<https://github.com/xingqimiao/Kira-HRT-Tracker>
- 商店包 sha256：`C2DC2F7417D997B0A03ADA557C33D32935296DF26D28F829B0FCBB5DDD29EA87`（arm64-v8a，14 MB）

## 4. 截图规格

F-Droid 要求至少 2 张手机截图，纵向 9:16 到 16:9 之间，最短边 ≥ 320px。
本目录下的 `phoneScreenshots/` 就是从 1080×2400 的 AVD 直接截的，满足要求。

## 5. 提交之后

- 首轮通常会被要求补 `Builds:` 细节或修构建失败；回复在 MR 里即可。
- 上架后本仓库的 GitHub Release **不再附带 fdroid 包**，商店负责更新。
- 应用内的自更新入口在该构建里不存在，这是刻意的。
