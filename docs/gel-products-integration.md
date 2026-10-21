# 自定义凝胶产品 — 前端接入说明

> 状态：**数据层与服务端已完成，界面未动**（按约定，UI 重构结束后由前端接入）。
> 相关提交范围内的文件在文末列出。

---

## 1. 现在是什么行为

- 自定义凝胶产品（`gelProductId ≥ 1000`）**不再被丢弃**：导入 Transmtf 备份时会收编，随账户同步，并在 Transmtf 引擎里参与计算。
- 之前的行为：目录被丢弃 → 记录里的 id 找不到 → 引擎静默回落到第一个预设（Oestrogel），曲线是错的且不报错。
- 目前界面上**看不到、也选不到**自定义产品——这正是需要前端补的部分。

---

## 2. 数据模型

```ts
interface GelProduct {
  id: number;              // ≥ 1000；1–5 是内置预设，永不被覆盖
  name: string;            // 用户可见名称，非空
  concentrationMGmL: number; // mg/mL（0.06% = 0.6）
  defaultAreaCM2: number;    // 标签涂抹面积
  refDoseMG: number;         // 动力学参考剂量
  kPenBase: number;          // 三个速率常数，必须有限
  kLoss: number;
  kRel: number;
  color?: string;
}
```

- 校验的唯一权威是引擎的 `sanitizeGelProducts`（`src/pk/vendor/pk.ts`）：缺 `kPenBase/kLoss/kRel` 中任意一个 → 整条丢弃；数值超范围 → 夹取；`id < 1000` → 丢弃。
- 前端不要自己复制这套规则（会漂移）；存储层只做最小结构检查（有 id、有非空 name）。

---

## 3. 存储与同步（已完成）

| 项 | 值 |
|---|---|
| 本地存储键 | `app-gel-products`（JSON 数组） |
| 同步载体 | 应用设置包 `appState.settings.gelProducts` |
| 同步性质 | 每账户、密封（sealed），与 `pkEngine` 同一条路 |
| 服务端明文列 | **不写入**——只存在于密封包里，数据库 dump 看不到 |
| MCP 读取 | `hrt_get_settings` 的 `appState.settings.gelProducts` |
| 合并规则 | 整个数组替换（不是逐项合并），由设置包的整包时间戳决定胜负 |

`readAppSettings()` / `applyAppSettings()` 已支持该字段：读取时带出（**空目录也会带 `[]`**，否则服务端的按键合并会保留旧列表，删掉的产品会复活）、采纳时写回并广播 `gel-products-changed`。

---

## 4. 客户端数据层 API

文件：`src/utils/gelProducts.ts`

| API | 说明 |
|---|---|
| `readGelProducts(): GelProduct[]` | 读当前目录（损坏/空 → `[]`） |
| `writeGelProducts(list)` | 整表替换；写存储并广播变更事件 |
| `nextGelProductId(list)` | 最大 id + 1（从 1000 起，**不补空洞**） |
| `importGelProducts(incoming, existing?)` | 导入合并：同 id 覆盖；非法条目计数返回 `{added, updated, rejected}` |
| `gelProductUsage(events, id)` | 有多少条给药记录引用该 id —— 删除确认用 |
| `GEL_PRODUCTS_EVENT` | `'gel-products-changed'`，写入后广播 |

引擎接线（已完成，前端无需调用）：
`src/engine/registry.ts` 在加载 Transmtf 引擎时读一次目录，之后监听 `GEL_PRODUCTS_EVENT` 实时推送。
服务端在 `hrt_predict_levels` 内用 `withGelProductCatalogue()` 做**同步作用域**安装/还原（`server/src/core.ts`）。

因此：**`writeGelProducts()` 之后，下一次重算就是新参数**，不需要手动刷新引擎，也不会回溯改动任何记录字段。

---

## 5. 导入链路（已完成）

- `convertForeignPayload()` 不再剥离 `gelProducts`，而是通过 `ConvertResult.gelProducts` 单独返回；`payload` 仍然干净（记录合并不用知道产品）。
- `App.tsx` 在记录合并成功后调用 `importGelProducts()`，并提示 “已收编 N 个自定义凝胶产品”。
- 非法条目（缺速率常数、id < 1000）会被丢弃并计数，不阻断记录导入。

---

## 6. 前端待办（UI 重构后接入）

### 6.1 算法设置页管理面板

- 位置：`src/pages/PKParams.tsx`，**“编辑参数”区块上方**，仅当 `engine === 'transmtf'` 时渲染（内置引擎不读产品）。
- 建议形态：`SegmentedList` 一行一个产品（名称 + 浓度 + 默认面积），行尾编辑/删除；底部“新增产品”。
- 字段顺序建议：名称 → 浓度 mg/mL → 默认面积 cm² → 参考剂量 mg → 三个速率常数（高级折叠）→ 颜色（可选）。
- 空状态：说明“没有自定义产品时，凝胶记录只能用内置的 5 个预设”。

### 6.2 新增用药的产品选择器

- 文件：`src/components/dose_form/GelFields.tsx`。
- 当前 `GEL_PRODUCT_OPTIONS`（`logic.ts`）只有 5 个预设；需要把 `readGelProducts()` 追加到 chip 列表末尾，选中时写入 `Extras.gelProductId = product.id`。
- 数组可能较长：超过 ~6 个时建议换成下拉/抽屉，而不是继续加 chip。

### 6.3 删除前的引用提示

```ts
const used = gelProductUsage(events, product.id);
if (used > 0) {
  // 提示：有 {used} 条记录仍指向该产品；删除后这些记录会按 Oestrogel 计算。
}
```

删除本身不删记录：记录保留 id、剂量、部位与面积，只是 id 解析不到 → 回落预设。**这是静默的**，所以提示必须存在。

### 6.4 编辑的影响面

产品参数在模拟时解析，编辑会**回溯改变所有引用该产品的历史曲线**。建议在编辑保存时给一句说明（不是警告，因为这是预期行为）。

---

## 7. 边界与已知坑

1. `id < 1000` 的导入条目会被拒绝，不会重新编号——重新编号会把记录挂到用户没用过的产品上。
2. 引用被删产品的记录会静默回落 Oestrogel（引擎行为，已写入测试）。
3. `concentrationMGmL` 的单位是 **mg/mL**，不是百分比：0.1% = 1.0。
4. 内置引擎完全不读产品：切换引擎后同一凝胶记录的曲线会变，这是两个模型的差异，不是数据丢失。
5. 分享链接的快照曲线由**客户端**计算后上传，所以自定义产品在分享页也正确——前提是分享时目录在本地（同步已保证）。
6. 目录是账户级、整包同步：两台设备同时改，较新的整包获胜，可能覆盖另一台的单个产品（与主题/语言同一规则）。

---

## 8. 服务端与 MCP

- `hrt_predict_levels`：从密封设置包读 `gelProducts`，在 `withGelProductCatalogue()` 作用域内跑 `simulate` 与 `calibrate`。
- `hrt_get_settings`：`appState.settings.gelProducts` 原样可读；工具描述已说明“id ≥ 1000 是账户自己的产品、找不到会回落 Oestrogel”。
- 自定义产品**不能**通过 MCP 写入（与 `pkEngine` 同策略：会重算全部历史）。

---

## 9. 测试

| 文件 | 覆盖 |
|---|---|
| `server/test/gelProducts.test.ts` | 目录改变曲线；无目录时回落预设；作用域还原；连续两次目录互不污染 |
| `server/test/pkEngine.test.ts` | 引擎选择、螺内酯跳过、两引擎曲线必须不同 |

运行（仓库根目录）：

```powershell
cd server
node --experimental-transform-types --import ./resolve-hook.mjs --test test/gelProducts.test.ts test/pkEngine.test.ts
```

类型检查：

```powershell
npx tsc --noEmit -p tsconfig.json        # 前端
cd server; npx tsc --noEmit -p tsconfig.json   # 服务端
```

---

## 10. 改动文件清单

**客户端数据层**

- `src/utils/gelProducts.ts`（新增）
- `src/utils/appSettings.ts`（读取/采纳 `gelProducts`，稳定比较避免反复重打时间戳）
- `src/utils/syncMerge.ts`（`AppSettings.gelProducts`、白名单、数组透传）
- `src/utils/foreignImport.ts`（不再丢弃，改为返回）
- `src/App.tsx`（导入后合并目录 + 提示文案）
- `src/engine/registry.ts`（引擎加载/变更时推送目录）
- `src/pk/index.ts`（`setGelProductCatalogue` / `withGelProductCatalogue`）
- `src/i18n/langs/*.ts`（`import.gel_products_imported` 替换原 `import.skipped_gel_products`，7 语言）

**服务端**

- `server/src/engine.ts`（转发 `withGelProductCatalogue`，新增 `gelProductsOf`）
- `server/src/core.ts`（在 `predict` 的 simulate/calibrate 作用域内安装目录）
- `server/src/mcp.ts`（`hrt_get_settings` 描述补充）
- `server/test/gelProducts.test.ts`（新增）
- `server/test/pkEngine.test.ts`（`byCompound` 断言改为类型安全写法）
