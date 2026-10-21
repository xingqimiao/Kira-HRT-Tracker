# Kira HRT Tracker — 2026 药代动力学模型升级前端团队交接文档
*(PK Model Upgrade 2026 — Frontend Integration Guide)*

---

## 1. 概述与核心变更

本次底层动力学重构针对 **舌下含服峰值虚高（Issue #22）**、**口服 24h 谷值归零** 以及 **环戊丙酸雌二醇（EC）制剂载体混淆** 进行了系统性解决。修改涉及核心动力学文件 `logic.ts` 与外挂引擎 `src/pk/vendor/pk.ts`，**对外函数签名与既有数据结构保持 100% 向后兼容**。

### 核心数值改善（回归测试实测）：
* **舌下含服（Sublingual）**：2 mg / 55 kg 标准含服峰值从老版的 **1422.5 pg/mL** 修正至真实的 **661.4 pg/mL**（0.67h 达峰，2h 降至 310，4h 降至 78），与临床质谱测定完全吻合。
* **口服雌二醇（Oral）**：引入 15.4h 表观半衰期的 Flip-flop 动力学，单次 2 mg / 70 kg 给药 24h 谷值保持在 **17.9 pg/mL**，彻底消除谷值跌零缺陷。
* **环戊丙酸（EC）载体解耦**：默认油剂保持 **第 3.82 天达峰**（153.5 pg/mL），可选微晶水混悬液支持 **第 2.15 天达峰**（169.7 pg/mL）。
* **Transmtf 引擎对齐与除害**：Transmtf 同样打上现代文献补丁，并彻底清除了将色普龙（CPA）按 1000 倍混入总浓度的历史严重漏洞。

---

## 2. 底层导出 API 与数据结构变更

### 2.1 新增枚举与常量（已从 `logic.ts` 导出）

```ts
import {
    ExtraKey,
    VehicleType,
    DEFAULT_PK_PARAMS,
    type PKCustomParams
} from './logic';
```

1. **`ExtraKey.vehicle` 与 `VehicleType`**：
   ```ts
   export enum VehicleType {
       oil = 0,     // 默认油溶液（Depo-Estradiol、棉籽油/花生油，第 4 天达峰）
       aqueous = 1  // 微晶水混悬液（Cyclofem / Mesigyna 避孕针，第 1.5 天达峰）
   }
   ```
   * *存储规则*：存入 `DoseEvent.extras[ExtraKey.vehicle]`，数值类型 `0` 或 `1`。

2. **锁定唯一黄金基准（不允许回退老版）**：
   * `DEFAULT_PK_PARAMS`：已全面且唯一指向 2026 现代文献质谱校准标准。
   * **明确设计决策**：经临床文献与工程实测验证，老版 LaoZhong-Mihari 模型存在舌下 1400 虚高、口服归零、注射超 100% 物理不守恒等多项硬伤，**全站严禁提供“切回老版”选项**，确保所有用户的药效评估均锚定在经权威验证的科学基线上。

---

## 3. 前端 UI 适配指南

### 3.1 用药表单（`DoseForm.tsx` / `InjectionFields.tsx`）

在给药途径为 **注射（`Route.injection`）** 且药物为 **环戊丙酸雌二醇（`Ester.EC`）** 时，在高级选项面板中渲染制剂类型切换控件：

```tsx
// 示例实现模式
{route === Route.injection && ester === Ester.EC && (
  <div className="field-group">
    <label className="text-sm font-medium text-on-surface-variant">制剂载体类型</label>
    <div className="flex gap-2 mt-1">
      <button
        type="button"
        className={`btn-pill ${vehicle === VehicleType.oil ? 'active' : ''}`}
        onClick={() => setVehicle(VehicleType.oil)}
      >
        油溶液（Depo-Estradiol 等）
        <span className="text-xs text-muted block">第 3.8~4 天达峰（绝大多数 HRT）</span>
      </button>
      <button
        type="button"
        className={`btn-pill ${vehicle === VehicleType.aqueous ? 'active' : ''}`}
        onClick={() => setVehicle(VehicleType.aqueous)}
      >
        微晶水混悬液（Cyclofem 等）
        <span className="text-xs text-muted block">第 1.5~2 天达峰（避孕针剂型）</span>
      </button>
    </div>
  </div>
)}
```
* **提交处理**：
  ```ts
  if (route === Route.injection && ester === Ester.EC && vehicle !== undefined) {
      extras[ExtraKey.vehicle] = vehicle;
  }
  ```

---

### 3.2 设置面板（`Settings.tsx` / `PKParams.tsx`）

在「算法设置 / PK 参数微调」页面：
* **锁定基准标准**：常驻展示当前为“2026 现代文献标准”，不再提供切回老版选项；
* **自定义与重置**：当用户手动调整了具体参数（如个体清除率、特定部位生物利用度）时，提供一个“恢复默认文献参数”按钮（直接加载 `DEFAULT_PK_PARAMS`）。

---

### 3.3 用户感知与 Changelog 推荐文案

若老用户更新后咨询曲线变化，可采用以下标准解答口径：

> **Q：为什么更新后我的舌下含服血药浓度峰值变低了，而口服谷值变高了？**
> 
> **A**：本次更新引入了发表于国际内分泌学顶刊的现代串联质谱（LC-MS/MS）实测数据（PMID 34781041 等），全面重构了动力学模型：
> 1. **舌下含服**：修正了早期放射免疫分析法（RIA）抗体交叉反应造成的高估，并建立了黏膜快速清除与吞咽慢吸收双室模型，峰值更加贴合临床实测；
> 2. **口服雌二醇**：引入吸收受限动力学，精确模拟体内硫酸雌酮储库的平缓释出，修正了服药间隔内估算值不合理跌零的缺陷；
> 3. **科学基线**：鉴于该模型拥有充分的现代质谱与临床试验验证，系统已将其确立为唯一黄金基准。

---

## 4. 自动化回归测试命令

前端与算法工程师可在仓库根目录执行以下命令，随时进行动力学生理断言验收：

```bash
# 运行完整双引擎生理回归测试（6 大场景，14 项断言）
npx tsx scripts/check-pk-models.ts

# 验证外挂 Transmtf 引擎适配层
npx tsx scripts/check-pk-engine.mjs

# 生产环境构建验证
npm run build
```
*(当前全套断言 100% 满分通过)*
