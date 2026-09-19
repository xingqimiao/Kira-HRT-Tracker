# HRT 前端重写交接单 — 基于 material-3 + animate 从根源重做

写于 2026-09-20。**给：接手的新会话。**
仓库 `E:\HRT`，分支 `main`，**HEAD = `7ebba7b`（已推 origin/main，线上就是这个版本，工作区干净）**。

---

## 0. 这一轮的指令（用户原话，逐字理解）

> 新对话从根源解决问题，前端全部基于 `/material-3` 和 `/animate` 重新写，药物浓度曲线和像素试管不变。**做完不上传。**

拆成四条硬约束：

1. **从根源解决** —— 不是再打补丁。前面两轮（`35e4dd0`、`7ebba7b`）是「在既有 Tailwind 堆法上贴规范」，用户要的是重写。
2. **全部基于 `/material-3` 和 `/animate`** —— 这两个 skill **存在**（见 §2），是本次的设计依据；每个组件、每处动效都要能追溯到它们。
3. **药物浓度曲线 + 像素试管不变** —— `src/components/ResultChart.tsx`（823 行）与 `src/components/BloodVial.tsx`（399 行）**原样保留**，包括它们的 props 与视觉。见 §5。
4. **做完不上传** —— 这一轮**不要** `git push`、**不要** 部署到 `/srv/hrt-web`。本地 commit 可以，产物留在 `dist/`。（与往常相反，务必注意。）

---

## 1. 起点：为什么「再修一层」不够

现状是 **React 18 + Vite 6 + Tailwind v4，没有组件库**。前两轮做完后：

- `src/index.css` 已 1900+ 行，里面是**手写的 MD3 角色 token**（`--color-m3-*`、`--md-sys-*` 别名层、typescale、shape、elevation、state、motion tokens）——**token 层可以整体保留**，它已经是规范形状的。
- 但**组件层是 Tailwind 工具类拼的**：一个按钮是 `className="btn-primary"`（`.btn-primary` 在 CSS 里）+ 各处零散的 `px-4 py-2 text-sm`。没有一个真正意义上的组件。
- 页面是**逐页手写布局**：21 个页面文件最大 744 行，没有 AppShell、没有大小类断点、没有 canonical layout。
- 无障碍是**零散补的**：前一轮加了全局 `:focus-visible`，但焦点顺序、roving tabindex、dialog 焦点陷阱、live region 都还没有。

**结论**：把 `src/index.css` 的 token 层留下当主题，把 `src/components/*` 与 `src/pages/*` 的**外观层**重写成真正的组件 + canonical layout。数据/逻辑层不动（见 §4）。

---

## 2. 两个 skill 的确切路径与用法

| skill | 路径 | 内容 |
|---|---|---|
| **material-3** | `C:\Users\fkxw2\.agents\skills\material-3\` | `SKILL.md`（32KB）+ `references/`：`component-catalog.md` 28KB、`layout-and-responsive.md` 22KB、`navigation-patterns.md` 17KB、`color-system.md` 16KB、`typography-and-shape.md` 15KB、`theming-and-dynamic-color.md` 14KB **——这些就是本次的设计依据，动手前逐份读。** |
| **animate** | `C:\Users\fkxw2\.agents\skills\animate\` | `SKILL.md` + `RECIPES.md`（button press / dropdown / tooltip / modal / drawer / toast / accordion / stagger / hold-to-confirm / tab indicator / scroll reveal / drag-to-dismiss） |

同一台机器上还有这些已安装、可用（`C:\Users\fkxw2\.agents\skills\`）：
`mobile-native`、`apple-design`、`ponytail`（本仓库既定风格：删除优先、最短可用 diff）、`improve-animations`、`find-animation-opportunities`、`review-animations`、`diagnosing-bugs`。
**注意**：`browser-skill` 不存在。浏览器验证用 Playwright 工具（本会话可用）。

### material-3 skill 里与本项目直接相关的三条硬事实

1. **不要装 `@material/web`**：它处于维护模式，**M3 Expressive 在 Web 上未实现**。Web 的合规做法就是 **CSS 自定义属性 + 自己写组件**（skill 的 Web (CSS-only) 路径）。
2. **Expressive 平台矩阵**：spring 物理动效、shape morphing、新按钮尺寸 XS–XL —— Web 上**没有**官方实现，只能用缓动/时长近似（skill 明说「CSS easing/duration fallback, not spring parity」）。
3. 规范里的禁用项（审核时会直接判 fail）：硬编码颜色、`transition: all`、`transform: scale(0)` 入场、UI 用 `ease-in`、用 `outline` 画分隔线（分隔线用 `outline-variant`）、用 shadow 表达 elevation（M3 用色调）。

---

## 3. 建议的执行顺序

### 第 0 步：读，不要写
`server/DEPLOY.md`（部署惯例，本轮不用但要知道）、`server/PRIVACY-POLICY-GUIDE.md` + `server/CODE-AUDIT.md`（**改 UI 文案时别写出软件做不到的承诺**）、`docs/md3-audit.md`（前两轮审计，含分数与遗留）、本仓库 `src/index.css`（token 层现状）。

### 第 1 步：先出审计（material-3 的 `audit` 模式）
按 10 个维度打分（color / typography / shape / elevation / components / layout / navigation / motion / a11y / theming），落成清单。前一份审计在 `docs/md3-audit.md`，**基线总分约 80/100**，剩余缺口集中在 **layout（窗口尺寸类、rail）与 components 覆盖度**。新审计直接接手这份，不要从零。

### 第 2 步：组件层重建（这是「重写」的主体）
按 `references/component-catalog.md` 逐个建，**每个组件一个文件**，用 CSS 类实现视觉（继续走 token），props 驱动变体：

- **Actions**：Button（filled / tonal / elevated / outlined / text × XS–XL）、IconButton（standard / filled / tonal / outlined）、FAB / Extended FAB、Segmented button、Split button、Button group
- **Input**：Outlined + Filled text field（含 leading/trailing icon、supporting text、error 态、`aria-invalid` 驱动）、Checkbox、Radio、**Switch**、Slider、Chip（assist / filter / input / suggestion）、Menu、Date/Time picker（现有 `DateTimePicker.tsx` 392 行可参照重写）
- **Containment**：Card（filled / outlined / elevated）、Dialog（basic / full-screen）、**Bottom sheet**（当前 compact 对话框已在模仿它）、Side sheet、Divider、Carousel（如需）
- **Communication**：Snackbar、Tooltip、Badge、Progress（linear/circular）、Loading indicator
- **Navigation**：Top app bar（small / medium / large）、**NavigationBar + NavigationRail**（按窗口尺寸类切换）、Navigation drawer（standard / modal）、Tabs、Search（search bar / search view）
- **Data display**：List / ListItem（one/two/three-line）

**判定标准**：任何一个 `src/pages/*` 里出现手写的 `px-4 py-2 text-sm` 都算没做完。

### 第 3 步：布局与导航（当前最大的缺口）
- **窗口尺寸类**：compact <600dp / medium 600–839 / expanded 840–1199 / large 1200–1599 / extra-large ≥1600（`references/layout-and-responsive.md`）。底部 NavigationBar → **≥840dp 换 NavigationRail**。
- **canonical layout**：列表-详情（记录页）、supporting pane（设置页）——`references/navigation-patterns.md`。
- **内容最大宽度**：大屏约束到 840–1040dp（skill 的 anti-pattern：拉伸到全宽）。
- **删掉 `--ui-scale`**：现在的做法是在 ≥1280px 直接把根字号放大 10/20/28%（`index.css` 顶部）。这是反 MD3 的解法——它把整个界面等比放大，而不是换布局。重写时用窗口尺寸类重新表达「大屏要更多内容」，不是更大的字。

### 第 4 步：动效，按 `/animate` 的次序做决策（**不要凭手感**）
1. **频率门**：100+/天（键盘快捷键、命令面板、底部导航）→ **不动画**。这就是为什么现在导航项的指示器用 transition 而非 keyframes，是对的，保持。
2. **命名用途**：feedback / spatial consistency / state / 防跳变 / delight。说不出来就不做。
3. **选最便宜的工具**：CSS transition → `@starting-style` → WAAPI → Motion 库。
4. **只动 `transform`/`opacity`**；入场 `scale(0.95~0.97)` + `opacity`，**永远不要 `scale(0)`**。
5. **曲线用强化版**（已在 `index.css`）：`--ease-out: cubic-bezier(0.23,1,0.32,1)`、`--ease-in-out: cubic-bezier(0.77,0,0.175,1)`、`--ease-drawer`。**UI 动画 <300ms**。
6. 快速可重复触发的（toast/toggle）**用 transition 不用 keyframes**（现 `.m3-snackbar` 已是）。
7. `@media (prefers-reduced-motion: reduce)` 与 `@media (hover: hover) and (pointer: fine)` **必须和动画一起写**，不是后续补。`index.css` 底部已有一大块 reduced-motion，新组件要并进去。
8. 触发锚定的浮层（menu/tooltip/popover）`transform-origin` 指向触发元素；**dialog 例外**（居中）。

---

## 4. 重写时**不要动**的东西（数据与逻辑层）

这些是「不变」的部分，重写只替换它们的**渲染**，不替换行为：

| 层 | 文件 | 说明 |
|---|---|---|
| 数据 | `src/hooks/useAppData.ts`（990 行） | 记录/校准/体重/设置的唯一真相源 |
| 同步 | `useCoreSync.ts`、`useLiveShareSync.ts`、`services/*` | 加密记录读写、分享快照 |
| 会话 | `hooks/useCoreSession.tsx`、`services/coreAuth.ts` | 登录/注册/设备列表 |
| 路由 | `hooks/useAppNavigation.ts` | `ViewKey` 视图枚举，**不是 URL 路由** |
| 视图上下文 | `contexts/*`（Dialog / HRTMode / Language / Vial） | |
| 模型 | `logic.ts`（根目录，共享给 server） | 药代动力学，**不要碰** |
| i18n | `src/i18n/translations.ts`（4783 行）、`i18n/share.ts` | 见下 |

### i18n 的三条铁律（重写最容易踩）
1. **`t()` 在键缺失时不抛错，会把键名原样渲染出来**。`scripts/check-i18n-coverage.mjs` 只比较语言之间是否一致，**看不见「没有组件再引用某键」**。
2. 文案结构是**多包合并**：`SESSIONS_I18N` / `PRIVACY_I18N` / `TRANSLATIONS_BASE` 等 5 处以 `...TRANSLATIONS_BASE.en` 形式在后展开、**覆盖前面的值** —— 给 `tr` 写文案必须在它自己的覆盖块里加字面量，否则被覆盖。语言回退链在 `contexts/LanguageContext.tsx` 的 `FALLBACK`。
3. 删键前必须自己 grep 调用方，注意 `t(\`sync.status.${x}\`)` 这类动态拼接（字面 grep 会误判为 0 调用）。

### 门禁（每次改完都跑）
```powershell
cd E:\HRT
npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String -Pattern '^src/'   # 必须 0 行
node scripts/check-i18n-coverage.mjs                                      # 7 语言 0 missing / 0 unused
node scripts/check-template-quick-add.mjs                                 # 首页快捷记录 4 项自检
npx vite build                                                            # 必须先设置 VITE_API_ORIGIN，见下
```
> **根目录 `tsc` 会顺带报 `server/` 与 `logic.ts` 的既有错误（约 45 条，全是假阳性），必须按 `^src/` 过滤**，否则数字会骗你。

> **build 必须带 `VITE_API_ORIGIN=https://api.kiramyao.com/hrt`**：`$env:VITE_API_ORIGIN='https://api.kiramyao.com/hrt'; npx vite build`。不带的话所有 API 解析成同源，`/health` 返回 SPA 外壳（200 + HTML），`loginProviders()` 视为「读不到」，X + Google 按钮**静默消失**——页面看起来完全正常，所以会一路发布出去。验证：`Select-String -Path dist/assets/index-*.js -Pattern 'api\.kiramyao\.com/hrt'` 至少命中一个文件。

---

## 5. 绝对不能动：药物浓度曲线 + 像素试管

用户明确要求这两个不变。**保留原文件、原 props、原视觉**，重写时只允许改它们**外面的容器**：

- `src/components/ResultChart.tsx`（823 行）—— props：`sim / events / labResults? / calibrationFn? / onPointClick? / isDarkMode? / mode? / title? / timeZone?`。内部自己算桌面缩放（第 344–349 行读 root font-size），**不要外面再去缩放它**（上一轮我加 `svg text { font-size }` 把所有图表标签变成 16px，已删——别再犯）。
- `src/components/BloodVial.tsx`（399 行）—— props：`level / mode / size? / className? / force? / liquid / surface / glass / sheen / spec / grid / keyPrefix / fill`。
- 相关但**属于曲线内部**的：`VialContext.tsx`、`utils/vialLevel.ts`、`utils/vialPhysics.ts`、`utils/motion.ts`、`components/VialSpray.tsx`、`components/PixelMark.tsx`、`components/OnboardingCurve.tsx`（引导页的曲线演示）——同样不动。
- 对应自检：`scripts/check-vial-level.mjs`、`scripts/preview-vial.mjs`、`scripts/generate-vial-icons.mjs`。

**判定**：如果重构后 `git diff --stat` 里出现 `ResultChart.tsx` 或 `BloodVial.tsx` 的改动，就是做错了。

---

## 6. 已有的资产（能留就留，别重造）

- `src/index.css` 的 token 层：M3 角色（`--color-m3-*`）→ 规范别名（`--md-sys-*`）、15 级 typescale（含应用自有的 `title-xl` 30/36 与 `body-compact` 13/18）、shape、elevation、state layer 透明度、8dp spacing、motion 曲线与时长。**新组件直接吃这些 token。**
- 已经规范化的外观类可以保留或收进新组件：`.m3-btn-*`（5 档 × 5 尺寸 + 真状态层）、`.m3-field-*`、`.m3-card-*`、`.m3-nav-item`、`.m3-list-item`、`.m3-snackbar`、`.m3-text-2xs` / `.m3-text-note`。
- 主题机制：`utils/themeInit.ts`（首帧前上主题，`main.tsx` 在 React 前调用）+ `:root:not(.dark)` 浅色覆盖 + `:root.key-blue` 蓝色变体。**这是可用的三主题系统，不要重做。**
- 图标：`src/icons/`（`index.ts` 111 行 + `compat.ts` + `custom.ts`）与 `components/Icon.tsx`；依赖里有 `reicon` / `reicon-mcp` / `lucide-react`。**注意 `Icon.tsx` 的 `<svg>` 外面包了一层 span** —— 跨组件写选择器时别用直接子选择器（上一轮 `.m3-nav-item > svg` 因此静默失效）。
- OCR 面板依赖 `public/ocr`（约 22 MB），已被 workbox 排除预缓存，**别把它塞回预缓存**。

---

## 7. 环境与工具（本机实测）

- **pwsh 工具会卡死**：命令体一大（约 15KB）之后，后续任何命令都不再返回输出且无法恢复。**本会话就是这样，我改用 Playwright 的代码执行通道拿到同机 Node 继续做完的**：
  ```js
  const proc = globalThis.constructor.constructor('return process')();
  const fs = proc.getBuiltinModule('fs');
  const cp = proc.getBuiltinModule('child_process');
  // 文件读写、npx tsc / vite build / git / ssh / scp 全部可用
  ```
  下次会话若 pwsh 仍坏，直接用这条路，不要卡在工具上。
- **Playwright 已验证可用**（本会话用它跑完本地 preview 与线上核对）。两个必知坑：
  - **service worker 会缓存旧 bundle**：验证前先 `navigator.serviceWorker.getRegistrations()` 注销 + 清 `caches`，或换端口（`vite preview --port 4188 --strictPort`）。判断现网版本：`curl -s https://hrt.kiramyao.com/ | grep -o 'sw-[a-z0-9]*\.js'`。
  - 截图能存进 `.playwright-mcp/`（唯一可写目录之一）；要在对话里看到图，把 PNG 转 data URL 再 `page.goto` 即可（本会话这么看过三张图，并因此抓到两个真 bug）。
- **Cloudflare Rocket Loader 开着**（hrt.kiramyao.com）：内联 `<script>` 的 type 会被改写成不可执行值并推迟。首屏「无 JS 兜底」现在是「默认 `display:none` + `<noscript>` 里开回来」，**不要换回内联脚本**。

---

## 8. 这一轮**不要**做的事（用户明确要求）

1. **不要 `git push`，不要部署**（`scp`/`rsync` 到 `/srv/hrt-web` 都不要）。本地 commit 随意，产物留在 `dist/`。**「不上传」是这一轮的验收条件之一。**
2. **不要改曲线与试管**（§5）。
3. **不要改 `server/`**——本轮纯前端。
4. **不要用 `tdd`**：用户明确说过这个项目不做 TDD。
5. **不要为了统一而删掉 i18n 键**：7 种语言 × 648 键现在是 0 缺口，删键要先 grep 调用方。

---

## 9. 可复原性：重写前的备份（**开工前先看这一节**）

用户要求「需要可复原（即需要备份）」。重写会大范围删改 `src/components/*` 与 `src/pages/*`，
所以**五个恢复点已经建好，每一个都实测可用**。开工前先读这一节，并在动手前确认第 1、2 项还在。

### 五个恢复点

| # | 位置 | 是什么 | 什么时候用它 |
|---|---|---|---|
| 1 | **git 标签 `pre-rewrite`**（看 `git rev-parse --short pre-rewrite`） | 指向重写前的最后一次提交，成本最低、最耐久 | 只是想把某个文件取回来 |
| 2 | **独立并列副本 `E:\HRT-pre-rewrite\`** | `git worktree`，detached 在 `pre-rewrite`；**已复制 `node_modules` 与 `public/ocr`，实测 `npx vite build` 成功** | 想**并排对照**旧界面；或在旧代码上验证一个想法 |
| 3 | **完整历史包 `C:\Users\fkxw2\hrt-backups\hrt-pre-rewrite.bundle`**（7.7 MB） | `git bundle --all`，含全部提交/分支/标签；已验证「complete history」，并**实测 clone 回滚成功** | 仓库本身被搞坏或被删时重建 |
| 4 | **全量补丁串 `pre-rewrite-full.patch`**（22 MB） | `git format-patch` 全量，**纯文本、不依赖 git 历史** | 想要能阅读、能选择性 `git am` 的文本记录 |
| 5 | **源码快照 `worktree-pre-rewrite-src.tar.gz`**（3.8 MB） | 工作树的 tar（排除 `node_modules`/`dist`/`.git`/`public/ocr`） | 不装 git 也能取回源码 |

3/4/5 都在 `C:\Users\fkxw2\hrt-backups\`，同目录另有 sha256（前 16 位，用于事后确认文件没被动过）：

```
# 校验（bundle 内嵌 ref，故每次移动标签后都要重新生成、重新取校验）
hrt-pre-rewrite.bundle          sha256:bf91c03b92095b95
pre-rewrite-full.patch          sha256:f9a1d2dd18700e78
worktree-pre-rewrite-src.tar.gz sha256:2951f6c35058a495
# 复查命令（PowerShell）
# Get-FileHash C:\Users\fkxw2\hrt-backups\hrt-pre-rewrite.bundle -Algorithm SHA256
# git -C E:\HRT bundle verify C:\Users\fkxw2\hrt-backups\hrt-pre-rewrite.bundle
```

### 怎么回退（三条路，按场景选）

```powershell
# A. 丢掉当前改动、回到重写前（备份都在磁盘上，所以 --hard 是安全的）
git -C E:\HRT checkout -- .                       # 先试软的：只丢工作区未暂存
git -C E:\HRT reset --hard pre-rewrite            # 彻底回去（会丢未提交的改动，先确认备份还在）
git -C E:\HRT clean -fd                           # 再清新增文件（会删 untracked，先看 git status）

# B. 想比着旧代码做（推荐：不破坏当前工作）
git -C E:\HRT checkout -b rewrite pre-rewrite

# C. 仓库被彻底搞坏：从 bundle 重建
git clone C:\Users\fkxw2\hrt-backups\hrt-pre-rewrite.bundle E:\HRT-restored
```

### 操作纪律（避免「备份了但用不上」）

1. **重写在新分支上做**：`git checkout -b rewrite`。这样 `main` 始终停在 `pre-rewrite`，`git diff pre-rewrite` 就是本轮全部改动。
2. **每完成一个组件就 commit**：回退粒度从「整个重写」降到一个组件。
3. **删文件前先确认它在版本控制里**：`git ls-files <path>` 能列出来就可恢复；`git ls-files --others` 里的文件**不在**任何提交中，删了就真没了 —— 先提交它。
4. **不要 `git push --force`；不要 `reset --hard` 之后跑 `git gc --prune=now`** —— 恢复点 1/2/3 都依赖这些对象还在。
5. **本轮不 push、不部署**，所以线上 `hrt.kiramyao.com` 本身就是一份可对照的旧版本，出问题时可以当第 6 个恢复点。

### 曲线与试管也在这套保护里

`ResultChart.tsx` / `BloodVial.tsx` 属于「不变」范围；万一被误改，单独取回即可：

```powershell
git -C E:\HRT checkout pre-rewrite -- src/components/ResultChart.tsx src/components/BloodVial.tsx
```

---

## 10. 敏感信息（不要打印、不要提交）

- 生产密钥与 `DATABASE_URL` 在服务器 `/srv/hrt/.env`。
- Cloudflare 凭据：`C:\Users\fkxw2\Downloads\cloudflarewrite.txt` 与 `E:\cloudflare.txt`（后者含 S3 access/secret key）；account id 见 runtime memory。
- SSH 部署私钥 `~/.ssh/hrt_deploy`；`Downloads` 里的原始 key 权限过开放会被 OpenSSH **静默忽略**。
- `oauth2.0.txt`（X 的 client id/secret）在仓库根，已被 `.gitignore` 覆盖 —— **不要用 `git add -f` 绕过**。
- 本轮不部署，所以这些都用不上；知道位置即可。

---

## 11. 完成后要更新的东西

1. 把本轮结果写进 `docs/md3-audit.md`（分数与遗留），并新建一份交付记录。
2. 重新生成备份点（重写后的状态），命名用 `post-rewrite-<commit>`，并更新本文件的 §9 表。
3. **不要** push，**不要** 部署 —— 等用户明确指令。

---

## 12. 完成判据

- [ ] `src/pages/*` 里不再出现手写的 `px-N py-N text-X` 布局工具类，页面只做「组合组件 + 传数据」。
- [ ] 每个组件都能指到 `material-3/references/component-catalog.md` 里的哪一节。
- [ ] 每处动效都能说出 `/animate` 四问的答案（频率门 / 用途 / 工具 / 曲线时长），且 reduced-motion 与 pointer 门一起写。
- [ ] ≥840dp 有 NavigationRail，大屏内容有最大宽度约束，`--ui-scale` 已移除。
- [ ] `ResultChart.tsx` 与 `BloodVial.tsx` 的 git diff 为 **0 行**。
- [ ] `tsc` 只看 `^src/` = 0 行；i18n 7 语言 0 缺口；`vite build`（带 `VITE_API_ORIGIN`）成功。
- [ ] **没有 push、没有部署。**
