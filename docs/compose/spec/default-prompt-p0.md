---
feature: default-prompt-p0
status: delivered
updated: 2026-09-19
branch: fix/default-prompt-p0
commits: 50cd7139..ac7bbf66
---

# Default System Prompt P0 Cleanup

## Report

**What was built** — `default.txt` is a lean behavioral base prompt (System /
Doing tasks / Executing actions with care / Using your tools / Skills / Tone).
Architecture dumps (Agent system, native-agent catalog, permission pedagogy,
session lifecycle, plan-mode detail, MCP essay) are gone. Dispatch is `task` /
`actor` / `workflow` only. Memory is not restated (owned by
`buildMemoryInstructions`). compose never appears in base sys. Subagent return
format is off the main memory path (spawn `RETURN_FORMAT_INSTRUCTION` +
`general.txt` pointer); `general` keeps a nested-spawn ban and the
inspect/verify work-face.

`general`/`explore` carry work-face (case-sensitive snake_case tool ids,
parallel 1–3 / ≤8, trust-as-data) and parent-facing reporting. Model-facing
injectors across default, memory, recall hints, budgeted-read, truncate,
checkpoint render/reconcile, checkpoint-writer, dream/distill, write, and
workflow builtins use registered tool ids; bare `glob`/`grep` are qualified as
“the `glob` tool” / “the `grep` tool” when they could be read as shell.
Sibling provider prompts (`glm.txt`, `deepseek.txt`, `minimax.txt`, …) brand
residuals are deferred follow-up (S3).

**Deletion → injection site** (every removed block names who still carries it):

| Deleted from `default.txt` | Still injected / owned by |
|---|---|
| `### Memory` + CC store / four types | `session/llm.ts` `buildMemoryInstructions` → `# Memory system` (main/peer) |
| `## Subagent return format` (also removed from memory block) | `actor/spawn.ts` `RETURN_FORMAT_INSTRUCTION` for gate-eligible children (`general` via `completionGate`); `general.txt` points at required format |
| Help/feedback (`/help`, issue URL) | Not re-injected — TUI chrome only |
| Claude brand / anthropics / CLAUDE.md | N/A; durable instructions are `AGENTS.md` |
| compose / Agent-system / Session lifecycle / Plan-mode detail / MCP essay | Tool descriptions, `agent.ts`, `prompt.ts` plan reminder, `plan-exit.txt`, mimocode-docs |
| Skills brand-path dumps | Named only `.mimocode/skill(s)` + `.agents/skills`; other roots unnamed |
| Workflow numeric limits / “shared token budget” | `workflow` tool description / config |
| Wrong tool ids (`Agent tool`, `task_*`, `plan-exit`, …) | Registry snake_case ids |

**What stayed (on purpose)** — identity + security IMPORTANTs; System
(permissions, tool surface, system-reminder, DATA-as-data, memory-stale,
compress); Doing tasks + Executing (blast radius); Using tools (case-sensitive
snake_case, parallel 1–3 / ≤8, `task`/`actor`/`workflow` routing); Skills
rules + two real roots; Tone (progress rhythm, end-of-turn summary).

**Verification** — From `packages/opencode`:
- `bun typecheck` — PASS
- `bun test test/agent/agent.test.ts` — PASS (52)
- `bun test test/session/llm-system-prompt.test.ts` — PASS
- `bun test test/session/prompt.test.ts test/session/budgeted-read.test.ts` — PASS (65)
- `bun test test/session/checkpoint-render-verify.test.ts` — PASS
- CI on `ba2312c1` — lint / typecheck / unit 1–4 SUCCESS
- `0543ef5a` (Turn 1 `read` casing + `glob` tool qualifiers) — prompt-only; pre-push typecheck PASS
- compose-next review: acceptance criteria met after casing + general inspect/verify follow-ups

**Journey log**
1. Memory rewrite was wrong — already in `buildMemoryInstructions`; **delete** the section.
2. Over-slashed then restored Agent system; final product call: **architecture out of base sys** (mimocode-docs / tool desc own it); tests lock the slim shape.
3. Subagent return format belongs on spawn task injection, not the main memory block.
4. `general` must keep a nested-spawn ban and inspect/verify work-face: `toolAllowlist` is unset so it can inherit `actor`; without verify bullets the parent-report contract is unimplementable.
5. Tool-name casing across **all injectors**: English imperatives stay plain English (`Read all sources`, `Glob \`pattern\``, `Read CHECKPOINT_PATH`). When naming the registered tool, use `Use \`glob\` with …` / `the \`grep\` tool` / call form `glob("…")` — never jam a backticked id in front of an argument (`` `glob` `path` `` is unreadable). Prefer registered snake_case ids over `Grep`/`Read tool` prose when the word means the tool.

## [S1] Problem

`default.txt` mixed Claude Code brand residue, invented dispatch tools, a
wrong Memory block, compose advertising, and tool-limit/path dumps that
duplicate real injectors — while the architecture prose (Agent system, skills
rules, session, MCP, trust) is still needed. Memory/tool descriptions also
advertised capitalized tool names (`Grep`/`Read`/`Edit`) that violate the
case-sensitive registered-id rule.

## [S2] Design

Base sys = behavior + trust + tool routing + skills roots + tone. Delete wrong,
branded, or already-injected content. Architecture lives in tool descriptions /
mimocode-docs / runtime injectors. compose never appears. Return format is
spawn-owned. `general` forbids nested spawn. Tool names in every model-facing
injector use exact registered ids when naming the tool (`Use \`glob\` with …`,
`the \`grep\` tool`, `glob("…")`); leave English imperatives as plain English.
Do not jam a backticked id in front of an argument.

See Report tables.

## [S3] Out of Scope

- Sibling prompts (`compose.txt`, `anthropic.txt`, `glm.txt`, `deepseek.txt`, `minimax.txt`, …) residuals — deferred follow-up.
- Changing `buildMemoryInstructions` or skills catalog injection.
- Further slimming of Agent-system pedagogy beyond the deletions above.

## Tasks

- [x] T1: Strip Claude brand + help/feedback + fix dispatch/tool ids
- [x] T2: Delete Memory section (owned by `buildMemoryInstructions`)
- [x] T3: Drop compose line, skill path dumps, workflow numeric limits (tool desc)
- [x] T4: Slim base sys (no Agent-system dump); Skills + trust kept; subagent prompts carry work-face + parent reporting + nested-spawn ban
- [x] T5: Regression test + verify
