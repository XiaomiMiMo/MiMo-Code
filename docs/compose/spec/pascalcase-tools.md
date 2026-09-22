---
feature: pascalcase-tools
status: delivered
updated: 2026-09-22
branch: codex/pascalcase-tools
commits: b8edacb7..299d9055
---

# Default PascalCase Tool Surface

## Report

**What was built** — Known default internal tools expose PascalCase schemas for
MiMo v2.6 by default. MIMOCODE_PASCAL_CASE_TOOLS can explicitly enable or disable
this behavior. Model requests project tool schemas and history; returned calls
restore canonical IDs before session processing. GPT/Codex and MCP names remain
unchanged. Primary system, memory, and first-user reminder text uses display names.

**Verification** — Run from packages/opencode:

- PASS after prompt simplification: `bun test test/agent/agent.test.ts` — 52 passed, 0 failed; after the final Compose wording edit, `bun test test/agent/agent.test.ts --test-name-pattern 'default system prompt|compose'` — 4 passed, 0 failed. Independent review of this correction passed.

- PASS: `bun typecheck`.
- PASS: `bun run script/build-node.ts`.
- PASS: `bun test test/tool/names.test.ts test/session/pascalcase-tools.test.ts test/flag/pascal-case-tools-flag.test.ts test/session/prefix-snapshot.test.ts test/session/llm-request-prefix.test.ts` — 22 passed, 2 existing skips, 0 failed after scope reduction.
- PASS before scope reduction: `bun test test/session/pascalcase-tools.test.ts test/flag/pascal-case-tools-flag.test.ts test/tool/names.test.ts test/session/prefix-snapshot.test.ts test/session/llm-system-prompt.test.ts test/util/tool-compat.test.ts test/agent/agent.test.ts test/session/prompt.test.ts test/tool/registry-invocation-style.test.ts test/tool/gpt.test.ts test/session/toolcall-flooding.test.ts` — 185 passed, 4 existing skips, 0 failed.
- Independent review of the final implementation: spec compliance, correctness,
  and codebase consistency passed; no outstanding findings within scope.

**Journey log**

- Confirmed the lowercase schema failure before implementing the mapping; real
  Write/Read execution then verified canonical persistence and history replay.
- Kept display labels independent of schema casing so other models retain their
  existing callable names.
- Removed custom override/collision handling and shared exec changes to match
  the urgent repair scope.
- Review identified missing naming metadata in captured request prefixes; fixed
  propagation and passed the affected-area re-review.
- Simplified casing guidance to the exact registered-name rule; removed examples
  and display/schema explanations. Capitalized tool references use plain text.

## [S1] Problem

MiMo v2.6 handles PascalCase tool schemas better than the lowercase built-in
names currently advertised by the default harness. Prioritize the actual model
schema and the system, memory, and first-user reminder instructions. Occasional
lowercase references in other prose are acceptable for this delivery.

## [S2] Design

Keep canonical internal tool IDs, permissions, hooks, persisted tool parts, and
downstream events unchanged. Give built-in definitions an explicit model-facing
name when PascalCase exposure is enabled: Read, Grep, Glob, Edit, Write, Bash, NotebookEdit,
Actor, Task, Session, Memory, History, Skill, SkillSearch, Question, WebFetch,
WebSearch, CodeSearch, LSP, PlanExit, Cron, and Workflow.
Internal sentinels, the shared exec gateway, and mcp_tool_search are excluded. Existing availability gates
remain. MIMOCODE_PASCAL_CASE_TOOLS is a tri-state environment switch: true/1
enables projection, false/0 disables it, and unset defaults to enabled only when
a model ID or API model ID contains mimo-v2.6 (case insensitive), including
flash/pro/pro-ultraspeed variants. GPT/Codex mode always keeps its own names.

Project tool schemas and paired historical tool calls/results to those names
before the model request. Dispatch returned calls through the canonical
executors and convert event names back before session processing. Use exact
declared names, not general case folding. Map only the explicit known internal tool IDs; MCP and other tool names remain
unchanged. Custom overrides or collisions with built-in names are out of scope. Preserve naming
metadata through prefix snapshots so fork/rebuild contexts stay consistent.

GPT/Codex tool surfaces, including exec, exec_command, apply_patch, view_image,
and nested tools, retain their existing names. Harness selection follows the
existing model/override rules. Prompt descriptions use display labels such as Read, Grep, Glob and Edit
independently of the casing switch; callers must use the exact current schema
name. Shared memory/reminder text must use the tools available in that harness. Update the principal default system instructions and
direct memory/first-user reminders; do not rewrite user text or memory contents.

Verify requests and executions, not just a name table: actual schema names,
history pairing, internal execution/events, permission filtering, strict lookup,
MCP names, model-specific defaults and both explicit switch overrides,
Codex exclusion, and snapshot restoration.

## [S3] Out of Scope

- Emergency scope: no custom overrides of built-in tools, display-name collision
  handling, or changes to the shared exec gateway.
- Exhaustive prompt/tool-description/workflow/skill cleanup.
- TUI/CLI display renaming and internal ID or database migrations.
- Changing tool parameters, capabilities, or availability.

## Tasks

- [x] T1: Project default built-in names at the model boundary — acceptance: MiMo v2.6 automatically advertises PascalCase, other models stay lowercase, explicit true/false override both defaults; calls execute through unchanged canonical IDs; GPT and MCP tool names remain intact; history and prefix snapshots retain correct names (covers: S2).
- [x] T2: Align primary system, memory and first-user reminders — acceptance: guidance uses display names independently of schema casing; GPT guidance retains its own tools without rewriting user content (covers: S2).
- [x] T3: Verify and independently review — acceptance: focused behavioral tests, package typecheck and Node build pass or documented baseline failures are identified; no critical review findings remain (covers: S2; depends: T1, T2).
