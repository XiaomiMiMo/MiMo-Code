---
name: deep-research
description: Deep research on any topic using parallel sub-agents and built-in tools only (WebSearch/WebFetch + free APIs, no keys). Use when the user asks for a thorough multi-source investigation with a cited report — "深度调研X"、"deep research"、"帮我全面研究一下"、"多方求证"、"写一份调研报告". NOT for simple lookups (single WebSearch suffices) and NOT for academic literature surveys (use auto-research skill instead).
---

# Deep Research

Orchestrate parallel research sub-agents, then write one coherent cited report. Research is parallel; writing is single-point — never let multiple agents write report sections.

## Step 0 — Always first

1. Run `date +%Y-%m-%d` via Bash. Never assume the current year from training data.
2. Triage:
   - Answerable with 1-2 searches? → STOP, just use WebSearch directly. Do not use this skill.
   - Enumeration task (N items × M fields, e.g. "compare 20 frameworks")? → still this skill, but use table-oriented decomposition (one sub-agent per item batch).
   - Open-ended investigation? → continue below.
3. Pick depth (default **standard**; user can override with words like "quick"/"exhaustive"):

| Mode | Sub-agents (round 1) | Max follow-up rounds | Sources target |
|---|---|---|---|
| quick | 2-3 | 0 | 8+ |
| standard | 3-5 | 1 | 15+ |
| deep | 5-8 | 2 | 25+ |

These are hard budgets. Reflection (Phase 4) can spend them but never exceed them.

## Workspace

All state lives on disk at `./research/<slug>/` — never only in context (survives compaction):

```
research/<slug>/
├── brief.md         # research brief — the single contract for all phases
├── findings/        # F1.md, F2.md ... one per sub-agent, structured evidence
└── REPORT.md        # final deliverable
```

On resume: re-read `brief.md` + list `findings/`, skip completed angles, continue.

## Phase 1 — Scope

Ask at most one round of clarifying questions (AskUserQuestion), only if genuinely ambiguous: audience, time frame, region, decision at stake. If the user said "just run it" or intent is clear, skip asking and write assumptions into the brief instead.

Then write `brief.md`: refined question, scope boundaries (in/out), assumptions, depth mode, today's date. This brief — not the raw conversation — is what every later phase measures against.

## Phase 2 — Plan

Decompose the brief into 3-8 **independent** research angles. Pull from these lenses as applicable: core facts/definitions · recent developments (last 12 months) · quantitative data/benchmarks · counter-arguments & failure cases · practitioner experience (forums, issues) · academic work · key players/alternatives.

List angles in `brief.md` under `## Angles`. For deep mode or contested topics, show the angle list to the user for a quick confirm before spending budget.

## Phase 3 — Parallel research

Spawn one sub-agent per angle **in a single message** (parallel). Build each prompt from the locked template in [reference/subagent-prompt.md](reference/subagent-prompt.md) — reproduce it verbatim, replacing only the `{variables}`. Each sub-agent:

- researches ONE angle only, using WebSearch/WebFetch and the free endpoints in [reference/sources.md](reference/sources.md)
- writes structured findings to `findings/F<n>.md` (claim / quote / URL / date / confidence per item)
- returns only a 3-5 line summary to you — raw page content must never enter your context

If a sub-agent fails or returns thin results, note it and move on; do not block other angles.

## Phase 4 — Reflect (gap check)

Read all `findings/*.md`. Against `brief.md`, ask: which parts of the brief have no evidence? Which major claims rest on a single source? Where do sources conflict?

- Gaps found AND follow-up budget remains → spawn targeted sub-agents with delta-queries (same template, narrower angle). Repeat once per remaining round.
- No budget left or coverage sufficient → proceed. Record unresolved gaps; they go in the report's "Open questions".

## Phase 5 — Write (single-point)

You alone write `REPORT.md` in one pass, following [reference/report.md](reference/report.md). Core rules:

- Every non-obvious claim carries an inline citation `[n]` mapping to a Sources section; citation URLs come only from findings files — never from memory.
- Where sources conflict, present both sides with dates; prefer newer + primary sources.
- Mark single-source claims with `[single source]`, speculation with `[speculative]`.
- End with: Open questions · Sources (numbered, with access date).

For deep mode, before finalizing do one critique pass: reread the report as a skeptical reviewer (unsupported claims? stale data? missing counter-view?) and fix in place.

Finally, give the user a 5-10 line summary of key conclusions and the report path.

## Alternative: scripted workflow (unattended runs)

The same pipeline exists as a deterministic workflow script at `/Users/mi/claude-workspace/.mimocode/workflows/deep-research-pro.js` — use it instead of the manual phases above when the run should be fully autonomous, resumable, or batch-invoked. It is convergent: re-running with the same `dir` skips completed phases (brief.md / plan.json / findings/F*.md / reflect.json / REPORT.md act as checkpoints).

Invocation (workflow tool; custom scripts must be passed inline via `script`, not `name`):

```
workflow({
  operation: "run",
  script: <full text of deep-research-pro.js, Read it first>,
  workspace: "<ABS_DIR>",            # same value as args.dir
  args: {
    dir: "<ABS_DIR>",                # e.g. /path/to/research/<slug> — mkdir -p <ABS_DIR>/findings first
    question: "<refined research question>",
    today: "<YYYY-MM-DD>",           # REQUIRED — run `date +%Y-%m-%d` first; sandbox has no Date
    depth: "standard",               # quick | standard | deep
    context: "<audience/language notes, optional>"
  }
})
```

Notes:
- Do HITL clarification BEFORE invoking (the script never asks the user); fold answers into `question`/`context`.
- Interrupted or failed run? Re-invoke with identical args — it resumes from the last checkpoint. `workflow({operation:"resume", run_id})` also works.
- Returns `{ angles, deltaAngles, findingsFiles, reviewCritical, report }`.
