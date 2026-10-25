# Kira HRT Tracker: 药代动力学模型文献溯源与现代标定白皮书
*(Pharmacokinetic Literature Anchors & Modern Calibration Reference)*

> **历史文档（2026-10-26 注）：** 这是文献与参数溯源笔记，不是当前模型的验收证明。当前产品有两套可切换引擎、背景 E2 校准、`analyte`/unknown 化验路由；后续审计确认部分 F/V/ka/ke 不能被单条曲线唯一识别，文中“唯一基准/黄金基准”等表述不应作为临床或数值保证。当前行为见 README 与 `research/pk-continuation-20261025-2324/`。

---

## 1. 概述与核心改进

本项目药代动力学（PK）算法以 @LaoZhong-Mihari 的解析三室模型（`PKcore.swift`）为初始基准。为了解决临床实践与用户实测中暴露的一系列动力学偏离问题，我们在保留经典模型的同时，构建了**2026 现代文献校准模型（Literature 2026 Standard）**，并在工程上实现了**制剂载体解耦（Vehicle Decoupling）**。

本次重构重点解决了以下四大历史缺陷：
1. **舌下含服（Sublingual）峰值虚高（Issue #22）**：老版模型 2 mg / 55 kg 预测峰值达 ~1400 pg/mL，现通过引入黏膜独立快速清除相与 LC-MS/MS 质谱校准，修正至真实的 **~660 pg/mL**（约 40 分钟达峰，2h 降至 ~310 pg/mL，4h 降至 ~78 pg/mL）。
2. **口服（Oral）在两次给药间跌至接近 0**：引入吸收受限的 Flip-flop 动力学（$k_{abs} = 0.045\text{ h}^{-1}$），等效表征体内硫酸雌酮储库（Estrone Sulfate Pool）的缓释作用，表观半衰期达 $15.4\text{ h}$，消除谷值归零缺陷。
3. **注射生成分数超出 100% 的物理不守恒**：老版模型中 EC 与 EN 生成分数换算后绝对生物利用度超过 100%，现基于 Oriowo 1980 头对头试验统一将 EB、EV、EC、EN 形成分数定标为 **$0.078$**（对应真实入血暴露率 78%）。
4. **环戊丙酸雌二醇（EC）制剂载体解耦**：区分**油溶液（Oil，如 Depo-Estradiol，第 3.8~4 天达峰）**与**微晶水混悬液（Aqueous，如 Cyclofem 避孕针，第 1.5 天达峰）**，避免竞品在非此即彼间反复 Revert 的缺陷。

---

## 2. 药代动力学参数与文献溯源

### 2.1 舌下含服（Sublingual E2）

* **传统模型的失真原因**：
  * 早年支持高黏膜吸收率 $\theta$ 的文献（Price 1997、Burnier 1981）采用老式**放射免疫分析法（RIA）**测定。RIA 因抗体交叉反应，实测浓度高估可达 68% 以上。
  * 原模型让黏膜入血相直接复用了全身消除常数（$k_3 = 0.41\text{ h}^{-1}$），导致吸收后数小时血药浓度无法回落，波形严重变宽变钝。
* **现代文献锚点（LC-MS/MS 质谱测定）**：
  * **Doll et al. 2022 (PMID 34781041)**：10 名跨性别女性含服 1 mg 单剂 E2，实测 $C_{\max} = 144 \pm 90\text{ pg/mL}$。受试者平均 BMI 为 33（均重近 100 kg），校正体重后反推真实黏膜入血分数 $\theta \approx 0.06\sim0.08$。
  * **Casper & Yen 1981 (PMID 7454177)**：30~45 分钟即采血，实测 2 mg 舌下峰值为 $380\sim630\text{ pg/mL}$。
  * **Cirrincione et al. 2021 (PMID 33306447)**：54 名跨性别女性在稳态含服（6 mg/天分三次）下，LC-MS/MS 实测稳态中位数为 $154\text{ pg/mL}$。
* **重构后动力学方程**：
  * **黏膜吸收支（Fast Limb）**：吸收速率 $k_{a,SL} = 1.8\text{ h}^{-1}$，独立快速清除率 **$k_{elim,SL} = 1.2\text{ h}^{-1}$**（模拟静脉快速分布相），标准档 $\theta = 0.08$。
  * **吞咽慢支（Slow Limb）**：未通过黏膜吸收的药量（$1-\theta \approx 92\%$）随唾液吞下，走口服慢吸收途径（$k_{abs} = 0.045\text{ h}^{-1}$，全身消除 $0.41\text{ h}^{-1}$），并附加 **$0.4\%$ 的循环补偿**（`sublingualRecyclingShare = 0.004`），防止 8h 后的曲线尾部反常低于纯口服。

---

### 2.2 口服雌二醇与戊酸雌二醇（Oral E2 & EV）

* **传统模型的失真原因**：
  * 原版模型将口服吸收速率设为 $k_{abs} = 0.32\text{ h}^{-1}$（半衰期约 2.2h），导致单次给药在 12h 后几乎全部分解排出，单日给药谷值跌至接近 0。
* **临床生理机制**：
  * 口服微粉化 E2 与 EV 经胃肠道与肝脏首过代谢后，绝大部分转化为硫酸雌酮（$\text{E}_1\text{S}$）池。该池容量巨大，并在体内缓慢水解释回 E2，使口服 E2 展现出长达 $13\sim20\text{ h}$ 的表观消除半衰期（Kuhnz 1993, Price 1997, Cattani 2023, Aedo 1990）。
* **重构后动力学方程（Flip-flop Kinetics）**：
  * 采用吸收受限的 Flip-flop 动力学，设 **$k_{abs} = 0.045\text{ h}^{-1}$**（表观半衰期 $15.4\text{ h}$，单剂达峰约在 6h，日蓄积倍数约 1.6 倍，吻合 Aedo 1990 测得的 1.53 倍与 Stadberg 1999 的 1.4~1.6 倍）。
  * 真实生物利用度定标为 **$F = 0.030$**（3%）。口服 2 mg 一次，24h 谷值平稳保持在 $17\sim20\text{ pg/mL}$，彻底解决谷值跌零缺陷。
  * 口服戊酸雌二醇（EV）在吸收过程中即迅速脱酯（Timmer 1999, Wiegratz 2001, Düsterberg 1985），统一按等效 E2 剂量与上述参数处理。

---

### 2.3 注射酯类物理守恒与环戊丙酸（EC）载体解耦

#### (1) 注射形成分数统一（$ff = 0.078$）
* **物理守恒律**：注射清除常数定义为 $k_{clearInj} = k_{clear} / 10 = 0.041\text{ h}^{-1}$。根据药动学积分公式，入血的有效剂量比例为 $10 \times ff$。
* **原版漏洞**：原版 EC ($0.1173$) 和 EN ($0.120$) 乘以 10 后，有效入血率达 117% 和 120%，物理上违背质量守恒。
* **修正方案**：参考 Oriowo et al. 1980（EB、EV、EC 在同组人群与分析法下的单剂头对头试验，相对暴露量在 7% 内吻合）、Zhou 1998 与 Schiavon 1988，统一将 **EB、EV、EC、EN 形成分数设为 $0.078$**（对应真实入血暴露率 78%，严格满足 $10 \times ff \le 1.0$）。

#### (2) 环戊丙酸雌二醇（EC）载体解耦
* **油溶液（Oil Vehicle，默认）**：
  * **应用场景**：Depo-Estradiol、商业棉籽油/花生油注射液、绝大多数自配油剂。
  * **释放参数**：`Frac_fast = 0.22916, k1_fast = 0.005035, k1_slow = 0.00451`。
  * **临床特征**：吸收平缓，单次 5 mg / 70 kg 注射峰值约在 **第 3.8 ~ 4.0 天**（约 90 小时，Oriowo 1980, Aly 2020），峰值约为 $140\sim170\text{ pg/mL}$。
* **微晶水混悬液（Aqueous Suspension）**：
  * **应用场景**：拉美与部分亚洲地区使用的月经避孕复方针剂（如 Cyclofem / Lunelle / Mesigyna，含 EC 5mg + MPA 25mg）。
  * **释放参数**：`Frac_fast = 0.15, k1_fast = 0.08, k1_slow = 0.0035`。
  * **临床特征**：因微晶颗粒直接暴露于组织液，释放极快，单次 5 mg / 70 kg 注射峰值出现在 **第 1.5 ~ 2.0 天**（约 36~50 小时，Zhou 1998, Rahimy 1999），峰值约为 $240\sim290\text{ pg/mL}$。

---

### 2.4 凝胶与贴片（Gel & Patch）

* **经皮凝胶（Gel）**：
  * 吸收常数由原版缓慢的 $0.0193\text{ h}^{-1}$（36h 吸收半衰期）提高到 **$k_1 = 0.04\text{ h}^{-1}$**。
  * 基准生物利用度调整为 **$F_{\max} = 0.060$**（参考 Oestrogel 英国说明书 1.5 mg/天达 76.8 pg/mL，以及 Maggacis et al. 2025 年墨尔本 81 例跨性别成人实测中位数 77.6 pg/mL）。给药后 4~6 小时达峰，第 3 天平稳到达稳态。
* **贴片按总含量输入（Patch Fallback）**：
  * 针对日本 Estrana 贴片（按总含药量 0.72 mg 标定），吸收常数从 $0.0075$ 下调为 **$k_1 = 0.0035\text{ h}^{-1}$**，使 55 kg 下稳态读数平稳落在 $48\sim54\text{ pg/mL}$，完全贴合说明书实测（$52\sim60\text{ pg/mL}$）。

---

## 3. 黄金基准锁定与老版缺陷参数废止

经充分的现代文献、串联质谱（LC-MS/MS）与临床头对头试验验证，老版 LaoZhong-Mihari 模型存在的**舌下 1400 pg/mL 虚高**、**口服 12h 骤降至零**以及**注射形成分数超过 100% 违背质量守恒**等硬伤已获得完全确证。

为杜绝任何用户因误用历史缺陷参数而导致用药剂量决策失误，项目作出以下不可动摇的工程与医学决策：
* **`DEFAULT_PK_PARAMS` 作为全系统唯一基准**：直接搭载 2026 现代文献质谱校准参数；
* **全面废止切换回老版模型**：UI 与底层 API 均不再提供“切回 LaoZhong 经典原版”的选项，彻底确保用户用药安全与学术严肃性。

---

## 4. 临床浓度状态评估分级（与上游 Oyama/LaoZhong 的关键差异）

在界面展示与血药浓度状态判定上，本项目彻底重构了上游的判断逻辑：

### 4.1 上游实现的严重漏洞与临床不合理性
* **上游缺陷 1：阈值硬编码导致断层断裂**
  上游原版代码在判定中写道：
  `if (conc >= 100 && conc <= 200) return 'status.level.mtf';` 之后紧跟 `if (conc >= 70 && conc <= 300) return 'status.level.luteal';`。
  由于前者优先匹配，导致 `70 ~ 300` 实际被割裂为两段：`70 ~ 99 pg/mL`（偏低）与 `201 ~ 300 pg/mL`（理想高位）。**这两个生理意义截然不同的区间，全被粗暴地标上了黄色的“女性黄体期”报警**。例如用户测出 202 pg/mL 时，仅因比 200 高出 2 个点，徽章就从绿色达标突变为黄色警示，造成严重的无端焦虑。
* **上游缺陷 2：忽略针剂动力学，用单一非针剂标准卡死所有用户**
  上游在多语言字典中明明白白将 `status.level.mtf` 翻译为“非针剂女性向目标”（Non-injection target），说明开发者明知该范围仅适用于口服/经皮；但在业务逻辑代码中，却完全缺失了对针剂（注射）的判定分支。

### 4.2 本项目的双轨自适应判定方案
本项目在 `src/hooks/useAppData.ts` 与 `ResultChart.tsx` 中引入给药途径自适应检测（**严格根据用户近期实际打卡日志 `events` 进行事实判定，以最新一次给药途径为主导；若有混合给药，则根据对应注射酯类的药理储库蓄积期动态判定：EB ~5天、EV ~12天、EC/EN/TC/TE ~21天、EU ~60天、TU ~84天，杜绝机械写死静态天数**），按以下临床循证标准分轨判定：

1. **针剂用户（注射：EV、EC、EN、EB、EU）**：
   * 注射具有显著的达峰与衰减波动（UCLA 2025 证实周平均浓度约 248 pg/mL，中段稳定在 200~350 pg/mL，前 1~2 天常规峰值达 400~550 pg/mL）；
   * **400 ~ 550 pg/mL**：判定为 **✅ 针剂早期达峰（绿标 ok）**；
   * **200 ~ 400 pg/mL**（包含 202 pg/mL）：判定为 **✅ 针剂周期理想水平（绿标 ok）**；
   * **100 ~ 200 pg/mL**：判定为 **✅ 针剂周期末目标谷值（绿标 ok）**；
   * **50 ~ 100 pg/mL**：判定为 **⚠️ 谷值偏低（黄标 warn）**；
   * **> 550 pg/mL**：判定为 **⚠️ 高于针剂推荐范围（黄标 warn）**。
2. **非针剂用户（口服、含服、凝胶、贴片）**：
   * **100 ~ 250 pg/mL**（包含 202 pg/mL）：判定为 **✅ 女性化目标范围（绿标 ok）**（WPATH SOC8 与内分泌学会推荐的安全有效黄金区间）；
   * **250 ~ 350 pg/mL**：判定为 **⚠️ 生理高位水平 (排卵期范围)（黄标 warn）**（提示用户该浓度在稳态吃药/涂凝胶下已偏高，接近顺女排卵期激增峰，但未达危险线）；
   * **> 350 pg/mL**：判定为 **⚠️ 高于参考范围（黄标 warn）**（提示剂量可能过大或刚刚含服处于尖峰相）；
   * **50 ~ 100 pg/mL**：判定为 **⚠️ 偏低水平（黄标 warn）**；
   * 彻底废除跨女用药中生搬硬套的顺女“黄体期/卵泡期”名词，代之以严谨清晰的临床目标状态提示。

---

## 5. 参考文献 (Selected References)

1. **Doll E, et al.** Pharmacokinetics of sublingual versus oral estradiol in transgender women. *Endocr Pract.* 2022;28(3):237–242.
2. **Casper RF, Yen SSC.** Rapid absorption of micronized estradiol-17β following sublingual administration. *Obstet Gynecol.* 1981;57(1):62–64.
3. **Cirrincione LR, et al.** Sublingual estradiol is associated with higher estrone concentrations than transdermal or injectable preparations in transgender women. *LGBT Health.* 2021;8(2):125–132.
4. **Oriowo MA, et al.** A comparison of the pharmacokinetic properties of three estradiol esters. *Contraception.* 1980;21(4):415–424.
5. **Zhou XF, et al.** Pharmacokinetics of medroxyprogesterone acetate after single and multiple injection of Cyclofem in Chinese women. *Contraception.* 1998;57(6):405–411.
6. **Rahimy MH, et al.** Lunelle monthly contraceptive injection: steady-state pharmacokinetics of MPA and E2 in surgically sterile women. *Contraception.* 1999;60(4):209–214.
7. **Kuhnz W, et al.** Pharmacokinetics of estradiol, free and total estrone, in young women following single intravenous and oral administration. *Arzneimittelforschung.* 1993;43(9):966–973.
8. **Cattani VB, et al.** Estradiol and spironolactone plasma pharmacokinetics among Brazilian transgender women. *Clin Pharmacokinet.* 2023;62(7):1031–1041.
9. **Aedo AR, et al.** Pharmacokinetics and biotransformation of orally administered oestrone sulphate and oestradiol valerate in postmenopausal women. *Maturitas.* 1990;12(4):333–343.
10. **Maggacis, Cheung AS, Nolan BJ.** Estradiol concentrations with transdermal estradiol gel in trans and gender-diverse adults. *Clin Endocrinol (Oxf).* 2025.
