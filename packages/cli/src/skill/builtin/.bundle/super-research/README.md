# super-research

[English](README.en.md) · [中文](README.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md)

Claude Code / Claude.ai 的**自主研究 skill**。让 agent 长时间跑（几分钟到通宵）后，产出**可对比、诚实、可审计的证据**，而不是一个 one-shot 的黑箱答案。

灵感来源：Karpathy 的 [autoresearch](https://github.com/karpathy/autoresearch) 方法论。此 skill 把它推广到六种研究模式。

---

## 是什么

一个"如果你把 agent 留一晚上，早上要能相信它的产出"的工作规程。核心不是具体流程，而是**同一份纪律**：

1. **先立契约再动手** — 把目标、主输出、停止条件写下来，确认一次。之后就不再问。
2. **基线先行** — 每种模式都有"我啥都没做时的答案"（原始代码 / 头三个搜索结果 / 未变换的原始数据）。先记录，否则"更好"和"显著"都无从谈起。
3. **每一步都进机读日志，失败也写** — TSV（不是 CSV，因为描述里会有逗号）。悄悄丢掉失败的尝试是最快的自欺方式。
4. **循环中不请示** — 契约定好后 agent 不停下来问"要不要继续"。人可能在睡觉。
5. **不作弊** — 不改 eval 代码，不筛选源，不 p-hack，不挑好看的子集。

---

## 六种模式

Skill 会根据用户话术自动选择模式。你也可以在 prompt 里明确指定。

| 模式 | 什么时候用 | 触发词 | 详情 |
| --- | --- | --- | --- |
| **Experiment loop** | 用一个数字目标改进单一系统 | "optimize"、"tune"、"hill-climb"、"跑一晚实验" | `references/experiment-loop.md` |
| **Topic survey / 主题调研** | 就一个问题收集并综述外部文献 | "survey"、"literature review"、"调研 X"、"state of the art" | `references/topic-survey.md` |
| **Quantitative analysis / 量化分析** | 从数据集回答一个可量化的问题 | "analyze this dataset"、"量化分析"、"X 是否预测 Y" | `references/quant-analysis.md` |
| **Benchmark comparison / 对比评测** | 在 N 个候选里选一个 | "compare X vs Y"、"选型"、"对比评测" | `references/benchmark-comparison.md` |
| **Root-cause investigation / 根因排查** | 定位回归、偶发、性能劣化 | "why is X broken"、"排查"、"定位"、"复盘" | `references/root-cause.md` |
| **Ablation study / 消融实验** | 归因一个系统各组件的贡献度 | "ablate"、"消融实验"、"attribution study" | `references/ablation-study.md` |

**相邻模式辨析**（skill 自己也会挑，但你可以显式引导）：

- **Experiment loop vs Benchmark**：experiment 改进*一个*系统，benchmark 从*多个*候选里选。要"选型"就是 benchmark；要"把这个指标推低"就是 experiment。
- **Experiment loop vs Ablation**：都是改代码 + 测指标。experiment 择优保留；ablation 全部保留、绝不因为找到大效应而提前停 —— 目标是理解不是优化。
- **Root-cause vs Experiment loop**：root-cause 调查一个*已经坏*的基线；experiment 从一个*可以工作*的基线继续爬。日志字段和停止规则完全不同。

---

## 怎么用

### 一句话触发

Skill 会在符合触发词的场景下自动被 Claude 拉起来。你也可以在 prompt 里显式说：

```
「按 super-research 的 <mode> 模式，跑一晚，产物放 <dir>/」
```

### 典型的对话流

```
你 : 帮我在 lib_a、lib_b、lib_c 里选一个做文本清洗 —— 对比评测一下，
     不要调优候选，五个测试用例每个至少跑两次。
Claude: [触发 skill → 读 SKILL.md + references/benchmark-comparison.md]
        [起草契约：候选、任务矩阵、指标、公平预算、目录]
        [请你确认一次 —— 这是你最后一次开口的机会]
你 : 确认
Claude: [进入自主循环 — 冒烟测试 harness → 跑矩阵 → 每格记入 matrix.tsv →
         聚合 → drop-one-case 稳定性检查 → 生成 report.md]
        [产出最终报告：胜者 / 排名表 / 稳定性 / 集成成本 / 日志路径]
```

关键点：**契约确认之后 Claude 不再提问**。它可能跑几十分钟到几小时，你可以离开。

### 每种模式的产物

| 模式 | 工作目录 | 关键日志 | 产物 |
| --- | --- | --- | --- |
| Experiment loop | `research/<tag>/` (git 分支) | `results.tsv` | 最佳 commit + 报告 |
| Topic survey | `survey/<tag>/` | `sources.tsv` + `claims.tsv` | 带引用的综述 `report.md` |
| Quant analysis | `analysis/<tag>/` | `analysis_log.tsv` | `scripts/` + `report.md` + `figures/` |
| Benchmark | `benchmark/<tag>/` | `matrix.tsv` | 排名 + 建议 `report.md` |
| Root-cause | `investigation/<tag>/` | `hypotheses.tsv` + `baseline.md` | 根因 + 双向反转证据 |
| Ablation | `ablation/<tag>/` | `ablation.tsv` | 组件分类表 + 报告 |

日志一律 **TSV**（tab 分隔），带表头。目录默认放在当前工作目录下，`<tag>` 用日期（比如 `jul7`）。

### 最终报告结构

所有模式最后都给一份紧凑的 markdown（≤1 页）：

- **Contract**：你让我做什么
- **Baseline vs final**：起点数字 vs 终点数字
- **What worked**：3–5 条带证据
- **What didn't**：死胡同、崩溃、矛盾 —— **这才是高信号**
- **Open questions / next steps**
- **Where to look**：日志文件、分支、artifact 路径

要点是：**让人在 5 分钟内验证工作、知道下一步看哪**。不是讲故事。

---

## 目录结构

```
super-research/
├── SKILL.md                     # frontmatter (触发) + 共享纪律 + 模式选择表
├── references/                  # 六种模式各一份，触发后才被 Claude 读入
│   ├── experiment-loop.md
│   ├── topic-survey.md
│   ├── quant-analysis.md
│   ├── benchmark-comparison.md
│   ├── root-cause.md
│   └── ablation-study.md
└── evals/                       # 用于测试 skill 本身
    ├── evals.json               # 8 个测试 case 的定义 + 断言
    ├── toy_repo/                # experiment-loop 用（合成训练脚本）
    ├── toy_dataset/             # quant-analysis 用（Simpson's paradox 数据）
    ├── toy_bench/               # benchmark 用（3 个 cleaner × 5 个 case）
    ├── toy_regression/          # root-cause 用（可 bisect 的 5-commit 仓库）
    └── toy_pipeline/            # ablation 用（5 个可开关的 pipeline 组件）
```

---

## Progressive disclosure（怎么设计的）

- **SKILL.md 常驻上下文**：只放共享纪律 + 模式选择表。<100 行。
- **`references/<mode>.md` 按需加载**：Claude 挑一个模式后才读那一份 mode 文件。互不干扰。
- **evals 完全不入上下文**：只在跑 skill-creator 的评测时用。

这样 Claude 拉起 skill 时**只多读几百行**、进入模式后**只多读一份 reference**，不会把 6 种模式的规则全塞进去。

---

## 测试与迭代 skill 本身

`evals/evals.json` 里有 8 个 case，覆盖所有六种模式加两个纪律测试（"handles-crash-gracefully"、"ambiguous-goal-must-clarify"）。每个 case 有：

- `prompt`：给 agent 的原始指令
- `files`：需要放到工作目录的 fixture
- `expectations`：可编程验证的断言列表

跑评测的推荐路径：用 `skill-creator` skill（`/skill-creator` 或让 Claude 触发），它会：

1. 对每个 case 起两个 subagent —— 一个带 skill、一个不带（baseline）
2. 收集产物，跑断言，产出 `benchmark.json` 和 HTML 视图
3. 让人点开对比 with/without 差异

Fixture 都是自足的、秒级完成（`toy_repo/run.py` 用 `time.sleep(0.5)` 模拟训练；`toy_regression/setup.sh` 每次现生成 git repo；`toy_pipeline/pipeline.py` 是纯合成分数）。

---

## 我该什么时候**不**用这个 skill

- 一次性的、几分钟能搞定的小任务 —— 用普通对话就行，别开循环
- 目标不能压成一个数字或一个可回答的问题 —— 先想清楚再来
- 结果需要每一步都让人拍板 —— 那本质上不是自主研究，是 pair programming

Skill 的价值在**规模 × 纪律**：跑十个便宜实验按同一套标准，胜过一个聪明但没验证的断言。这里没有便宜实验/没有可对比标准时，纪律就是空转。
