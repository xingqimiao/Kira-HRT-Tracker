# Monitoring reference for CPA, spironolactone and bicalutamide

Research note for a personal HRT tracker. Purpose: replace a blood-concentration / PK curve for
these three anti-androgens with **monitoring and adherence tracking**. Facts and citations only —
no UI copy, no code.

**Scope.** Cyproterone acetate (CPA), spironolactone, bicalutamide. All three act at the androgen
receptor or by gonadal suppression rather than by a plasma level the user can titrate, so the
monitoring question is "what do we sample, how often, and what value triggers what action".

**Source families.**

* **W** — MtF.wiki (the source the user cited). Primary. Quoted in Chinese with translation.
* **C** — clinical/regulatory guidance found via Anysearch: FDA label, Endocrine Society
  recommendation (as reported by a peer-reviewed study), SfE position statement, MHRA/Medsafe,
  and two 2021–2025 peer-reviewed studies.

Both are cited per row. Where they disagree, both are given; nothing is silently chosen.

---

## 1. Cyproterone acetate (CPA)

### 1.1 What to test, and how often

| Test | Interval | Threshold / target | Action triggered | Source |
|---|---|---|---|---|
| Serum transaminases (ALT/AST) | **Before starting**, then **every 3 months**; **monthly during the first 6 months** | Reference range varies by lab — "以实际报告单所示为准" (per the actual report) | If abnormal: re-consider dose, treat the abnormality, monitor closely until normal | W — *监测 §怎么查、何时查*, *§肝功能 (LFT)* |
| Liver function (general) | Before start; during the first 6 months "格外留意" (pay particular attention) | not stated | — | W — *监测 §怎么查、何时查* |
| Prolactin (PRL) | "定期检查" — periodic; **no numeric interval stated** | **>3× the normal value** (upper limit of normal) is the action point | Closely observe; consider **reducing the estrogen/progestogen dose**, **switching drug**, or **working up prolactinoma (repeat brain MRI)** | W — *监测 §泌乳素 (PRL)*, *§看什么、怎么看* |
| Prolactin, dose relation | periodic | Rises with CPA dose; "可明显增加泌乳素水平，且随剂量上升" | Severe cases can cause prolactinoma; CPA page: "超标时可考虑减少用量" (when over the limit, consider reducing the dose) | W — *抗雄药物/色普龙 §副作用* |
| Testosterone (T) | With the sex-hormone panel, near the next dose | Female range 0.1–0.55 ng/mL; CPA should put T "near the normal female range"; need not go below 0.55 ng/mL | If T is too low, consider **reducing** the dose | W — *监测 §睾酮 (T)*, *§看什么、怎么看* |
| FSH | With the panel | Should be **below** the normal range on CPA; CPA can drive it below the detection limit | Not stated as an action item (it is a suppression confirmation) | W — *监测 §促卵泡激素 (FSH)*, *§看什么、怎么看* |
| LH | With the panel | Should be **below** the normal range on CPA; can fall below detection limit | Same as FSH | W — *监测 §黄体生成素 (LH)*, *§看什么、怎么看* |
| Fasting glucose / insulin, and HbA1c | "酌情" (as appropriate) | not stated | CPA may raise insulin resistance and blood glucose; in diabetes, antidiabetic/insulin requirements may change | W — *监测 §怎么查、何时查*, *抗雄药物/色普龙 §副作用* |
| Fasting lipids (LDL-C, triglycerides) | "酌情" | not stated | not stated as an action point | W — *监测 §怎么查、何时查* |
| CBC (red cells, platelets) | "酌情" | not stated | CPA can reduce red cell count; severe cases cause anemia | W — *监测 §怎么查、何时查* |
| Coagulation — PT/INR, **only if on a coumarin anticoagulant** | not stated | not stated | Closely monitor and adjust anticoagulant dose | FDA CASODEX label §5.2 (bicalutamide — see §3) |
| MRI | Triggered by cumulative dose, not calendar | See §1.2 | Stop CPA immediately if meningioma found | W — *监测 §怎么查、何时查*, *抗雄药物/色普龙 §副作用* |
| Vitamin B12 | not stated | not stated | CPA is recommended to be supplemented with B12 (deficiency linked to depression risk) | W — *抗雄药物/色普龙 §副作用, §使用方式与用量* |

### 1.2 Meningioma risk on CPA — dose-dependency and cumulative exposure

| Claim | Number | Source |
|---|---|---|
| The risk is stated to be **positively correlated with dose and duration** ("风险与剂量和使用时长正相关"); use the smallest dose possible; if cumulative dose is already large (**> 10 g**), an MRI is recommended | > 10 g cumulative | **W** — *抗雄药物/色普龙 §副作用* |
| Long-term, high-dose CPA → watch for meningioma; **if found, must stop the drug immediately** | no number | **W** — *监测 §怎么查、何时查* |
| Dose-dependent increased risk at **≥ 25 mg/day** | ≥ 25 mg/day | **C** — SfE, *Risk of Meningioma with Cyproterone Acetate* |
| **11-fold** higher dose-dependent risk at **36–60 g cumulative** vs **< 3 g** | 11× | **C** — SfE |
| Other large population studies (Denmark, Spain, EU pharmacovigilance) estimate **6–20 fold** | 6–20× | **C** — SfE |
| Adjusted hazard ratio for cumulative dose **> 60 g** was **21.7 (95% CI 10.8–43.5)** | HR 21.7 | **C** — Weill 2021, BMJ n37 / PubMed 33536184 |
| Hazard ratio **11.3** for **36–60 g**; **not significant below 12 g** | HR 11.3 / n.s. <12 g | **C** — Medscape summary of Weill 2021 |
| Educate patients with cumulative CPA exposure **≥ 10 g** about meningioma risk; **urgent MRI** if vision loss, hearing loss, anosmia, tinnitus, seizures or limb weakness | ≥ 10 g education; MRI on symptoms | **C** — SfE |
| CPA **contraindicated at any dose** with a history of meningioma; if meningioma is diagnosed, treatment **must be permanently stopped** | any dose / permanent stop | **C** — SfE; Medsafe/MHRA |
| Low-dose CPA 2 mg + 35 µg ethinylestradiol has so far not shown the same risk | 2 mg | **C** — SfE |

**Disagreement at the ~10 g line.** W says accumulate > 10 g → **do an MRI**. SfE says ≥ 10 g →
**educate the patient**, and reserves urgent MRI for *symptoms*. Same threshold, different action.
The app should surface both and not assume one.

### 1.3 CPA dosing facts that monitoring interacts with

| Claim | Value | Source |
|---|---|---|
| Suggested dose | 10–12.5 mg/day | W — *抗雄药物/色普龙 §使用方式与用量* |
| Once effective, reduce as far as possible | 5–6.25 mg/day; not below 5 mg/day (insufficient data) | W — same |
| Ultra-low regimen studied | 12.5 mg **twice weekly** (≈3.5 mg/day equivalent) still fully suppressed T | W — same |
| Tablets can be quartered | 12.5 mg per quarter, taken every 1–3 days | W — same |
| If T is still high at 10 mg/day | First check whether the estradiol level is high enough | W — same |
| Stopping | Must taper gradually ("停药时须逐步减药") | W — same |

---

## 2. Spironolactone

### 2.1 What to test, and how often

| Test | Interval | Threshold / target | Action triggered | Source |
|---|---|---|---|---|
| **Serum potassium (K)** | **Before starting**, then "定期" (periodic) — **no numeric interval given by W** | **K must be < 5.0 mmol/L before starting** | Contraindicated in hyperkalemia — "高钾血症患者切勿服用!" | W — *抗雄药物/螺内酯 §注意事项* |
| Potassium, per Endocrine Society | **Every 3 months for the first year after initiation, then annually** | not stated | Monitoring for hyperkalemia | **C** — Endocrine Society recommendation as reported in Hayes 2022, *J Endocr Soc*, PMC9562816 |
| Potassium — evidence against that frequency | — | 8/318 (2.5%) had hyperkalemia; **> 45 y: 8.9% vs ≤ 45 y: 1.5%, p = 0.016** | Authors suggest guidelines may be adjusted to reduce unnecessary testing in ≤ 45 y without comorbidities | **C** — Hayes 2022 |
| Potassium — creatinine condition | — | Snippet: frequent potassium measurement "might be unnecessary … in patients with serum creatinine levels of < 2" | (unit is not stated in the abstract snippet) | **C** — Gupta 2022, *Endocrine Practice*, S1530-891X(22)00595-X |
| **Creatinine** | with potassium, periodic | not stated | Renal function should be normal before starting | W — *抗雄药物/螺内酯 §注意事项* |
| **Uric acid** | with potassium and creatinine, periodic | not stated | not stated | W — *抗雄药物/螺内酯 §注意事项* |
| **Sodium (Na)** | "必要时应监测血钠" — when necessary | not stated | Caution with drugs affecting serum Na (tricyclics, SSRIs) | W — *抗雄药物/螺内酯 §副作用* |
| **Electrolytes panel ("离子六项")** — K, Na, Ca, Mg | closely monitor in those at risk | not stated | Spironolactone may affect K, Na, Ca, Mg; extra care when combined with other drugs affecting these ions | W — *监测 §怎么查、何时查* |
| **Serum lithium** — only if on lithium | "定期监测血锂" — periodic | not stated | — | W — *抗雄药物/螺内酯 §注意事项* |
| **Renal function** | "密切监测，直至肾功能恢复" — closely monitor until renal function recovers | not stated | Renal insufficiency: use spironolactone cautiously, it may worsen hyperkalemia | W — *监测 §怎么查、何时查* |
| **Testosterone (T)** | — | — | **Not useful.** "使用螺内酯片并不会显著降低睾酮水平，故此项的参考价值不大" — spironolactone does not significantly lower T, so this test has little reference value | W — *监测 §睾酮 (T)* |
| **Fasting lipids (esp. LDL-C)** | "酌情" | not stated | Spironolactone (and bicalutamide) may raise LDL | W — *监测 §怎么查、何时查* |
| **Liver function** | Before start, every 3 months | not stated | Caution in hepatic insufficiency (esp. cirrhosis) — may impair the nervous system and cause coma | W — *抗雄药物/螺内酯 §注意事项* |
| **Blood pressure / volume status** | — | not stated | Hypotension, hypovolemia listed as side effects | W — *抗雄药物/螺内酯 §副作用* |

### 2.2 Dosing frequency and food

| Claim | Value | Source |
|---|---|---|
| Route and dose | Oral. **100–400 mg/day, divided into several doses** ("分多次服用") | W — *抗雄药物/螺内酯 §使用方式与用量* |
| Food | **Avoid excess potassium-rich food** — bananas, kelp (seaweed), potassium-containing salt substitutes | W — *抗雄药物/螺内酯 §注意事项* |
| Fluid | **Drink more water** ("多喝水") | W — same |
| Drug combinations | **Do not take other potassium-sparing drugs**; avoid potassium supplements | W — same |
| Effect size caveat | Spironolactone itself does not lower T; its AR blockade is weak, needing large doses; testo may still be above the female range even with estradiol | W — *抗雄药物/螺内酯 §注意事项*, *§使用方式与用量* |
| Most serious side effect | **Hyperkalemia** — can cause hospitalisation or death | W — *抗雄药物/螺内酯 §副作用* |
| Hyperkalemia risk factors | **Age > 45**, renal insufficiency, other potassium-sparing drugs, potassium supplements | W — *抗雄药物/螺内酯 §副作用* |
| Not stated | Whether to take with food/with a meal — **not stated in the sources I checked** | — |

---

## 3. Bicalutamide

### 3.1 What to test, and how often

| Test | Interval | Threshold / target | Action triggered | Source |
|---|---|---|---|---|
| **Serum transaminases (ALT/AST)** | **Before starting**, then **monthly during the first 6 months**; W also requires **every 3 months** generally | Reference range varies by lab — not stated numerically by W | If abnormal: re-consider dose, treat, monitor closely until normal | **W** — *监测 §怎么查、何时查*, *§肝功能 (LFT)*; *抗雄药物/比卡鲁胺 §注意事项* |
| Transaminases — regulatory interval | **Prior to starting, at regular intervals for the first four months, and periodically thereafter** | not stated | — | **C** — FDA CASODEX label §5.1 |
| **ALT (specifically)** | Measured immediately if symptoms of liver dysfunction occur | **ALT > 2× the upper limit of normal** | **Discontinue CASODEX immediately** with close follow-up of liver function. Also discontinue on jaundice alone | **C** — FDA CASODEX label §5.1 |
| **AST** | with ALT | not stated as a separate threshold | — | **C** — FDA label (measures "serum transaminase levels") |
| **Bilirubin** | — | — | **Not stated in the sources I checked.** Neither W nor the FDA label names bilirubin as a monitored laboratory value; the label uses *jaundice* as a clinical sign | — |
| **PT/INR** — only with a coumarin anticoagulant | "closely monitor" | not stated | Adjust the anticoagulant dose | **C** — FDA CASODEX label §5.2 / §7 |
| **Blood glucose** | FDA: "consideration should be given to monitoring blood glucose" (in combination with an LHRH agonist) | not stated | — | **C** — FDA CASODEX label §5.4 |
| **Prostate-specific antigen (PSA)** | — | not stated | Recommended by the label; evaluate for progression if PSA rises. **Population-specific: prostate-cancer indication, not transfeminine GAHT** | **C** — FDA CASODEX label §5.5 |
| **Liver function (general)** | Before start; first 6 months especially | not stated | Severe liver injury — **stop immediately if found** | W — *抗雄药物/比卡鲁胺 §副作用* |
| **Red cell count / CBC** | "酌情" | not stated | Bicalutamide can reduce red cell count; severe cases cause anemia | W — *监测 §怎么查、何时查* |
| **Fasting glucose / insulin** | "酌情" | not stated | Bicalutamide can affect glucose tolerance and raise blood glucose | W — *监测 §怎么查、何时查* |
| **Fasting lipids (LDL-C)** | "酌情" | not stated | Bicalutamide may raise LDL | W — *监测 §怎么查、何时查* |
| **Testosterone (T)** | — | — | **Not useful.** "并不会显著降低睾酮水平，部分使用者甚至会出现血清睾酮升高现象，故此项参考价值不大" — does not significantly lower T; some users show *elevated* serum T, so this test has little reference value | W — *监测 §睾酮 (T)* |
| **Prolactin** | — | — | **Not stated in the sources I checked** for bicalutamide | — |

### 3.2 Bicalutamide clinical framing

| Claim | Value | Source |
|---|---|---|
| Guideline status | SOC-8 **does not currently recommend** bicalutamide for routine GAHT, because transfeminine research is limited | W — *抗雄药物/比卡鲁胺 §注意事项* |
| Dose | Oral, **25–50 mg/day** | W — *抗雄药物/比卡鲁胺 §使用方式与用量* |
| Hepatic risk timing | Mostly in the **first 6 months**; manifests as transaminase elevation; can cause liver failure and death; a fatal transfeminine case report exists | W — *抗雄药物/比卡鲁胺 §副作用* |
| Hepatic risk from the label's evidence base | Hepatitis or marked liver-enzyme increases leading to discontinuation occurred in **~1%** of CASODEX patients in controlled trials; hepatotoxicity generally within the **first 3–4 months** | **C** — FDA CASODEX label §5.1 |
| Symptom checklist to escalate | Nausea, vomiting, abdominal pain, fatigue, anorexia, flu-like symptoms, dark urine, jaundice, right upper quadrant tenderness | W — *抗雄药物/比卡鲁胺 §副作用*; FDA label §5.1 |
| Pulmonary toxicity | Rare but can become interstitial/eosinophilic pneumonia; **risk is much higher in people of Asian descent** ("亚洲人种的这项风险远高于其他人种"); signs include dyspnoea, cough, sore throat | W — *抗雄药物/比卡鲁胺 §副作用* |
| Product-level contraindications | Hereditary galactose intolerance, Lapp lactase deficiency, glucose-galactose malabsorption; **not to be combined with terfenadine, astemizole or cisapride** | W — *抗雄药物/比卡鲁胺 §注意事项* |
| Counter-evidence on liver risk | In 84 transfeminine adolescents/young adults on **low-dose** bicalutamide vs 69 on other blockade: **no AST or ALT > 3× ULN in anyone**; % with AST > ULN was higher for bicalutamide (**10.7% vs 1.5%, p = 0.02**); no clinically significant transaminase change over one year | **C** — Burgener 2025, *Int J Transgend Health*, PMC12857715 |
| Label population caveat | The FDA label's indication is **Stage D2 metastatic prostate carcinoma, in combination with an LHRH analog**; "Women" is listed under contraindications. Its dosing and monitoring are derived from that population, not from transfeminine GAHT | **C** — FDA CASODEX label §1, §4 |

---

## 4. Common set — applies to the anti-androgen class, not one drug

| Test | Interval | Threshold / target | Action triggered | Source |
|---|---|---|---|---|
| **Sex-hormone panel (six items)** — E2, T, PRL are the important ones | Draw **near the next dose** (trough); "不要在服用药物之后立即进行激素检查". After a full six-item panel, only the items of interest may be checked | see per-hormone rows | — | W — *监测 §怎么查、何时查* |
| **Estradiol (E2) re-check interval** | Once levels are stable, **about every 3 months**: "激素水平稳定后大约每 3 个月进行复查". The Peking University Third Hospital follow-up page requires "每三个月复查一次，以继续开具药物" | not stated | — | W — *美国 HRT 综述*; *北医三院 §复诊* |
| Estradiol (E2) | with the panel | Female follicular 30–100 pg/mL, luteal 70–300 pg/mL. Non-injectable: mean 100–200 pg/mL, trough (pre-next-dose) 55–150 pg/mL, **aim > 100 pg/mL**. Injectable: **trough > 200 pg/mL** | — | W — *监测 §雌二醇 (E2)* |
| Testosterone (T) | with the panel | Adult female 0.1–0.55 ng/mL; adult male 2.64–9.16 ng/mL | — | W — *监测 §睾酮 (T)* |
| FSH | with the panel | Premenopausal adult female (follicular, luteal) 1.8–11.2 mIU/mL; postmenopausal 30–120 mIU/mL | Post-orchiectomy a high FSH suggests insufficient estradiol | W — *监测 §促卵泡激素 (FSH)* |
| LH | with the panel | Premenopausal adult female: follicular 2.0–9.0 mIU/mL, luteal 2.0–11.0 mIU/mL; postmenopausal 20.0–70.0 mIU/mL | Same as FSH | W — *监测 §黄体生成素 (LH)* |
| Prolactin (PRL) | "定期"/periodic; **no numeric interval stated** | Female reference **4.79–23.3 ng/mL**; action point is **> 3× the normal value** (≈ > 3× ULN) | Closely observe; consider **reducing the estrogen/progestogen dose, switching drug, or working up prolactinoma (repeat brain MRI)** | W — *监测 §泌乳素 (PRL)* |
| Prolactin confounders | — | — | Psychological stress, breast stimulation, and D2-receptor antagonists (some antipsychotics, prokinetics) can also raise PRL | W — *监测 §泌乳素 (PRL)* |
| **Liver function** | **Before starting**; **every 3 months** during treatment; CPA and bicalutamide: monthly in the **first 6 months** | Reference ranges vary; **watch transaminases in particular** | If abnormal: re-consider dose, treat symptomatically, monitor closely until normal. Severe liver disease is a contraindication for estrogen and CPA | W — *监测 §肝功能 (LFT)* |
| **All other indicators** | — | Keep within the normal reference range | — | W — *监测 §看什么、怎么看* |
| Fasting glucose/insulin + HbA1c | "酌情" | not stated | Estrogen and some anti-androgens (incl. bicalutamide) affect glucose tolerance; in diabetes, dose changes may be needed | W — *监测 §怎么查、何时查* |
| Fasting lipids (LDL-C, TG) | "酌情" | not stated | Estrogen lowers LDL and raises TG; spironolactone and bicalutamide raise LDL. High TG is linked to rare pancreatitis. TG is inversely correlated with thyroid function | W — *监测 §怎么查、何时查* |
| Blood count (RBC, platelets) | "酌情" | not stated | Estrogen can raise platelets; CPA and bicalutamide can lower red cells → anemia | W — *监测 §怎么查、何时查* |
| Bone density | — | not stated | Long-term "low E2 + low T" states risk bone loss | W — *监测 §怎么查、何时查* |
| Coagulation | "酌情"; **pre-operatively** important | not stated | Stop estrogen/progestogen 1 month before surgery and during post-op bed rest; adjust or consult a doctor about CPA too | W — *监测 §怎么查、何时查* |
| MRI (meningioma) | long-term high-dose CPA | see §1.2 | **Stop immediately if found** | W — *监测 §怎么查、何时查* |
| Weight and body fat | "定期测量" | not stated | — | W — *监测 §怎么查、何时查* |
| Lab unit caveat | — | W provides a unit converter; measured values differ by reagent, method, calculation and unit, so the stated values are **for reference only** | — | W — *监测 §相关指标简介* notice |

### 4.1 Section `#fsh` specifically

The user cited the FSH section. Its complete monitoring content as it applies here:

* FSH **and** LH are both lowered by CPA-class progestogens and can fall below the detection
  limit — "使用色普龙（醋酸环丙孕酮）等孕激素会使得该项水平降低，甚至低于检出值" (W — *监测 §促卵泡激素 (FSH)*).
* The summary table states the target explicitly: "**FSH & LH** — 如使用色普龙（醋酸环丙孕酮），低于正常范围" — *below* the normal range (W — *监测 §看什么、怎么看*).
* Post-orchiectomy the same items run **high**, and a high value may indicate insufficient
  estradiol (W — *监测 §促卵泡激素 (FSH)*; *§看什么、怎么看*).
* Reference values: premenopausal adult female 1.8–11.2 mIU/mL; postmenopausal 30–120 mIU/mL
  (W — *监测 §促卵泡激素 (FSH)*).

FSH is therefore a **suppression/adherence signal on CPA**, not a dose-of-CPA proxy, and it is not
named as a monitoring item for spironolactone or bicalutamide.

---

## 5. What the sources do **not** support

Claims I looked for and could **not** verify. These are gaps, deliberately left unfilled.

1. **Bilirubin as a monitored lab value.** Named in the request but **not stated in the sources I
   checked** — neither the wiki nor the FDA CASODEX label lists bilirubin as a test; the label uses
   *jaundice* as a clinical sign, not a bilirubin threshold.
2. **A numeric prolactin interval.** W says "定期检查" (periodic) with no calendar interval. No
   clinical source checked gave an explicit prolactin re-check interval for CPA.
3. **A numeric prolactin threshold in a clinical guideline.** Only W gives the **3× ULN** rule; I
   found no clinical-guideline numeric ceiling to corroborate or contradict it.
4. **Liver action thresholds from the wiki.** W says to watch transaminases but gives **no multiple
   of ULN**; the only "×ULN" figure found anywhere is the FDA **> 2× ULN → discontinue** rule.
   A general "3× ULN" action point is **not stated in the sources I checked**.
5. **An explicit interval for potassium monitoring in the wiki.** W says "定期" only. The concrete
   schedule comes from the Endocrine Society via a secondary source, not from W.
6. **Units for creatinine and uric acid**, and the creatinine cutoff. The Gupta snippet says
   "creatinine levels of < 2" without a unit; **unit not stated in the sources I checked**.
7. **Numerical thresholds for Na, Ca, Mg, glucose, insulin, HbA1c, LDL, triglycerides, RBC,
   platelets, vitamin B12, lithium, and bone density.** W names these tests and says to keep
   "other indicators" in the normal reference range, but gives no numbers.
8. **Bicalutamide and prolactin.** No statement found that bicalutamide raises or should be
   monitored for prolactin — **not stated in the sources I checked**.
9. **Spironolactone and prolactin.** Same: no statement found.
10. **Spironolactone and meningioma.** Not stated — the meningioma signal is CPA-specific.
11. **An absolute serum level of CPA, spironolactone or bicalutamide** that should be targeted or
    titrated. No source checked proposes measuring the drug itself. This is the direct justification
    for replacing a concentration curve with monitoring/adherence tracking.
12. **Food timing for spironolactone** (with or without a meal). **Not stated in the sources I
    checked**; the only food guidance found is to **avoid potassium-rich foods**.
13. **A testosterone target on spironolactone or bicalutamide.** Both sources that address it call
    the measurement unhelpful, so no target is defensible.
14. **Any threshold stated by the wiki that is specific to bicalutamide's first 6 months beyond
    "monthly transaminases".**

---

## 6. For the app — parameters a lab form would need to accept

Derived from the sources above. "Range" means the range the **source** quotes or the value the
source treats as a threshold; where the source gives none, that is stated rather than invented.

### 6.1 Lab values

| Parameter | Unit (as quoted by source) | Range / threshold the source supports | Used for | Source |
|---|---|---|---|---|
| Estradiol (E2) | pg/mL (source also links a pmol/L converter) | Adult female follicular 30–100; luteal 70–300. Non-injectable mean 100–200, trough 55–150, target > 100. Injectable trough > 200 | Level tracking | W |
| Testosterone (T) | ng/mL | Female 0.1–0.55; male 2.64–9.16. CPA target: at/below female range; do not over-suppress below 0.55 | Level tracking; **suppress on CPA, ignore on spironolactone/bicalutamide** | W |
| FSH | mIU/mL | Premenopausal 1.8–11.2; postmenopausal 30–120. On CPA: below the normal range | CPA suppression/adherence | W |
| LH | mIU/mL | Follicular 2.0–9.0; luteal 2.0–11.0; postmenopausal 20.0–70.0. On CPA: below normal | CPA suppression/adherence | W |
| Prolactin (PRL) | ng/mL | Female 4.79–23.3; **action at > 3× ULN** | Safety — CPA | W |
| ALT | U/L (unit not explicitly given) | **Action: > 2× ULN → discontinue**; ULN must come from the lab report | Safety — CPA, bicalutamide | FDA label; W |
| AST | U/L (unit not explicitly given) | No separate threshold stated; report % above ULN | Safety — CPA, bicalutamide | FDA label; Burgener 2025 |
| Bilirubin | — | **not stated in the sources I checked** — do not populate | — | — |
| Potassium (K) | mmol/L | **Must be < 5.0 before starting spironolactone** | Safety — spironolactone | W |
| Creatinine | not stated | not stated | Safety — spironolactone | W |
| Uric acid | not stated | not stated | Safety — spironolactone | W |
| Sodium (Na) | not stated | not stated | Safety — spironolactone | W |
| Calcium (Ca) / Magnesium (Mg) | not stated | not stated | Safety — spironolactone (electrolytes panel) | W |
| Serum lithium | not stated | not stated | Only if co-prescribed | W |
| Fasting glucose and insulin | not stated | not stated | Class-wide | W |
| HbA1c | not stated | not stated | Class-wide | W |
| LDL cholesterol | not stated | not stated | Class-wide | W |
| Triglycerides | not stated | not stated | Class-wide | W |
| Red blood cell count | not stated | not stated | Class-wide | W |
| Platelet count | not stated | not stated | Class-wide | W |
| Vitamin B12 | not stated | not stated | CPA (supplementation advised) | W |
| PT / INR | ratio / seconds | not stated | Only with coumarin anticoagulant | FDA label |
| PSA | ng/mL | not stated | **Prostate-cancer indication only — not applicable to transfeminine GAHT** | FDA label |

### 6.2 Non-lab parameters the same logic requires

| Parameter | Why it is needed | Source |
|---|---|---|
| **Drug name, dose, and dose frequency** | Every threshold action above is dose- or duration-conditional; spironolactone is dosed 100–400 mg/day **in divided doses** | W |
| **Cumulative CPA exposure in grams** | Drives the meningioma action: W triggers MRI at **> 10 g**; SfE educates at **≥ 10 g** | W; SfE |
| **Months on therapy** | The liver-monitoring schedule changes inside the first 4–6 months | W; FDA label |
| **Last-dose timestamp vs blood-draw timestamp** | The panel must be drawn near the next dose (trough) | W |
| **Orchiectomy / SRS status** | Changes the FSH/LH interpretation (high = possibly insufficient E2) | W |
| **Creatinine / renal-function status** | Gates spironolactone use and monitoring intensity | W; Gupta 2022 |
| **Age (> 45 y)** | Spironolactone hyperkalemia risk: 8.9% vs 1.5% | Hayes 2022 |
| **Co-medications** | Other potassium-sparing drugs, potassium supplements, lithium, coumarin anticoagulants, TCAs/SSRIs, terfenadine/astemizole/cisapride | W; FDA label |
| **Liver-dysfunction symptoms** | The FDA label triggers an immediate ALT on these signs | FDA label |
| **Meningioma symptoms** | Vision loss, hearing loss, anosmia, tinnitus, seizures, limb weakness → urgent MRI | SfE |
| **MRI / imaging events** | Meningioma surveillance is event-based, not a lab value | W; SfE |
| **Weight / body fat** | Periodic measurement recommended | W |

---

## 7. Where the two source families disagree

| Issue | MtF.wiki (W) | Clinical / regulatory (C) |
|---|---|---|
| Bicalutamide liver-monitoring schedule | Monthly for the **first 6 months**, plus every 3 months generally | FDA: "at regular intervals for the **first four months**, and periodically thereafter" — no "monthly", and 4 months not 6 |
| Action at ~10 g cumulative CPA | **Do an MRI** at > 10 g | SfE: **educate** at ≥ 10 g; urgent MRI only on symptoms |
| Potassium monitoring cadence | "定期" — no interval | Endocrine Society: every 3 months for the first year, then annually |
| Bicalutamide hepatotoxicity magnitude | Emphasises severe/fatal liver injury and case reports | Burgener 2025 cohort: no clinically significant transaminase rise at low dose; nobody exceeded 3× ULN |
| Liver action threshold | No multiple of ULN given | FDA: discontinue at **> 2× ULN** or jaundice |
| Meningioma dose floor | "large cumulative dose"; > 10 g for MRI | ≥ 25 mg/day and cumulative-dose bands (12 g / 36–60 g / > 60 g) |

Agreements worth noting: both families treat **liver monitoring for CPA and bicalutamide as
mandatory**, and both treat **hyperkalemia as the defining spironolactone hazard**.

---

## 8. Source list

**Primary (W)**

* MtF.wiki — 治疗期间的监测 (Treatment monitoring).
  https://mtf.wiki/zh-cn/docs/medicine/monitoring — sections *怎么查、何时查*,
  *看什么、怎么看*, *雌二醇 (E2)*, *睾酮 (T)*, *促卵泡激素 (FSH)*, *黄体生成素 (LH)*,
  *泌乳素 (PRL)*, *肝功能 (LFT)*.
* MtF.wiki — 色普龙（醋酸环丙孕酮）.
  https://mtf.wiki/zh-cn/docs/medicine/antiandrogen/cyproterone
* MtF.wiki — 螺内酯片. https://mtf.wiki/zh-cn/docs/medicine/antiandrogen/spironolactone
* MtF.wiki — 比卡鲁胺片. https://mtf.wiki/zh-cn/docs/medicine/antiandrogen/bicalutamide
* MtF.wiki — 美国 HRT 综述. https://mtf.wiki/zh-cn/docs/hrt/us/overview
  (*激素水平稳定后大约每 3 个月进行复查*; links the UCSF Guideline used for the trough draw.)
* MtF.wiki — 北医三院 (follow-up schedule). https://mtf.wiki/zh-cn/docs/hrt/puth
  (*开始 HRT 之后要求每三个月复查一次，以继续开具药物*.)

**Clinical / regulatory (C)**

* FDA — CASODEX (bicalutamide) prescribing information, via DailyMed, updated 2026-02-27.
  https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=dfee4fe7-8478-4a3e-925d-00be3cd0ab67
  (§1, §4, §5.1, §5.2, §5.4, §5.5, §7)
* Society for Endocrinology — *Risk of Meningioma with Cyproterone Acetate*, 2025-06-26.
  https://www.endocrinology.org/news/item/23306/risk-of-meningioma-with-cyproterone-acetate-
* Weill A, et al. *Use of high dose cyproterone acetate and risk of intracranial meningioma in
  France*, BMJ 2021;372:n37. https://www.bmj.com/content/372/bmj.n37 ·
  https://pubmed.ncbi.nlm.nih.gov/33536184/
* Medscape summary of Weill 2021 (HR 11.3 for 36–60 g; n.s. < 12 g).
  https://www.medscape.com/viewarticle/945218
* Medsafe New Zealand — *Cyproterone acetate and the risk of meningioma*, 2020-09-03.
  https://www.medsafe.govt.nz/profs/PUArticles/September2020/Cyproterone-acetate-risk-of-meningiom.html
* Hayes H, et al. *The Utility of Monitoring Potassium in Transgender, Gender Diverse, and
  Nonbinary Individuals on Spironolactone*, J Endocr Soc 2022;6(11):bvac133.
  https://pmc.ncbi.nlm.nih.gov/articles/PMC9562816/
* Gupta P, et al. *Potassium Concentrations in Transgender Women Using Spironolactone*,
  Endocr Pract 2022. https://www.endocrinepractice.org/article/S1530-891X(22)00595-X/abstract
* Burgener K, et al. *Bicalutamide does not raise transaminases clinically significantly …*,
  Int J Transgend Health 2025;27(1):503–512.
  https://pmc.ncbi.nlm.nih.gov/articles/PMC12857715/
* UCSF Gender Affirming Health Program — *Overview of feminizing hormone therapy*.
  https://transcare.ucsf.edu/guidelines/feminizing-hormone-therapy (used for the hyperkalemia /
  renal-insufficiency precaution wording; no new numeric thresholds)

---

*Compiled as a monitoring design reference. MtF.wiki itself notes its content is for reference and
may be outdated or inaccurate; all thresholds above should be read against the user's own lab
reference ranges and a clinician. No threshold in this document was invented — where a number was
absent it is marked as not stated.*
