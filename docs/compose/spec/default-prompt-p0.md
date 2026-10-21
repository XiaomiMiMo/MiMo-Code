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

**Verification** — From `packages/cli`:
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

### Per-turn caller instructions

`PromptInput` and `CommandInput` accept optional `promptContext` v1: `{ system: string, systemMode: "append" | "replace-agent", instructions: string }`. Both the stable base and current instructions are explicit, including the empty string. The complete object persists on its user message. Missing context preserves the legacy first-user `Session.resolvePrompt` contract; an opted-in message selects its own declared stable base without mutating the session's legacy configuration or rewriting old messages.

The model loop and checkpoint prefix capture resolve the same message-owned context. The profile key and `SessionPrefixSnapshot` store only the stable system; `instructions` are appended after that frozen system for main/peer actors, using the existing `servesCheckpoint` boundary. Fresh or restored turns read the submitted user message, never a mutable global preference. Full-context forks capture the exact parent request prefix. Empty instructions remove prior per-turn instructions without string surgery. An existing session's first new base gets its own profile snapshot, preserving its identity/history and preventing embedded legacy custom instructions from leaking into the new request.

The native Node entry exports `PROMPT_CONTEXT_VERSION=1` so Desktop can require the contract before sending it. No context is injected into visible user parts, and no client capability claim substitutes for this version check. Regression tests keep legacy first-system semantics and cover A→B→empty, durable message context, stable-prefix reuse, actor boundaries, and actual model requests.

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

R14 压缩模型请求与普通回合共用 Actor 作用域的指令追加；冻结快照继续仅含稳定前缀，边界消息继承配置用于恢复，不表示新用户输入。

### Actor invocation identity (Desktop R23/R24)

```text
Actor tool / subtask invocation (session, call, parent input)
  → ActorRegistry (durable creation source)
  → runTurn / beginExecution (atomic next execution generation)
  → work / hook continuations
  → generation-conditional settlement
  → actor HTTP + events → Desktop EngineInstanceStore
Task create/start → TaskRegistry (explicit source call) → task HTTP + events
```

The Actor creation source is an optional complete `sourceSessionID/sourceCallID/sourceTurnID` tuple. It comes from the invoking tool's actual assistant message and parent input, never adjacent history or display names; continuations preserve that creation source. Older rows have no source. Peer sources retain their actual source session and consumers must not resolve them in the child's session.

`executionGeneration` is a positive decimal string backed by a nullable integer column. `beginExecution` atomically increments it once per admitted `runTurn`, including independent continuation, direct main shell execution and interrupted-run recovery. Model steps and hooks inside one execution do not increment it. Resume admission revalidation precedes generation allocation; rejected stale requests leave the registry unchanged. Settlement carries the captured generation into a conditional database write and publishes only the row actually updated. For an existing session imported without its root registry row, admission materializes only its canonical main identity using the same defaults as session creation; it never invents child actors. A child without a registry row gets no generation (`beginExecution` warns and returns none) and `runTurn` still executes its work, as before generations existed. Every `updateStatus` must state `expectedGeneration`; `null` only matches rows that have no generation yet. Legacy rows remain unknown until executed; step counts and timestamps are not generations.

Task creation/start accepts an optional explicit source call. Reassigning an owner without a source clears the previous association. A tool operating on another session cannot attach its own session's call as that session's source. Existing schemas gain optional fields and additive nullable migrations; old clients may ignore them.

The additive migration is `migration/20261021000000_actor_provenance`, ordered after the latest upstream migration (`20261013000000_inbox_queue`). The pinned Drizzle migrator applies every local migration whose name is not yet journaled, so an already-upgraded database receives it; databases created by the Desktop candidate under the earlier `20261008000000_actor_provenance` name replay the same ALTERs, which `migrateReplaySafe` treats as already applied while keeping existing values (`test/storage/actor-provenance-migration.test.ts`). Main execution generations are allocated by `mainActorTurn` inside the Runner-admitted work only: `executeLoop` wraps a prepared (claimed) main run, `shell` wraps after its lease guard, and resume wraps `work` after `admit` revalidation and the stale-lease guard. Runner joiners, empty claims and rejected resumes allocate nothing.

Regression points: Desktop TP-R23-05 (durable source/generation and stale settlement), TP-R24-04 (task invocation association). Engine tests cover real SQLite writes, event payloads, lifecycle success/failure/cancellation, two generations and stale writes; Desktop verifies HTTP, live events, reconnect and reference reduction.
