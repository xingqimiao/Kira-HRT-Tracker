# F-Droid 上架准备清单

> 状态：**物料已齐，MR 未开**。剩下的一步只能在 GitLab 上完成：把同目录的
> `org.kiramyao.hrt.yml` 放进 `fdroiddata/metadata/`，开 MR（§6 有现成的正文）。
> 本机没有 GitLab 凭据，所以这一步需要你自己点。

## 1. 已经做了什么

| 项 | 位置 | 说明 |
|:--|:--|:--|
| 移除 FCM | `scripts/strip-fcm.mjs` | app 模块、manifest、Tauri notifications 插件的 Firebase 依赖与服务全部剥掉；dex 里 `com/google/firebase` 引用为 0 |
| 移除自更新 | `VITE_NO_SELF_UPDATE=1` | `checkNativeUpdate` 直接返回空；更新清单 URL 被常量折叠掉；设置里的「检查更新」入口不再渲染 |
| 强制成对 | `scripts/strip-fcm.mjs` | 只设了 `HRT_NO_FCM` 而没设 `VITE_NO_SELF_UPDATE` 时构建直接失败，防止再产出一个不合格包 |
| 渠道资产剔除 | `scripts/strip-store-assets.mjs` | 商店包里不再内嵌 `android/latest.json`、Firebase worker 与其 compat SDK；网站专属的 `about/`、`brand/` 也不再进包 |
| 商店文案 | `fastlane/metadata/android/{en-US,zh-CN}/` | 标题、短描述、完整描述、`2000004.txt` 更新日志，许可说明已改为 GPL-3.0 |
| 图标 | 同上 `images/icon.png` | 512×512，取自 `src-tauri/icons/icon.png` |
| 截图 | 同上 `images/phoneScreenshots/` | 与介绍页同一批真机截图（英文 9 张、中文 8 张），1440×3200 |
| 构建配方 | `docs/fdroid/org.kiramyao.hrt.yml` | 已填到 2.0.4/2000004、`AutoUpdateMode`/`UpdateCheckMode`/`Antifeatures`，`Builds:` 里仍是待评审确认的猜测 |

## 2. 真正的阻碍（按严重程度）

1. **模型是非商业授权，不是自由许可。** `LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test`
   没有 LICENSE 文件，2026-09-18 由作者私下授予非商业使用权。包含策略要求
   「所有应用必须是 FLOSS」，这一条会让评审为难——它可能被记为 `NonFreeDep`，也可能直接
   被拒。这不是我们能在代码里修的：要么拿到作者的自由许可，要么接受评审结论。
   MR 里已经主动写明（见 §6），不要藏。
2. **`src-tauri/gen/` 由 Tauri 生成**（仓库里只有壳源码，`gen/` 与构建产物不入库）。
   配方里需要跑 `tauri android init` 之后再构建。
3. **构建服务器要能跑 Rust + Node + Android NDK**。这是 Tauri 应用进 F-Droid 的主要成本；
   `Builds:` 里的 Rust/NDK 版本必须和出包时一致（Rust 1.90、NDK 27.0.12077973），
   crates 需要 `cargo vendor` 离线化。首轮大概率要来回改。
4. 仓库公开可匿名克隆（`xingqimiao/Kira-HRT-Tracker`，满足）；tag `v2.0.4` 已推。
5. 反特性：可选的 Google / X 登录已在配方里声明为 `NonFreeNet`；不登录也能完整使用。

## 3. 提交时用到的信息

- 包名：`com.kiramyao.hrt`
- 版本：`2.0.4` / versionCode `2000004`
- 许可证：GPL-3.0-or-later（`LICENSE`，逐字 GPL 文本）
- 网站：<https://hrt.kiramyao.com>
- 源码：<https://github.com/xingqimiao/Kira-HRT-Tracker>
- tag：`v2.0.4`
- 商店包 sha256：`CFFC641CF14AD12939BE7275E6C2CA4C700B0A4B9DA1550A3AE08E553E580DF5`
  （arm64-v8a，13.7 MB，Firebase 引用 0），下载：<https://hrt.kiramyao.com/android/KiraHRT-2.0.4-fdroid.apk>

## 4. 截图规格

F-Droid 要求至少 2 张手机截图，最短边 ≥ 320px，PNG/JPEG 均可。
`phoneScreenshots/` 现在是介绍页用的那批真机截图（1440×3200，20:9），与 `/about/en/` 同源，
顺序为 概览 → 新增用药 → 快捷记录 → 记录 → 体检 → 添加化验 → 校准 → 账户（英文多一张设置）。

## 5. 提交步骤（只有你能做）

1. 在 GitLab 注册并 fork <https://gitlab.com/fdroid/fdroiddata>。
2. 新建分支（用包名，别提交到 master）：`org.kiramyao.hrt`。
3. 在 `metadata/` 下新建 `org.kiramyao.hrt.yml`，内容就是本目录的同名文件。
4. 提交后看该分支的 CI pipeline；`fdroid readmeta` / `lint` 的报错直接照着改。
5. 开 MR 到 `fdroid/fdroiddata`，正文用 §6。

## 6. MR 正文（直接粘贴）

```markdown
## New app: Kira HRT (`org.kiramyao.hrt`)

A privacy-first HRT dose log and level estimator. Records live on the device first;
an account is optional and only adds cross-device sync. Estradiol/testosterone levels
are estimated from logged doses with a pharmacokinetic model and refined against the
user's own blood tests; lab reports can be read from a photo on the device.

**Licence:** GPL-3.0-or-later. The repository was MIT until 2.0.4; GPL-3.0 applies
because the `.hrtbackup` reader derives from Featherline (GPL-3.0). The change is in
`LICENSE` and `THIRD-PARTY-LICENSES.md` at tag `v2.0.4`.

**This build (`HRT_NO_FCM=1 VITE_NO_SELF_UPDATE=1`)** contains no Firebase/FCM
(`com/google/firebase` count in `classes.dex`: 0) and has no self-update path: the
update manifest URL is folded out of the bundle and the "check for updates" item is
not rendered. Updates come from F-Droid.

**Anti-features:** `NonFreeNet` — optional sign-in with Google and X. The app is fully
usable, offline, without an account; signing in is what enables sync and the
assistant. Declared rather than argued.

**One thing to weigh before the build starts:** the pharmacokinetic model
(`LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test`) is reused under a **non-commercial**
grant from its author. The upstream repository declares no licence file and the grant
was given in correspondence on 2026-09-18; it is recorded in full in
`THIRD-PARTY-LICENSES.md`. The app's own code is GPL-3.0-or-later, but this dependency
is not a free licence. I am flagging it up front rather than leaving it to be found at
build time — if that makes the app ineligible for the main repository, please say so
and I will withdraw the MR.

**Build:** Tauri 2 (Rust) + Vite front end. `src-tauri/gen/` is generated, so the
recipe runs `tauri android init` before the Gradle build; Rust 1.90 and NDK
27.0.12077973 match the release APK. Crates will need `cargo vendor` for the offline
build step — the `Builds:` block is the part I expect to iterate on with you.

Screenshots, listing text and the icon come from `fastlane/metadata/android/`
(`en-US`, `zh-CN`).
```

## 7. 提交之后

- 首轮通常会被要求补 `Builds:` 细节或修构建失败；回复在 MR 里即可。
- 上架后本仓库的 GitHub Release **不再附带 fdroid 包**（v2.0.3 的那个已删除），商店负责更新；网站按版本单独分发商店包，`latest.json` 始终指向标准包。
- 应用内的自更新入口在该构建里不存在，这是刻意的。
- 如果评审以模型授权为由拒绝，可行的退路：自建 F-Droid 仓库（`fdroid server`，同一套配方），或向模型作者申请一个自由许可后重新提交。
