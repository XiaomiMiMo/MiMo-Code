---
feature: default-prompt-p0
status: delivered
updated: 2026-09-19
branch: fix/default-prompt-p0
commits: 50cd7139..HEAD
---

# Default System Prompt P0 Cleanup

## Report

**What was built** — `default.txt` keeps its behavioral + **Agent system**
architecture (modes, native agents, permission model, tasks/actors/workflows,
skills rules, session lifecycle, plan mode, MCP, trust). Removed only what is
wrong, branded, or already injected elsewhere: Claude Code / help-feedback,
Agent/Task as dispatch names, the Memory section, the compose agent line,
skills **discovery-path dumps**, and workflow hard-limit numbers (those belong
in the `workflow` tool description).

**Deletion → injection site** (every removed block names who still carries it):

| Deleted from `default.txt` | Still injected / owned by |
|---|---|
| `### Memory` (CC `~/.claude` store, four frontmatter types, parent-system meta) | `session/llm.ts` `buildMemoryInstructions` → `# Memory system` (main/peer). See `docs/compose/spec/memory-prompt-decouple.md`. |
| `memory-path-guard` write-exemption copy | Runtime `tool/memory-path-guard.ts`; writer whitelist in `agent/prompt/checkpoint-writer.txt` |
| Help/feedback block (`/help`, issue URL) | **Not re-injected** — TUI chrome only (`tui.tips.help`). Sys stays free of UI shims. |
| Claude identity / anthropics issues / CLAUDE.md as durable-authority example | N/A brand residual; durable example is `AGENTS.md` (`session/instruction.ts`) |
| **compose** native-agent line | Skill descriptions inject `/compose-next` guidance; `agent.ts` marks compose deprecated. Base sys must not advertise compose. |
| Skills discovery roots: only **`.mimocode/skill(s)`** + **`.agents/skills`**, other brands unnamed | `skill/index.ts` scans MiMoCode-native `{skill,skills}` and standard `.agents/skills`, plus unlisted brand compat dirs. Sys names the two real roots and says "other brand compatibility roots" without advertising which brands. |
| Workflow hard limits (12h / ≤1000 / concurrency 16 / **shared token budget**) | `workflow` tool description + `workflow/runtime.ts` / `workflow.maxConcurrentAgents` config. "Shared token budget" has no runtime — dropped entirely. |
| `task_*` / `completed` / `Agent tool` / `plan-exit` / `notebook-edit` / permission-mode wording | Registry ids: `task` (`done`), `actor`, `plan_exit`, `notebook_edit`; permission is `allow`/`ask`/`deny` rules. |

**What stayed (on purpose)** — Agent modes; native agents (**build / plan / max**,
**general / explore / title-summary-compaction / checkpoint-writer** — no
compose); `runtimePermission` layering; Using your tools; Tasks vs subagents vs
workflows (workflow details deferred to tool desc); Skills rules + roots
**`.mimocode` / `.agents`** (other brands unnamed); Session lifecycle; Plan
mode detail; MCP extension points; Trust boundaries; Tone + Text output.

**Verification** — From `packages/opencode`:
- `bun typecheck` — PASS
- `bun test test/agent/agent.test.ts` — PASS (52 pass / 0 fail); asserts
  Agent-system sections **present**, and `compose` / skill-path dumps /
  `### Memory` / workflow limit numbers / Claude brand **absent**

**Journey log**
1. Memory rewrite was wrong — correct content is already in `buildMemoryInstructions`; **delete the section**.
2. Help is a TUI shim — delete the whole help/feedback block, do not rename it.
3. Over-slashed Agent system after "删减" feedback; user clarified: only compose
   must vanish (compose-next lives in skill desc) and skills **lists** / tool
   numeric limits stay out — **restore** architecture sections.
4. Final rule of thumb: base sys owns architecture & behavior; injectors own
   catalogs/paths/memory; tool descriptions own per-tool APIs and limits.

## [S1] Problem

`default.txt` mixed Claude Code brand residue, invented dispatch tools, a
wrong Memory block, compose advertising, and tool-limit/path dumps that
duplicate real injectors — while the architecture prose (Agent system, skills
rules, session, MCP, trust) is still needed.

## [S2] Design

Keep architecture + behavior. Delete only wrong/branded/already-injected
content. compose never appears in base sys. Skills: rules only, catalog from
injection. Workflow: usage policy only; API/limits in tool desc.

See Report tables.

## [S3] Out of Scope

- Sibling prompts (`compose.txt`, `anthropic.txt`, `glm.txt`, …) residuals.
- Changing `buildMemoryInstructions` or skills catalog injection.
- Further slimming of Agent-system pedagogy beyond the deletions above.

## Tasks

- [x] T1: Strip Claude brand + help/feedback + fix dispatch/tool ids
- [x] T2: Delete Memory section (owned by `buildMemoryInstructions`)
- [x] T3: Drop compose line, skill path dumps, workflow numeric limits (tool desc)
- [x] T4: Keep/restore Agent system, Skills rules, Session, Plan, MCP, Trust
- [x] T5: Regression test + verify
