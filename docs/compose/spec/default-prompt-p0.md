---
feature: default-prompt-p0
status: delivered
updated: 2026-09-19
branch: fix/default-prompt-p0
commits: 50cd7139..HEAD
---

# Default System Prompt P0 Cleanup

## Report

**What was built** — `default.txt` is a lean behavioral base prompt (System /
Doing tasks / Executing / Using tools / Skills / Tone). Architecture dumps
(Agent system, native-agent catalog, permission pedagogy, session lifecycle,
plan-mode detail, MCP extension essay) are **gone**. Dispatch is `task` /
`actor` / `workflow` only. Memory is **not** restated (owned by
`buildMemoryInstructions`). compose never appears. Subagent return format is
off the main memory path (spawn `RETURN_FORMAT_INSTRUCTION` + `general.txt`
pointer). `general`/`explore` prompts carry the work-face contract (trust,
casing, parallel budget) and parent-facing reporting.

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
- `bun test test/session/llm-system-prompt.test.ts test/agent/agent.test.ts` — PASS (58)
- compose-next review (`general-2`): 7/7 AC met; nested-spawn ban restored; this Report realigned to HEAD

**Journey log**
1. Memory rewrite was wrong — already in `buildMemoryInstructions`; **delete** the section.
2. Help is a TUI shim — delete the whole help/feedback block.
3. Over-slashed then restored Agent system; final product call: **architecture out of base sys** (mimocode-docs / tool desc own it); tests lock the slim shape.
4. Subagent return format belongs on spawn task injection, not the main memory block.
5. `general` must keep a nested-spawn ban: `toolAllowlist` is unset so it can inherit `actor`.

## [S1] Problem

`default.txt` mixed Claude Code brand residue, invented dispatch tools, a
wrong Memory block, compose advertising, and tool-limit/path dumps that
duplicate real injectors — while the architecture prose (Agent system, skills
rules, session, MCP, trust) is still needed.

## [S2] Design

Base sys = behavior + trust + tool routing + skills roots + tone. Delete wrong,
branded, or already-injected content. Architecture lives in tool descriptions /
mimocode-docs / runtime injectors. compose never appears. Return format is
spawn-owned. `general` forbids nested spawn.

See Report tables.

## [S3] Out of Scope

- Sibling prompts (`compose.txt`, `anthropic.txt`, `glm.txt`, …) residuals.
- Changing `buildMemoryInstructions` or skills catalog injection.
- Further slimming of Agent-system pedagogy beyond the deletions above.

## Tasks

- [x] T1: Strip Claude brand + help/feedback + fix dispatch/tool ids
- [x] T2: Delete Memory section (owned by `buildMemoryInstructions`)
- [x] T3: Drop compose line, skill path dumps, workflow numeric limits (tool desc)
- [x] T4: Slim base sys (no Agent-system dump); Skills + trust kept; subagent prompts carry work-face + parent reporting + nested-spawn ban
- [x] T5: Regression test + verify
