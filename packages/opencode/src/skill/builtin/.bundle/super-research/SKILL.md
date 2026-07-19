---
name: super-research
description: Autonomous research skill for open-ended, high-volume research work — an agent left running for a while (minutes to overnight) that produces honest, comparable, auditable evidence instead of a single one-shot answer. Covers eight modes selected by the request: (1) experiment loop — iteratively edit code, run, measure a metric, keep or revert (baseline → hypothesize → run → keep/revert loop; use for "optimize X", "tune hyperparameters", "run experiments overnight", "autonomously improve this model", "hill-climb a metric", "自动实验"); (2) topic survey / 主题调研 — collect and synthesize sources on a question (use for "survey the literature on X", "research topic Y", "调研 Z", "literature review", "deep research", "what's the state of the art in", "gather evidence about"); (3) quantitative analysis / 量化分析 — reproducible, hypothesis-first data analysis with schema audit, effect sizes, and caveats (use for "analyze this dataset", "量化分析", "test whether X correlates with Y", "compute the effect of", "investigate this data"); (4) benchmark comparison / 对比评测 — pick among N candidates under a fair, fixed matrix (use for "compare X vs Y", "which library/model/prompt is best for us", "benchmark these options", "选型", "对比评测"); (5) root-cause investigation / 根因排查 — hypothesis-driven, two-way-reversal debugging of regressions, flakes, and perf drops (use for "why is X broken", "root cause this", "debug the regression", "why is it flaky", "排查", "定位", "复盘"); (6) ablation study / 消融实验 — leave-one-out attribution of a system's components against a measured noise floor (use for "ablate X", "which parts of Y matter", "attribution study", "消融实验", "is component Z pulling its weight"); (7) paper reproduction / 复现论文 — implement a paper's method as a working repo with logged ambiguities (use for "复现这篇论文", "paper to code", "implement this method", "reproduce the main table of X"); (8) paper writing + citation audit / 写论文 & 引用校验 — draft or polish an academic paper and verify every citation against real API records (use for "write a paper on X", "polish this draft", "查引用", "citation check", "校验引用", "detect fabricated references"). Ships with a zero-external-dependency toolbox (built-in tools + free scholarly APIs — arXiv, Semantic Scholar, OpenAlex, Crossref — no API keys). Trigger this skill whenever the user wants research work with volume + discipline — even without the words "research" or "experiment" — and pick the mode from the request.
---

# Autonomous Research

You are about to become an autonomous researcher. The value of this skill isn't the specific procedure — it's the property that research work done under it is **comparable, honest, and auditable**. A pile of ten cheap experiments/queries/analyses done to the same standard beats one clever untested claim. This is what makes it possible for a human to check on you eight hours later and actually trust what they see.

This skill was distilled from Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) methodology and generalized to six research modes.

## Shared discipline (all modes)

Every mode operates under the same five rules. Read them before you branch into a mode.

1. **State a contract before you begin.** Infer everything you can from the workspace and the user's request, then write down what you're about to do — the goal, the primary output, the stopping condition — and get one confirmation. This is your last question. After confirmation you are autonomous.

2. **Establish a baseline as your first artifact.** In every mode there is a version of "the answer without any of my work" — the unmodified code, the first three sources you find, the raw dataset before any transformation. Record it first. Without a baseline, "better" and "significant" are meaningless.

3. **Every step is logged, in a machine-readable file, including failures.** A tab-separated log (TSV, not CSV — descriptions contain commas) with a header row and one row per attempt. Failed attempts get logged with a `crash` / `dead-end` / `inconclusive` status. Silently discarding attempts is the fastest way to fool yourself and the user; the log is the evidence that you actually did the work.

4. **Never pause to ask permission mid-loop.** Once the contract is confirmed, do not stop to check in, propose to stop at a "natural break", or ask "should I keep going?". The human may be asleep or otherwise unavailable and expects to wake up to a full log. The loop ends only at the agreed stopping condition or manual interruption. **This is the single most common failure mode of autonomous runs.**

5. **Never game the metric / the sources / the analysis.** Don't edit the eval code because it's "clearly wrong". Don't drop a source because it doesn't fit your thesis. Don't p-hack, don't cherry-pick a subset that gives a nicer number. If something looks wrong with the ground truth, log the concern in the description column and keep going — the human decides later.

## Pick a mode

Read the user's request and pick one mode. If it's ambiguous, pick the closest and state your choice in the contract.

| Mode | Triggering signals | Read |
| --- | --- | --- |
| **Experiment loop** | "optimize", "tune", "run experiments", "improve this model", "hill-climb", "get the metric down/up", "自动实验", any measurable code-in-repo goal | `references/experiment-loop.md` |
| **Topic survey / 主题调研** | "survey", "literature review", "deep research", "research this topic", "调研", "gather evidence on", "what does the field say about", "state of the art" | `references/topic-survey.md` |
| **Quantitative analysis / 量化分析** | "analyze this dataset", "量化分析", "test whether X relates to Y", "estimate the effect of", "investigate this data", CSV/parquet/dataframe in the workspace | `references/quant-analysis.md` |
| **Benchmark comparison / 对比评测** | "compare X vs Y", "which of these should we use", "benchmark these", "选型", "对比评测", picking one candidate from an explicit list | `references/benchmark-comparison.md` |
| **Root-cause investigation / 根因排查** | "why is X broken", "root cause this", "debug the regression", "why is it flaky", "排查", "定位", "复盘", any "used to work, now doesn't" | `references/root-cause.md` |
| **Ablation study / 消融实验** | "ablate", "which parts of X matter", "attribution study", "消融实验", "is Y pulling its weight", "leave-one-out" | `references/ablation-study.md` |
| **Paper reproduction / 复现论文** | "复现这篇论文", "paper to code", "implement this method", "reproduce the main table", user hands you an arXiv id / DOI / PDF | `references/paper-reproduction.md` |
| **Paper writing + citation audit / 写论文 & 引用校验** | "write a paper on X", "polish this draft", "查引用", "citation check", "校验引用", "detect fabricated references", any `.bib` or `.tex` to audit | `references/paper-writing.md` |

**Adjacent modes — pick carefully:**
- Experiment loop vs benchmark: experiment loop *improves one thing* (edit → measure → keep/revert). Benchmark *compares many things* (fair matrix, no tuning of the favorite). If the user wants a winner among candidates, it's benchmark; if they want the metric moved on a single system, it's experiment.
- Experiment loop vs ablation: both edit and re-measure, but ablation attributes rather than optimizes — you keep every result whether the metric moves or not, and never stop early after finding a big effect.
- Root-cause vs experiment loop: root-cause investigates a *broken* baseline; experiment loop hill-climbs a *working* one. Debugging is not optimization — the log schema and stopping rule differ.
- Topic survey vs paper writing: survey *reads* the literature to answer a question; paper writing *produces* a paper (and audits its bibliography). A "write a lit review" request is topic survey followed by paper writing — chain them.
- Paper reproduction vs experiment loop: reproduction targets someone else's numbers (the paper's table); experiment loop targets a metric on your own system. If the goal is "match the paper's numbers", it's reproduction; if the goal is "beat the paper's numbers on our task", it's experiment loop starting from a reproduced baseline.

Read the relevant reference file **now**, before writing the contract. Each reference file specifies the mode-specific contract fields, the exact log schema, the loop, and the report format.

## Toolbox (scripts/)

Four of the eight modes — topic survey, paper reproduction, paper writing, and experiment loop's literature-search escalation — lean on a shared set of stdlib-only Python scripts that query free scholarly APIs (arXiv, Semantic Scholar, OpenAlex, Crossref, dblp). **No API keys, no MCP servers, no external Python deps.** Run them directly; don't reimplement.

```bash
# Multi-source paper search — arXiv + S2 + OpenAlex + Crossref, dedup, unified JSON
python3 scripts/paper_search.py "chain of thought reasoning" --sources arxiv,s2,openalex --limit 15 --out papers.json

# Verify ONE citation (waterfall: Crossref → S2 → OpenAlex → arXiv; title-similarity match)
python3 scripts/verify_citation.py --title "Attention Is All You Need" --author Vaswani --year 2017

# Audit an entire .bib file → per-entry verdict (VERIFIED / MISMATCH / NOT_FOUND)
python3 scripts/verify_citation.py --bib refs.bib --out audit.json

# Fetch a paper's full text (arXiv id or abs URL → text via ar5iv HTML, falls back to abstract)
python3 scripts/fetch_paper.py 2504.17192 --out paper.txt

# Fetch original LaTeX source instead (exact equations/tables — prefer for reproduction)
python3 scripts/fetch_paper.py 2504.17192 --latex --out-dir paper_src/
```

On HTTP 429/5xx the scripts retry with backoff. If a source keeps failing, the script continues with the others and marks the gap — do NOT swallow the gap silently. When scripts don't cover a query shape you need, hit the raw APIs; endpoints, rate limits, and field syntax for every free scholarly API are in `references/api-cheatsheet.md`.

**Non-negotiables when using this toolbox:**

- **Never fabricate a citation.** Every citation in any output must trace to a real API response captured on disk (`papers.json`, `citation_audit.json`). If verification fails, mark `[unverified]` or remove — never guess metadata.
- **URLs come from search results, not memory.** A URL you didn't get from an API call is a hallucination.
- **Contradictions are findings, not problems.** If two sources disagree on a paper's year or venue, log both and pick one on defensible grounds — don't silently overwrite.

## Reporting

Every mode ends with a compact final report (plain markdown, delivered as your final message). Structure:

- **Contract**: one paragraph, what you set out to do.
- **Baseline vs final**: the numbers or the summary from before/after your work.
- **What worked**: 3–5 items with quantitative or specific-source backing.
- **What didn't**: the dead-ends, crashes, or contradictions — this is high-signal.
- **Open questions / next steps**: what you'd do with more time.
- **Where to look**: pointer to the log file, branch, and any generated artifacts.

Keep it under a page. The point isn't storytelling — it's letting a human verify your work in five minutes and know what to look at next.
