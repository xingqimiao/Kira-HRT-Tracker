# PLAN.md — Kira HRT Tracker · M3 Expressive Web 重构执行计划

> **当前范围**：只做 Web 端（React 19 · TypeScript 7 · Vite 8 · PWA）。Tauri 2 壳暂停、`android/` 不维护，后续按 `AGENTS.md §4` 重建。
>
> **执行铁律**：
> 1. 启动前先读 `AGENTS.md`、`docs/m3e-prototype.html`、`docs/m3e-add-dose-prototype.html`。
> 2. 每完成一项立即把 `- [ ]` 改为 `- [x]`。
> 3. 每项结束必须跑 `npx tsc -p tsconfig.json --noEmit`、`$env:HRT_SAME_ORIGIN='1'; npm run build`，并做 390 / 1280 Playwright 截图。

---

## Phase 1: 基础设计系统

- [x] 提取原型 21 个色彩令牌、深浅色主题与 `m3e.css`。
- [x] 原型图标 sprite（38 + 4），含更新后的 `#pill` / `#syr` / `#patch`。
- [x] `src/ui/proto/` 原语：`SegmentedList` / `ConnectedButtonGroup` / `HeaderBack` / `MorphSurface` / `CookiePolygon` / `AdaptiveSheet` / `Snackbar` / `FloatingToolbar`。
- [x] 删除旧 `src/ui/m3e/`、`tokens.css`、`components.css`、`shell.css`；旧 class 仅保留 `src/proto-compat.css` 兼容别名。
- [x] `@m3e/react` 已接入 Onboarding 主 CTA；`@alerix/m3-loading-indicator` 已接入账户恢复、OCR 与导入三处 loading。

## Phase 2: 五个主页面

- [x] `Home.tsx`：`.pg#p0`、`.tile` / `.tile.b`、`.card`、`.list.bigic`、右栏近期剂量。
- [x] `History.tsx`：`.pg#p1`、`.d-grid.records-grid`、统计卡 / `.cg` 筛选、按日 `.list.bigic`、批量工具栏；点击记录打开二级全屏编辑面板。
- [x] `Lab.tsx`：`.pg#p2`、手机 `.exam-entry` → `#examSub`、桌面 `.exam-text-desktop`、`.list.bigic` 化验结果。
- [x] `Settings.tsx`：`.pg#p3`、`.d-split`、`#hub` / `#sd.detail-pane`、三级子页、760px 钻取断点。
- [x] `Account.tsx`：`.pg#p4`、`.prof` / `.hero` / `.tiles` / `.sync` / `.list`；未登录态整理为单列居中卡片。
- [x] 路由图标改为 `#pill / #tongue / #gel / #syr / #patch / #peel`；抗雄/周期黄底、孕激素/毛发 `--secc`。
- [x] 删除批量添加功能。

## Phase 3: 新增/编辑用药面板

- [x] 模板条 / `#tplSheet` / MTF-FTM 隔离 / 10 个上限。
- [x] 4+3 分类、按社群常用度排序、MPA 仅 FTM、无米诺地尔、GnRH 无剂量。
- [x] `.dose-hero` 44px / 800 / -1.5px / 136px；单位 16px / 800 / .85。
- [x] 凝胶字段 + 简易凝胶提示 + 自建产品按需显示；`.list` 圆角完整性。
- [x] `#timePage` 自绘日历 + 时分卡片。

## Phase 4: 文档与终验

- [x] `AGENTS.md` 改为 Web-only + Tauri 2 后续恢复。
- [x] `PLAN.md` 改为当前真实状态。
- [x] 移动端整体回归：五页 + 面板 + Sheet + 时间页逐项截图。
- [x] 7 语言新增键补齐（1074 keys，0 gap）。
- [x] 删除 `src/proto-compat.css` 的最后一批 `m3e-*` 兼容别名（待设置子页全部改写）。
  - 已删死别名（零引用，387 → 295 行）：`.m3e-li` / `.m3e-li-tx` / `.m3e-li-t` / `.m3e-li-sub` / `.m3e-li-tr` / `.m3e-btn-tonal` / `.m3e-btn-filled` / `.m3e-btn-text` / `.m3e-btn-danger-wide` / `.m3e-tile` / `.m3e-tile-value`。
  - 已迁移 `.m3e-num-pill` → 原型 `.num-pill`（4 处：`Settings.tsx:532`、`PKParams.tsx:228`、`MedPlanSettings.tsx:753/767`），295 → 277 行。副作用仅为字号 16 → 15.5px、焦点态多出 `scale(1.03)`，均为原型规范值。
  - 已迁移收尾（277 → 237 行，`proto-compat.css` 内 `.m3e-*` 归零）：`.m3e-card` → 原型 `.card`；`.m3e-chip` → `.chip` + 新增 `.chip.soft`（中性卡片上的自有底色，原型 `.chip` 本为透明，用在彩色磁贴上）；`.chip.warn/.err/.pri` 一并迁入 `index.css`。`.m3e-muted` / `.m3e-section-title` / `.m3e-tile-label` 原型里没有对应类（原型是内联写死字号），故改名 `.muted` / `.section-title` / `.stat-label` 并落在 `index.css`，成为唯一定义而非别名。
  - 计算样式逐项比对（`--sch` / `--var` / `--warnc` / 12.5px / 700 / 12px 圆角 / 6×12 内边距）与迁移前一致，`.card` 为 `--sc` + 28px + 18px 内边距。
  - `proto-compat.css` 现只剩浏览器侧脚手架：全局按钮/输入重置、`.light` 浅色调色板、登录表单字段、portal 化 sheet/snackbar/批量工具栏的定位。
