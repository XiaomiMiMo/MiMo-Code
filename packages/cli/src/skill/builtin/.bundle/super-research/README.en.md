# super-research

[English](README.en.md) · [中文](README.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md)

An **autonomous research skill** for Claude Code / Claude.ai. Let an agent run for a while (minutes to overnight) and get **comparable, honest, auditable evidence** back — not a one-shot black-box answer.

Inspired by Karpathy's [autoresearch](https://github.com/karpathy/autoresearch). This skill generalizes the methodology to six research modes.

---

## What it is

A working discipline for "if you let the agent run overnight, you should trust the output the next morning." The value isn't the specific procedure — it's **the same discipline in every mode**:

1. **Contract before action** — write down the goal, the primary output, the stopping condition; confirm once. After that, no more questions.
2. **Baseline first** — every mode has "the answer without any of my work" (unmodified code / the first three search results / the raw dataset before any transformation). Record it first, or "better" and "significant" mean nothing.
3. **Every step in a machine-readable log, failures included** — TSV (not CSV; descriptions contain commas). Silently discarding failed attempts is the fastest way to fool yourself and the user.
4. **No mid-loop check-ins** — after the contract is confirmed, the agent doesn't stop to ask "should I keep going?". The human may be asleep.
5. **No gaming** — don't edit the eval code, don't drop sources, don't p-hack, don't cherry-pick a nicer subset.

---

## Six modes

The skill picks a mode from the user's phrasing. You can also specify one explicitly.

| Mode | When to use | Trigger phrases | Details |
| --- | --- | --- | --- |
| **Experiment loop** | Improve one system toward a numeric goal | "optimize", "tune", "hill-climb", "run experiments overnight" | `references/experiment-loop.md` |
| **Topic survey / 主题调研** | Gather + synthesize external sources on a question | "survey", "literature review", "research topic X", "state of the art" | `references/topic-survey.md` |
| **Quantitative analysis / 量化分析** | Answer a quantifiable question from a dataset | "analyze this dataset", "does X predict Y" | `references/quant-analysis.md` |
| **Benchmark comparison / 对比评测** | Pick among N candidates | "compare X vs Y", "which library should we use" | `references/benchmark-comparison.md` |
| **Root-cause investigation / 根因排查** | Diagnose a regression / flake / perf drop | "why is X broken", "debug the regression" | `references/root-cause.md` |
| **Ablation study / 消融实验** | Attribute contribution to system components | "ablate", "which parts of X matter" | `references/ablation-study.md` |

**Adjacent-mode distinctions** (the skill picks, but you can steer):

- **Experiment loop vs Benchmark** — experiment improves *one* system; benchmark picks from *many*. "Choose among" → benchmark; "push this metric" → experiment.
- **Experiment loop vs Ablation** — both edit and re-measure. Experiment keeps improvements; ablation keeps *every* result and never stops early — the goal is understanding, not optimization.
- **Root-cause vs Experiment loop** — root-cause investigates a *broken* baseline; experiment climbs from a *working* one. The log schema and stopping rule differ.

---

## How to use

### Trigger phrase

The skill auto-loads on matching phrases. Or specify explicitly:

```
Use super-research's <mode> mode. Run overnight. Put artifacts in <dir>/.
```

### Typical flow

```
You    : Compare lib_a, lib_b, lib_c for text cleaning. Benchmark comparison,
         no per-candidate tuning. Each of the 5 cases at least twice.
Claude : [triggers skill → reads SKILL.md + references/benchmark-comparison.md]
         [drafts contract: candidates, matrix, metrics, fairness budget, dir]
         [asks you to confirm once — your last opening to speak]
You    : Confirmed
Claude : [autonomous loop — smoke-test harness → run matrix → append each cell
          to matrix.tsv → aggregate → drop-one-case stability → report.md]
         [final report: winner / ranking / stability / integration notes / logs]
```

The key point: **after the contract, Claude doesn't ask more questions**. It may run for tens of minutes to hours. You can walk away.

### Artifacts per mode

| Mode | Working dir | Key log | Deliverable |
| --- | --- | --- | --- |
| Experiment loop | `research/<tag>/` (git branch) | `results.tsv` | Best commit + report |
| Topic survey | `survey/<tag>/` | `sources.tsv` + `claims.tsv` | Cited survey `report.md` |
| Quant analysis | `analysis/<tag>/` | `analysis_log.tsv` | `scripts/` + `report.md` + `figures/` |
| Benchmark | `benchmark/<tag>/` | `matrix.tsv` | Ranking + recommendation `report.md` |
| Root-cause | `investigation/<tag>/` | `hypotheses.tsv` + `baseline.md` | Root cause + two-way-reversal proof |
| Ablation | `ablation/<tag>/` | `ablation.tsv` | Component classification + report |

Logs are **TSV** (tab-separated) with headers. Directories default to the current working dir; `<tag>` defaults to today's date (e.g. `jul7`).

### Final-report shape

Every mode ends with a compact markdown (≤1 page):

- **Contract** — what you set out to do
- **Baseline vs final** — start vs end numbers
- **What worked** — 3–5 items with evidence
- **What didn't** — dead-ends, crashes, contradictions. **This is high-signal.**
- **Open questions / next steps**
- **Where to look** — logs, branch, artifacts

The point is: **let a human verify the work in 5 minutes and know what to look at next**. Not storytelling.

---

## Directory layout

```
super-research/
├── SKILL.md                     # frontmatter (triggering) + shared discipline + mode table
├── references/                  # one per mode; loaded only after a mode is picked
│   ├── experiment-loop.md
│   ├── topic-survey.md
│   ├── quant-analysis.md
│   ├── benchmark-comparison.md
│   ├── root-cause.md
│   └── ablation-study.md
└── evals/                       # for testing the skill itself
    ├── evals.json               # 8 test cases with assertions
    ├── toy_repo/                # experiment-loop fixture (synthetic training script)
    ├── toy_dataset/             # quant-analysis fixture (Simpson's-paradox data)
    ├── toy_bench/               # benchmark fixture (3 cleaners × 5 cases)
    ├── toy_regression/          # root-cause fixture (bisectable 5-commit repo)
    └── toy_pipeline/            # ablation fixture (5 toggleable components)
```

---

## Progressive disclosure (the design)

- **SKILL.md is always in context** — but only the shared discipline + mode-selection table. Under 100 lines.
- **`references/<mode>.md` is loaded on demand** — after Claude picks a mode, only that file is read.
- **evals/ never enters context** — it's only used when running skill-creator's eval harness.

So when the skill triggers, Claude reads a few hundred extra lines total, not the full six-mode ruleset.

---

## Testing / iterating the skill itself

`evals/evals.json` has 8 cases covering all six modes plus two discipline tests (`handles-crash-gracefully`, `ambiguous-goal-must-clarify`). Each case has:

- `prompt` — the instruction given to the agent
- `files` — fixtures to place in the working directory
- `expectations` — programmatically verifiable assertions

Recommended path: use the `skill-creator` skill. It spawns two subagents per case (with-skill vs baseline), collects artifacts, runs assertions, produces a `benchmark.json` and an HTML viewer.

All fixtures are self-contained and fast (`toy_repo/run.py` uses `time.sleep(0.5)`; `toy_regression/setup.sh` seeds a fresh repo each call; `toy_pipeline/pipeline.py` is pure synthetic scoring).

---

## When **not** to use it

- One-off tasks that finish in minutes — just have a normal conversation.
- Goals that can't be pressed into a single number or a single answerable question — think it through first.
- Every step needs human sign-off — that's pair programming, not autonomous research.

The value is **volume × discipline**: ten cheap experiments run to the same standard beat one clever untested claim. Without cheap experiments *and* a comparable standard, the discipline is idling.
