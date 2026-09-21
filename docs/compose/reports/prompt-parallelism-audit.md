# Parallel Tool Prompt Audit

Audited base: `origin/main` at `4489fe50`. Branch: `codex/prompt-parallelism-audit`.
The inventory and line references below describe that audited base. The worktree
now also contains the prompt changes summarized here.

## Implemented changes

- Removed the speculative-batching sentence from glob.
- Changed actor JSON, shell and schema wording to describe focused background
  delegation, with optional concurrency for needed independent assignments.
- Weakened plan-mode and model-specific prompts from imperative parallelism to
  permission when useful. Dependent calls still wait for their inputs.
- Made exec's introductory example a single call; retained optional Promise.all
  composition and its concurrency ceiling.
- Matched the deep-research workflow prompt and its bundled template: start with a
  focused query, refine from evidence, and combine only needed independent queries.
- Softened the audited Compose/research/sales skill instructions without changing
  their workflow implementations or removing concurrency support.
- Retained the 1–3/eight-call guidance, valid read batching, dependency rules, and
  the existing preference for nonblocking spawn over blocking run.

Verification from `packages/opencode`:

```sh
bun test test/tool/actor-prompt-spawn-first.test.ts \
  test/tool/registry-invocation-style.test.ts \
  test/session/plan-reminder-dedup.test.ts \
  test/session/llm-system-prompt.test.ts \
  test/skill/builtin.test.ts test/skill/bundle-discovery.test.ts \
  test/skill/compose-review.test.ts test/workflow/builtin.test.ts \
  test/workflow/deep-research-cluster.test.ts
bun typecheck
```

- PASS: 66 tests, 207 assertions, zero failures. Four pre-existing GPT registry
  tests remain skipped; their skip status was not changed.
- PASS: package typecheck.
- PASS: changed-code `bunx oxlint --format json`, no new diagnostics. Its 59
  existing warnings point to unchanged lines.
- PASS: `git diff --check`; `bun ci` left `bun.lock` unchanged.
- Source search confirms the targeted speculative/all-at-once imperatives are
  removed from active descriptions. Historical, unreferenced prompts remain as
  identified in the original audit.

## Findings for the supplied screenshot

| Screenshot claim | Current source | Assessment |
| --- | --- | --- |
| System prompt prefers 1–3 **parallel** calls, at most 8 | `session/prompt/default.txt:46` says “Prefer 1–3 tool calls per step. Avoid more than 8 calls in a single step.” | Keep the quantity guidance. The word “parallel” was removed by #2456. These are prompt instructions; the flooding guard enforces its separate threshold at call 17. |
| Both glob and grep say speculative batching is always better | Exact sentence occurs once, in `tool/glob.txt:6`. It is absent from current `tool/grep.txt`. | Remove the glob sentence. It promotes hypothetical usefulness rather than identified information needs. |
| read says “Call this tool in parallel” | `tool/read.txt:12` now says “You may issue several `read` calls in one step when you already know which files you need.” | Keep. #2456 replaced the imperative with bounded permission for known targets. Valid read/search calls can actually run together in the gate. |
| bash says to make multiple calls in one message | Removed by #2456. Current `tool/bash.txt:44` discusses ordering dependent commands instead. | No remaining instance to remove. Bash calls are exclusive in the current gate; same-message calls are not simultaneous bash execution. |
| bash git sections repeat parallel-performance advice | Both duplicated passages were removed by #2456. Current context gathering and commit steps no longer demand parallel calls. | Already addressed. Independent git inspections can be logically independent, but the tool description should not promise execution parallelism. |

The 1–3/eight-call guidance is also present in `agent/prompt/explore.txt:24`,
`agent/prompt/general.txt:37`, and the flooding reminder. `tool/tool-script.txt:43`
separately limits concurrent exec guest calls to eight. The screenshot's claim
that there is only one numeric limit is not accurate for the current sources.

## Inventory and counting scope

There are **13 relevant instruction blocks in 11 core files**, **8 selected
instruction blocks in 7 bundled skill/reference files**, and **7 legacy blocks
in 2 currently unreferenced prompt files**. The repository's own AGENTS.md adds
one project-local instruction. These are review candidates, not 29 defects and
not 29 instructions loaded into one request.

Count logical instruction/example blocks once, even when they span lines.
Include actionable batching or parallel-dispatch advice. Exclude code concurrency,
API descriptions that only explain background execution, negative instructions,
task-status batching, document/data batches, and historical reports/tests.
The skill inventory identifies relevant instruction blocks rather than every
mention of “parallel” in descriptions and examples.

## Core instruction blocks

| # | Location | Advice | Assessment |
| --- | --- | --- | --- |
| 1 | [tool/glob.txt:6](../../../packages/opencode/src/tool/glob.txt#L6) | Speculatively batch potentially useful searches; always better. | Remove. Unconditional speculation encourages work without an identified need. |
| 2 | [tool/read.txt:12](../../../packages/opencode/src/tool/read.txt#L12) | Several reads in one step when the required files are already known. | Keep. Known targets, no instruction to invent extra reads. |
| 3 | [tool/actor.txt:55](../../../packages/opencode/src/tool/actor.txt#L55) | Parallelize is the normal case; spawn every independent search/analysis at once. | Consider narrowing. Independence alone does not justify a separate agent for every possible search. |
| 4 | [tool/actor.shell.txt:55](../../../packages/opencode/src/tool/actor.shell.txt#L55) | Parallel investigations are the normal shape; spawn them all. | Consider narrowing alongside the JSON description; this is the shell variant. |
| 5 | [session/prompt.ts:1649](../../../packages/opencode/src/session/prompt.ts#L1649) | Spawn explore/general subagents for parallel research. | Conditional: plan mode. Preserve useful delegation; avoid making parallelism itself the objective. |
| 6 | [session/prompt.ts:1671](../../../packages/opencode/src/session/prompt.ts#L1671) | Launch up to three explore agents in parallel. | Generally reasonable: adjacent text explicitly prefers the minimum, usually one, and requires separate focuses. |
| 7 | [session/prompt/gpt.txt:81](../../../packages/opencode/src/session/prompt/gpt.txt#L81) | Batch independent calls with Promise.all; keep dependencies sequential. | Keep the dependency rule and exec API contract. This does not endorse speculative searches. |
| 8 | [session/prompt/gpt.txt:190](../../../packages/opencode/src/session/prompt/gpt.txt#L190) | Parallelize independent work; inspect failures and adapt. | Generally reasonable; may be redundant with line 81. |
| 9 | [tool/tool-script.txt:12](../../../packages/opencode/src/tool/tool-script.txt#L12) | Exec can batch independent calls with Promise.all/Promise.allSettled. | API guidance; retain independence and sequential dependencies. Concurrency is separately capped at eight. |
| 10 | [session/prompt/kimi.txt:13](../../../packages/opencode/src/session/prompt/kimi.txt#L13) | Multiple calls when work requires several steps; sequence dependent shell commands. | Potential ambiguity: number of steps alone is not a reason to precompute all calls. Model-specific, not the MiMo default. |
| 11 | [session/prompt/deepseek.txt:56](../../../packages/opencode/src/session/prompt/deepseek.txt#L56) | Use actor for parallel independent investigations. | Reasonable scoped delegation guidance with explicit exclusions for trivial lookups. |
| 12 | [session/prompt/minimax.txt:60](../../../packages/opencode/src/session/prompt/minimax.txt#L60) | Use actor for parallel independent investigations. | Same as DeepSeek; model-specific. |
| 13 | [workflow/builtin/deep-research.js:49](../../../packages/opencode/src/workflow/builtin/deep-research.js#L49) | Start with two or three differently phrased queries in parallel. | Intentional bounded research strategy inside an explicitly invoked workflow; not a general search default. |

The only unambiguous deletion in the current basic search-tool descriptions is
`glob.txt:6`. The two actor “normal case / every / all” passages are candidates
for more selective wording, not reasons to remove parallel delegation itself.
Correct independent-work guidance and explicit ordering rules should remain.

`grep.txt:8` and `glob.txt:5` also route open-ended searches to actor. They do
not instruct simultaneous searches, so they are not counted above. If task
inflation is observed, review their delegation threshold separately.

## Bundled skills and references

| # | Location | Advice |
| --- | --- | --- |
| 1 | [skill/compose/.bundle/parallel/SKILL.md:12](../../../packages/opencode/src/skill/compose/.bundle/parallel/SKILL.md#L12) | Parallel investigation per independent problem domain; broad time-saving rationale. |
| 2 | [skill/compose/.bundle/parallel/SKILL.md:54](../../../packages/opencode/src/skill/compose/.bundle/parallel/SKILL.md#L54) | One concurrent dispatch per independent domain in the same turn. |
| 3 | [skill/builtin/.bundle/deep-research/SKILL.md:54](../../../packages/opencode/src/skill/builtin/.bundle/deep-research/SKILL.md#L54) | One research subagent per angle in a single message. |
| 4 | [skill/builtin/.bundle/deep-research/reference/subagent-prompt.md:24](../../../packages/opencode/src/skill/builtin/.bundle/deep-research/reference/subagent-prompt.md#L24) | Begin with two or three differently phrased parallel searches. |
| 5 | [skill/builtin/.bundle/compose-next/SKILL.md:126](../../../packages/opencode/src/skill/builtin/.bundle/compose-next/SKILL.md#L126) | Dispatch independent tasks in parallel when isolation prevents collisions. |
| 6 | [skill/builtin/.bundle/super-research/references/paper-writing.md:94](../../../packages/opencode/src/skill/builtin/.bundle/super-research/references/paper-writing.md#L94) | Batch citation checks with subagents for long bibliographies. |
| 7 | [skill/builtin/.bundle/super-research/references/topic-survey.md:91](../../../packages/opencode/src/skill/builtin/.bundle/super-research/references/topic-survey.md#L91) | Extract across papers with subagents in batches of three to five. |
| 8 | [skill/builtin/.bundle/sales/workflows/analyze-account-signals/SKILL.md:74](../../../packages/opencode/src/skill/builtin/.bundle/sales/workflows/analyze-account-signals/SKILL.md#L74) | Parallelize independent account lookups with a cap of ten and failure handling. |

These bodies are loaded when their skill or reference is used; a skill's metadata
may be advertised before its body is loaded. They serve explicit workflows.
Do not remove their parallel strategy solely because it contains the word
“parallel.” In particular, isolated Compose tasks, bounded literature extraction,
and independent lookups have different requirements from speculative tool spam.

## Legacy and project-local text

- `session/prompt/default.old.txt`: lines 59, 95, and 136 contain concurrent-read,
  extensive parallel-search, and mandatory parallel-bash wording.
- `session/prompt/copilot-gpt-5.txt`: lines 16, 82, 95, and 121 encourage multiple
  calls, including calling several tools when unsure which is relevant.
- No imports or references to either legacy filename were found in current source
  or build scripts. `session/system.ts` uses explicit imports and routing to the
  current prompts. Editing these files would not change the ordinary MiMo request.
- Root `AGENTS.md:7` says “ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.” This is a
  project-local instruction that can affect sessions working in this repository;
  it is not a shipped global tool description. Its scope should be considered
  separately from the product prompts.

## Runtime reachability

- `session/system.ts` routes ordinary MiMo models to `default.txt`, unless an agent
  supplies its own prompt or the Codex harness/model routing selects another prompt.
- `tool/registry.ts` advertises read/grep/glob in the normal toolset. GPT/Codex mode
  exposes exec and the GPT toolset instead; exec may also be explicitly enabled.
- Actor descriptions use JSON by default; `tool/invocation-style.ts` selects the
  shell variant only through configuration. JSON and shell descriptions are
  alternate surfaces, not duplicate instructions always injected together.
- The plan reminders are injected only in plan mode. Kimi, DeepSeek, MiniMax and
  GPT prompts are selected by model/harness; they are not additional paragraphs
  on top of the MiMo default.
- Workflow-generated research prompts and bundled skill bodies require their
  corresponding workflow/skill invocation. Their async runtime/API explanations
  were inspected but not counted as instructions to issue more tool calls.

## Evidence

- Exact and case-insensitive searches across session prompts, tool descriptions,
  generated prompts, agent prompts, command templates, and hidden bundled skills.
- Read current tool definitions, system-prompt routing, invocation-style selection,
  and the FIFO gate's readonly/exclusive classification.
- `git show 4101b3d4` confirms the screenshot's read/bash/system wording was
  changed by “sequence multi-tool calls within each agent step” (#2456).
- No dependency installation or runtime tests were needed for this source audit.
