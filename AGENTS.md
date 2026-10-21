# AGENTS.md — Kira HRT Tracker (M3 Expressive Web Refactor; Tauri 2 deferred)

## 0. 核心使命与基准真源 (Single Source of Truth)

本项目当前只做一个工程演进：

1. **Web 端 UI 全面重构**：保持 React 19 · TypeScript 7 · Vite 8 · Tailwind CSS · PWA 架构，将全站 UI 100% 升级为 **Material Design 3 Expressive (M3E)** 设计语言。
2. **Tauri 2 原生壳暂停**：不再新建 `android/`，也不再维护 Kotlin/Compose 版本；Tauri 2 壳已随历史删除，后续如需恢复必须按 `src-tauri/` 重建（不是还原），当前不作为交付范围。
3. **视觉与交互唯一基准文件**：仓库内的 **`docs/m3e-prototype.html`**（五页与外壳）与 **`docs/m3e-add-dose-prototype.html`**（新增/编辑用药面板）是最高优先级的视觉、动效、圆角、配色与响应式布局规范。任何代码实现必须与原型参数严丝合缝。
4. **业务零丢失原则**：现有的后端（`server/`）、PK 引擎（`logic.ts` 原有 Mihari 模型与 `src/pk/` Transmtf 模型）、4 种校准估计器（关闭 / Hybrid-MIPD / EKF / OU-Kalman）、逐帐户 DEK + 口令 KEK 端到端加密、本机离线化验单 OCR、本地排程通知 + FCM 补推、7 语言 i18n 包必须 100% 完整保留或等价移植。

---

## 1. Material Design 3 Expressive (M3E) 精确参数与模块字典

### 1.1 色彩令牌 (ColorScheme & Extended Semantic Tokens)

无论 Web CSS 变量还是 Compose `ColorScheme`，必须严格使用以下色值（禁止擅自替换为默认紫色系）：

| 语义角色 (Token)                | CSS 变量     | 深色模式 (Dark Default) | 浅色模式 (Light) | Compose `ColorScheme` / 扩展字段       |
|:--------------------------- |:---------- |:------------------- |:------------ |:---------------------------------- |
| Stage (外框背景，仅预览态)           | `--stage`  | `#0C0A0E`           | `#E9E4EA`    | -                                  |
| Background / Surface        | `--bg`     | `#16121A`           | `#FFF8F8`    | `background` / `surface`           |
| Surface Container           | `--sc`     | `#211C25`           | `#F9ECF0`    | `surfaceContainer`                 |
| Surface Container High      | `--sch`    | `#2C2630`           | `#F2E3E9`    | `surfaceContainerHigh`             |
| Surface Container Highest   | `--sch-h`  | `#362F3B`           | `#EAD6DE`    | `surfaceContainerHighest`          |
| Primary                     | `--pri`    | `#FFB1C8`           | `#A03D63`    | `primary`                          |
| On Primary                  | `--onpri`  | `#5D1133`           | `#FFFFFF`    | `onPrimary`                        |
| Primary Container           | `--pric`   | `#7A2C4A`           | `#FFD9E3`    | `primaryContainer`                 |
| On Primary Container        | `--onpric` | `#FFD9E3`           | `#3F001E`    | `onPrimaryContainer`               |
| Secondary Container         | `--secc`   | `#4E3A43`           | `#F6DBE5`    | `secondaryContainer`               |
| On Secondary Container      | `--onsecc` | `#FBDBE6`           | `#2B151E`    | `onSecondaryContainer`             |
| Tertiary Container          | `--terc`   | `#4D3A14`           | `#FFE3B0`    | `tertiaryContainer`                |
| On Tertiary Container       | `--onterc` | `#FFDEA8`           | `#261900`    | `onTertiaryContainer`              |
| On Surface                  | `--on`     | `#EADFE6`           | `#211A1D`    | `onSurface`                        |
| On Surface Variant          | `--var`    | `#CFC0C9`           | `#4F4349`    | `onSurfaceVariant`                 |
| Outline                     | `--out`    | `#9A8D95`           | `#84757B`    | `outline`                          |
| Error                       | `--err`    | `#FFB4AB`           | `#BA1A1A`    | `error`                            |
| Error Container             | `--errc`   | `#5C1916`           | `#FFDAD6`    | `errorContainer`                   |
| On Error Container          | `--onerrc` | `#FFDAD6`           | `#410002`    | `onErrorContainer`                 |
| Extended: OK (达标绿)          | `--ok`     | `#7FE0A8`           | `#2F8458`    | `KiraExtendedColors.ok`            |
| Extended: OK Container      | `--okc`    | `#1D3A2B`           | `#D6F2E2`    | `KiraExtendedColors.okContainer`   |
| Extended: Warning (警告黄)     | `--warn`   | `#FFCA64`           | `#825500`    | `KiraExtendedColors.warn`          |
| Extended: Warning Container | `--warnc`  | `#423008`           | `#FFDDB3`    | `KiraExtendedColors.warnContainer` |

---

### 1.2 物理弹簧与动效系统 (`MotionScheme.expressive()`)

- **Android Jetpack Compose**：
  - 全局启用 `@OptIn(ExperimentalMaterial3ExpressiveApi::class) MaterialExpressiveTheme(motionScheme = MotionScheme.expressive())`。
  - **Spatial Springs (`motionScheme.fastSpatialSpec()` / `defaultSpatialSpec()`)**：用于圆角形变（Morph）、按钮挤压、列表展开、共享容器尺寸过渡（允许超调回弹，`dampingRatio ≈ 0.6f, stiffness ≈ 800f`）。
  - **Effects Springs (`motionScheme.defaultEffectsSpec()`)**：用于背景色、文字色、不透明度过渡（临界阻尼无超调，`dampingRatio = 1.0f`）。
- **Web CSS 曲线参数**：
  - 按压形变 (`[data-m]`)：`transition: border-radius 0.5s cubic-bezier(0.3, 1.8, 0.5, 1), transform 0.35s cubic-bezier(0.3, 1.7, 0.5, 1), background 0.2s`；激活态 `.mo` 应用 `border-radius: var(--mo) !important; transform: scale(0.96)`，并在 pointerup 后延迟 `300ms` 释放。
  - 页面切入动画 (`@keyframes in`)：`0.35s cubic-bezier(0.2, 1, 0.3, 1)`，从 `opacity: 0; transform: translateY(10px)` 到 `none`。
  - 底部抽屉 (`.sheet`)：`transform 0.42s cubic-bezier(0.2, 0.9, 0.3, 1), height 0.35s cubic-bezier(0.2, 0.9, 0.3, 1)`。
  - 共享容器全屏展开 (`.ov`)：展开时 `clip-path 0.72s cubic-bezier(0.16, 0.84, 0.24, 1)`；收起时 `.ov.out` `clip-path 0.5s cubic-bezier(0.4, 0, 0.2, 1)`。

---

### 1.3 M3E 核心组件模块名与几何参数

实现时必须封装以下标准 M3E 组件（严禁退化为普通圆角卡片）：

#### (1) `SegmentedList` & `SegmentedListItem`（分段聚合列表 `.list` / `.li`）

- **布局间距**：垂直间距固定为 `3px` (`Arrangement.spacedBy(3.dp)`)，默认背景色 `--sch` (`surfaceContainerHigh`)，悬停态 `--sch-h` (`surfaceContainerHighest`)，按下态 `--secc` (`secondaryContainer`)。
- **动态分段圆角规则**：
  - 首项 (`:first-child`)：`topStart = 26dp, topEnd = 26dp, bottomStart = 8dp, bottomEnd = 8dp` (`26px 26px 8px 8px`)
  - 中间项：`8dp` (`8px`)
  - 末项 (`:last-child`)：`topStart = 8dp, topEnd = 8dp, bottomStart = 26dp, bottomEnd = 26dp` (`8px 8px 26px 26px`)
  - 唯一项 (`:only-child`)：`26dp` (`26px`)
  - 桌面端 Master-Detail 持久选中项 (`.li.active-nav`)：圆角变为独立 `22dp` (`22px`)，背景切换为 `--pric` (`primaryContainer`)，文字与图标切换为 `--onpric`，前导圆形图标背景为 `rgba(255,255,255,0.18)`（浅色模式 `0.55`）。
- **尺寸变体**：
  - 标准行 (`.li`)：`minHeight = 64dp`，内边距 `12dp 16dp`，间距 `14dp`；前导圆形图标容器 `.ic` 为 `42dp × 42dp`，内部图标 `22dp`。
  - 大图标行 (`.list.bigic .li`)：`minHeight = 76dp`；前导圆形图标容器 `.ic` 为 `50dp × 50dp`，内部图标 `25dp`。
  - 前导容器配色变体：默认 `.ic` (`--secc`/`--onsecc`)、主色 `.ic.p` (`--pric`/`--onpric`)、琥珀色 `.ic.am` (`--terc`/`--onterc`)、危险色 `.ic.err` (`--errc`/`--err`)。

#### (2) `ConnectedButtonGroup`（连接式按钮组 `.cg`）

- **Compose 对应模块**：`androidx.compose.material3.ButtonGroup` + `ToggleButton` + `ButtonGroupDefaults.connectedLeadingButtonShapes()` / `connectedMiddleButtonShapes()` / `connectedTrailingButtonShapes()`。
- **精确参数**：
  - 按钮间距 `3px` (`3.dp`)，内边距 `8dp 14dp`，字号 `13sp` (`fontWeight = 600`)。
  - 未选中态：背景 `--sch`，文字 `--var`；首项圆角 `20px 6px 6px 20px`，中间项 `6px`，末项 `6px 20px 20px 6px`。
  - 选中态 (`.on` / `checked = true`)：背景变为 `--pric`，文字变为 `--onpric`，**四个角圆角全部通过弹性动画变为 `20px` (`20.dp`)**（`cubic-bezier(0.3, 1.7, 0.5, 1)`）。

#### (3) `ExpressiveHeroTiles`（非对称张力磁贴 `.tile`）

- **主磁贴（如概览 E2 卡片）**：常态圆角 `28dp`，背景 `--pric`；按下时形变为非对称斜角 `--mo: 46px 14px 46px 14px`。
- **样式 A 磁贴 (`.tile.a`)**：常态圆角 `26dp`，背景 `--secc`；按下时形变为 `46px 14px 46px 14px`。
- **样式 B 叶形磁贴 (`.tile.b`)**：常态即为**非对称叶形圆角 `topStart = 44dp, topEnd = 14dp, bottomEnd = 44dp, bottomStart = 14dp`** (`44px 14px 44px 14px`)，背景 `--terc`；按下时反向形变为对称 `28dp`。

#### (4) `CookiePolygonShapes`（曲奇多边形 `MaterialShapes`）

- **数学公式（Web SVG 生成器）**：
  `r(t) = R * (1 + a * cos(n * (t - phase)))`，采样 120 点闭合。
- **账户头像 (`#av`)**：
  - **Compose 模块**：`MaterialShapes.Cookie9Sided` 与 `MaterialShapes.Circle`，通过 `androidx.graphics.shapes.Morph(Cookie9Sided, Circle)` 裁剪。
  - **参数**：尺寸 `64dp × 64dp`（viewBox `76×76`, `cx=38, cy=38, R=35, n=9, a=0.09`）。进入账户页或点击头像时，在 `1800ms` 内按 `easeInOutCubic` 将波幅从 `0.09 -> 0`（即 `Morph` progress `0f -> 1f`）同时相位旋转 `2π`（360°）。若开启系统减弱动态效果 (`prefers-reduced-motion`) 则直接显示圆形。
- **HRT 纪念日 Hero 卡片背景装饰 (`#ck2`)**：
  - **Compose 模块**：`MaterialShapes.Cookie8Sided`。
  - **参数**：尺寸 `130dp × 130dp`（`R=70, n=8, a=0.09`），绝对定位于卡片右上角 `right = -30dp, top = -44dp`，填充 `currentColor` (`--onpric`)，`opacity = 0.14`。

#### (5) `AdaptiveNavigationShell`（响应式导航外壳 `.nav` + `#fab` + `#railLogo`）

- **断点定义**：窗口宽度 `< 760px/dp` 为 **Mobile (Compact)** 模式；`>= 760px/dp` 为 **Desktop / Tablet (Expanded)** 模式。
- **Mobile 模式**：
  - 底部渲染 `ShortNavigationBar`（高 `78dp`，背景 `--sc`），包含 5 个一级 Tab：`概览`、`记录`、`体检`、`设置`、`账户`。
  - 导航指示器胶囊 `.p`：高 `30dp`，圆角 `15dp`；未选中宽 `58dp`（透明），选中时弹宽至 `64dp`（背景 `--pric`，图标色 `--onpric`）。
  - FAB 位于右下角 `right = 16dp, bottom = 92dp`，高 `56dp`，圆角 `22dp`（按压形变 `--mo: 16px`），带图标与文字（概览：`#mark 快捷记录`；记录：`#plus 新增用药`；体检：`#plus 添加结果`；设置与账户页隐藏 FAB）。
- **Desktop / Tablet 模式**：
  - 导航栏转为左侧垂直 `NavigationRail`（宽 `96dp`，高 `100%`，右侧带 `1dp solid rgba(154,141,149,0.14)` 边框，主内容区 padding `32dp 36dp 40dp`）。
  - **左上角顶栏槽位 (`left = 18dp, top = 22dp, width = 60dp, height = 56dp, borderRadius = 18dp`)**：
    - 当处于 `概览`、`记录`、`体检` 页时，FAB 移入该槽位，隐藏文字仅显示居中图标。
    - 当处于无 FAB 的 `设置`、`账户` 页时，该槽位无缝切换显示 **`.rail-logo`（背景 `--pric`，居中显示 `29dp` 试管图标 `#tube`）**，点击后跳转回 `概览` 页。

#### (6) `FloatingActionButtonMenu`（体检页展开菜单 `#fm`）

- **Compose 模块**：`FloatingActionButtonMenu` + `ToggleFloatingActionButton` + `FloatingActionButtonMenuItem`。
- **交互参数**：在「体检」页点击 FAB 时，主 FAB 变为 `56dp × 56dp` 圆形关闭按钮（背景 `--pri`，文字 `--onpri`，图标 `#x`），开启半透明遮罩 `.scrim`（`rgba(0,0,0,0.55)`），弹出两项 `.fmi` 胶囊按钮（高 `52dp`，圆角 `26dp`，背景 `--sch`，带错峰 `50ms` 的 `translateY(14px) scale(0.85) -> none` 弹簧动画）：
  1. `扫描化验单` (`#scan`) -> 触发共享容器全屏相机/OCR 覆盖层
  2. `手动添加` (`#plus`) -> 触发底部抽屉/模态框表单

#### (7) `ContainerTransformOverlay` & `AdaptiveSheet`（共享容器覆盖层 `.ov` 与自适应抽屉 `.sheet`）

- **共享容器覆盖层 (`.ov` / Compose `SharedTransitionLayout`)**：
  - 用于「新增用药」与「扫描化验单」。
  - Mobile 端从触发按钮（FAB 或菜单项）的精确 bounding box 与圆角出发，通过 `clip-path: inset(...)` 在 `720ms` 内展开铺满全屏，并在前 `200ms` 显示按钮残影 `.ghost` 淡出；关闭时在 `500ms` 内逆向缩回原按钮位置。
  - Desktop 端转为居中模态窗口（宽 `520dp`，高 `620dp`，圆角 `32dp`，带 `1dp` 描边与阴影）。
- **自适应抽屉 (`.sheet` / Compose `ModalBottomSheet` & `Dialog`)**：
  - Mobile 端为底部上滑抽屉（顶部圆角 `32dp`，默认高 `56%`，点击顶部拖拽条 `.hd` 切换 `.tall` `88%` 高度）。
  - Desktop 端自动转为屏幕正中模态对话框（宽 `460dp`，最大高 `82%`，四周圆角 `32dp`，隐藏顶部拖拽条 `.hd`）。

#### (8) 其它专属 M3E 控件

- **二级返回标题栏 (`.hback`)**：由旋转 `180°` 的 `#chev` 箭头（`27dp`，色值 `--pri`）+ `28sp` 粗体标题组成，点击时箭头向左位移 `4dp`。Desktop 端在设置一级详情面板（`#sback`）自动隐藏箭头并禁用点击，但在三级子页（`#subBack`）依然保留箭头与返回功能。
- **数字步进胶囊输入框 (`.num-pill`)**：宽 `78dp`，高 `42dp`，圆角 `14dp`，边框 `1.5dp solid rgba(154,141,149,0.35)`，背景 `--bg`，聚焦时边框变 `--pri`、背景变 `--sc` 并放大 `scale(1.03)`。
- **长条危险操作按钮 (`.btn.danger-wide`)**：宽 `100%`，高 `54dp`，圆角 `27dp`，背景 `--errc`，文字与图标 `--err`，左对齐内边距 `20dp`。

---

## 2. 页面级响应式网格与主从布局规范

1. **概览 (`Overview`)**：
   - Desktop 双栏：`grid-template-columns: 1.15fr 1fr; gap: 24px`。
   - 左栏：顶部 `1.6fr 1fr` 双磁贴（左 E2 浓度卡，右抗雄/贴片状态卡）+ 激素浓度变化图表卡 `.card`。
   - 右栏：近期剂量 `.list.bigic`。
2. **记录 (`Records`)**：
   - Desktop 双栏：`grid-template-columns: 300px 1fr; gap: 24px`。
   - 左栏：历史统计总览卡片 + 药物分类筛选 `ConnectedButtonGroup`。
   - 右栏：按日期分组的给药历史 `.list.bigic`。
3. **体检 (`Lab / Checkup`)**：
   - Desktop 双栏：`grid-template-columns: 300px 1fr; gap: 24px`。
   - **响应式差异关键点**：
     - Mobile 端：顶部显示单条 `.list.exam-entry`（「文字记录 · X 条随访与体征笔记」），下方紧跟「化验结果」列表；点击「文字记录」后隐藏主视图，钻取进入带 `.hback` 的 `#examSub` 文字记录详情页。
     - Desktop 端：隐藏 `.exam-entry` 入口行，在左栏直接常驻展示 `.exam-text-desktop`（文字记录卡片 + 猫咪空状态插画 + `.btn.tonal-add`「写一条」按钮），右栏常驻展示「化验结果」列表（含模型估算空心圈 vs 实测实心点的对比 SVG 与校准倍率 Chip）。
4. **设置 (`Settings`)**：
   - Desktop 主从双栏 (`.d-split`)：`grid-template-columns: 330px 1fr; gap: 28px`。左栏 `#hub` 常驻 6 大分类导航（带 `.active-nav` 高亮），右栏 `#sd.detail-pane`（背景 `--sc`，圆角 `32dp`，内边距 `24dp 28dp`）常驻显示当前分类详情。
   - Mobile 钻取：默认只显示 `#hub`（且清除 `.active-nav` 持久高亮），点击某分类后隐藏 `#hub`、全屏显示 `#sd`；在「常规 -> 抗雄激素显示」或「算法设置 -> 校准设置 / 药代动力学模型」点击时，进一步钻取进入 `#sdpSub` 三级子页面（选中单选框或模型卡片后，自动同步更新上一级列表项的副标题 `.s`）。
5. **账户 (`Account`)**：
   - Desktop 双栏：`grid-template-columns: 1.15fr 1fr; gap: 24px`。
   - 左栏：曲奇头像 `.prof` + HRT 纪念日 `.hero` + 用药/化验双统计磁贴 `.tiles`。
   - 右栏：数据同步卡片 `.sync`（点击「立即同步」切换 `.spin` 环形加载动画）+ AI 助手 MCP / 账户安全 `.list` + 底部 `Powered by KiraEqual`。

---

## 3. 原型中未单独画出的存量功能 UI 改写规则（补全规范）

仓库中已有但未在 `docs/m3e-prototype.html` 静态写出的交互界面，必须按以下规则用 M3E 语言改写：

1. **新增/编辑用药页的动态扩展字段**：
   - 当药代动力学模型设为 `Transmtf` 且途径为 `凝胶 (gel)` 时，在给药时间下方用 `SegmentedList` 渲染：凝胶产品选择、涂抹部位与面积、共涂促渗物、冲洗时间。
   - 当途径为 `舌下 (sublingual)` 时，渲染 `ConnectedButtonGroup` 选择吞咽/含服分层系数。
   - 当途径为 `撕下 (peel)` 时，隐藏剂量输入框，用 `SegmentedList` 列出当前佩戴中的贴片供勾选关联。
2. **概览页贴片佩戴追踪与 K 线模式**：
   - 若存在未撕下的贴片，在概览页磁贴区展示一张 `.tile.b` 叶形磁贴，显示佩戴时长与「撕下」快捷按钮。
   - 浓度曲线支持切换「平滑曲线」与「OHLC K 线蜡烛图」，K 线及不确定性阴影带（±8% 置信区间）均使用 `--pri` 半透明渐变与 `--okc` 目标区间底色。
3. **记录页批量选择模式**：
   - 点击「批量选择」后，每条 `.li` 左侧滑出圆角复选框（`8dp` 圆角，选中态 `--pri`），页面底部浮出 M3E `FloatingToolbar`（高 `56dp`，圆角 `28dp`，背景 `--pric`，包含「全选」「删除所选」「取消」操作）。
4. **校准设置实时预览与数据导入预览动画**：
   - 在设置三级页「校准设置」切换 4 种算法或「回顾全部 / 仅前向推算」时，在卡片上方展示迷你版浓度曲线实时变形过渡动画。
   - 导入 JSON / CSV（支持 Kira / Oyama / Transmtf / Featherline 格式）时，在 `.sheet` 模态框中使用 `SegmentedList` 预览待导入的给药条数与血检条数，确认后再合并入库。
5. **账户认证、安全会话管理、只读分享链接与 AI 助手 (MCP)**：
   - **未登录态 / 登录注册弹窗**：使用 `.sheet.tall`（Desktop 为 `460dp` 居中模态框），输入框统一采用 `.fld`（高 `56dp`，圆角 `20dp`，背景 `--sch`），切换登录/注册使用 `ConnectedButtonGroup`，支持 Passkey 一键登录与第三方 OAuth 按钮。
   - **账户与安全二级页**：展示密码修改、Passkey 通行密钥管理、已登录设备会话列表（`.list.bigic`，当前设备标 `.chip.ok`，其它设备配 `.icon-del` 踢出按钮）、退出登录与注销账户（`.li.danger`）。
   - **连接 AI 助手二级页**：展示 MCP Streamable HTTP 端点地址、一键复制/轮换授权 Token、以及只读分享链接生成器（可设置有效期与访问密码）。
6. **新手引导 (Onboarding)**：
   - 点击「重新看一遍新手引导」或首次打开应用时，使用居中模态卡片 + 顶部曲奇多边形动态插画分步引导。

---

## 4. Tauri 2 壳（暂停，后续恢复）

当前仓库**没有** `src-tauri/`，也不维护 `android/`。Tauri 2 版本已随历史删除，后续恢复时按以下边界重建：

1. **独立壳**：`src-tauri/` 只承载窗口、系统通知、安全存储、文件选择与自动更新；所有业务逻辑仍留在 Web 端。
2. **能力对齐**：恢复 `@tauri-apps/cli`、`plugin-opener`、`secure-storage-api`、`tauri-plugin-notifications-api` 四个依赖，并重新实现 `src/utils/{platform,secureStore,externalLinks,medPlanNotify}.ts` 的原生分支。
3. **返回手势**：Android 系统返回只关闭 Web 端最上层覆盖层（剂量面板、时间页、Sheet、全屏层），不退出应用。
4. **构建**：`npm run build` 必须继续产出可直接由 Tauri 加载的 `dist/`；壳的重建不得改动 Web 端设计令牌与五页 DOM。
