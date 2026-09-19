# 部分回退记录 — 2026-09-20

把「基于 material-3 的前端重写」整体回退，只留下两项：**导航壳层（①）** 与
**动画更新（④）**。本文件说明留了什么、退回了什么、以及怎么再把全量取回来。

分支 `rewrite`，提交见 `git log`。**没有 push，没有部署。**

---

## 0. 全量重写没有丢，只是不在这条线上

| 位置 | 是什么 |
|---|---|
| 标签 `rewrite-ui` / 分支 `rewrite-full`（= `4cbe9bd`） | 23 个组件、21 个页面全部重写完的状态 |
| 标签 `post-rewrite-838903b` + `C:\Users\fkxw2\hrt-backups\hrt-post-rewrite-838903b.bundle` | 重写完成时的提交与仓库快照（bundle 校验通过） |
| `git show rewrite-ui:docs/ui-rewrite.md` | 那份交付记录（组件清单 / 布局 / 动效四问 / 门禁） |

随时可以 `git checkout rewrite-full` 回到全量重写，或
`git checkout rewrite-ui -- <某个文件>` 把单个文件取回来。

## 1. 留下了什么

### ① 导航壳层

- **≥840dp 用左侧 80dp 的导航栏（rail），以下仍是原来的浮动岛底部条**。两者是同一个
  840px 媒体查询下的 `display` 切换，不依赖 JS。实测：839 / 840 两档的 display 与
  内容区 `padding-inline-start: 80px` 都正确。
- **顶部 64px 横条删除**，连带 `--m3-navbar-height`、`.m3-navbar`、`.m3-nav-pill`
  和 `Sidebar.tsx`。
- 连锁改动：`.scroll-pb-nav` 在 ≥840 时不再留任何上下内边距；`App.tsx` 改为渲染
  `<AppShell>`，并把「当前视图属于哪个目的地」的映射收在一处（MCP 设置页原本在顶部栏
  算 Settings、在底部条算 Account，现在统一为 Account）。
- 取自重写：`ui/NavigationRail.tsx`、`ui/NavigationBar.tsx`、`ui/AppShell.tsx` 及其 CSS。

### ④ 动画更新

- **`ui/Tooltip.tsx`**：锚定触发器的浮层，hover 与键盘 focus 都出现，
  150ms `--ease-out`，`transform-origin` 指向触发元素。替换原来只靠 `title` 属性的
  做法（触屏看不到、也无法样式化）。
  实际转换只有两处，因为**回退后的旧代码里本来就没几个 `title`**：首页估读卡右上角的
  信息按钮（顺带补上原来缺的 `aria-label`），以及 PK 参数页那个「已修改」小圆点。
  首页的分享按钮保留 `title`（它有可见文字和 `aria-label`，不是图标独占控件）。
- **`ui/Progress.tsx`**：规范的进度指示器（圆形不确定态 / 线性可定量）。替换到处在用的
  `Loader2 + animate-spin`。旋转用 `linear`（常量运动），弧长用 `--ease-in-out`。
- **对话框出场动画**：这批旧模态原本 `if (!isOpen) return null`，进得来出不去——
  `index.css` 里 `[data-state="closed"]` 的退场关键帧从来没机会跑。现在它们接上
  `usePresence` 并带上 `data-state`，关门会有 200ms 的退场；`prefers-reduced-motion`
  下 `usePresence` 直接跳过等待。
- 三处组件的 CSS 都在 `index.css` 的「KEPT FROM THE REWRITE」注释块里，reduced-motion
  与动画写在同一块。

## 2. 退回了什么

- **其余 20 个组件**（Button / Card / Dialog / ListItem / Stack / PageContainer /
  TopAppBar / Grid / SupportingPane / …）以及 `ui/index.ts` 的桶文件。
- **21 个页面的版式**：回到各页自己写 `max-w-2xl` / `px-6` 的旧样子，
  `PageContainer` 的统一宽度约束（672 / 1040 / 1280）随之取消。
- **`--ui-scale` 恢复**：大屏再次等比放大根字号（这轮用户没有选它，所以它属于「旧 UI」）。
- **图标迁移回退**：`src/icons/compat.ts`（31 个冻结的 lucide 路径）与
  `icons/custom.ts`、`components/CalibrationCurveIcon.tsx`、
  `scripts/gen-compat-icons.mjs` 都回来了。**这与「所有小图标一律用 reicon」那条指令
  相反**——回退指令说的是「除 ①④ 之外全部回退」，图标不属于 ①④，所以照做。要重新
  迁回 reicon，见 `git show rewrite-ui:src/icons/index.ts`（那份文件只从 reicon 再导出，
  并列出 20 处名字映射）。

## 3. 已知的取舍

- **各页顶部在桌面端会比旧版紧 64px**（旧版的 64px 是给顶部栏让位的，现在没有栏要躲）。
  这是去掉顶部栏的必然结果，不是遗漏。
- **`History.tsx` 的日期分组标签**原本写死 `sticky top-[94px]`。这轮实测页头
  （`sticky top-0`，现在真的贴 0）高 **102px @390/840、112px @1440**，原来的 94px
  其实压在页头里面——在旧版也是。已改成 `top-[6.375rem]`（页头高度用 rem 表达），
  这样它会跟着 `--ui-scale` 一起缩放，两种宽度都对得上。
- **图标是手搓的那一套**（见 §2）。要重新迁回 reicon，最省事的做法是
  `git show rewrite-ui:src/icons/index.ts > src/icons/index.ts` 然后把
  `src/icons/compat.ts`、`src/icons/custom.ts` 与 `CalibrationCurveIcon.tsx` 删掉
  ——那份文件的注释里就有 20 处名字映射。
