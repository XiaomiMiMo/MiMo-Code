---
feature: pascalcase-tools
status: delivered
updated: 2026-09-22
branch: codex/pascalcase-tools
commits: 090af8c9..be5425d1
---

# Default PascalCase Tool Surface

## Report

**What was built** — Known default internal tools expose PascalCase schemas when
the model ID or API model ID contains mimo-v2.6, case-insensitively and independent
of provider. MIMOCODE_PASCAL_CASE_TOOLS overrides this default. Request schemas
and history use the same names; execution, permissions, events, and persistence
retain canonical IDs. GPT/Codex, external MCP names, and the shared exec gateway
remain unchanged.

Explicit tool references in primary prompts, shared reminders, common tool
descriptions, and compose-next use plain display names. Ordinary action verbs
remain ordinary English. Invalid-tool recovery lists only exposed active tools.
Flooding recovery preserves the admitted first call's identity and actual result.

**Verification** — Run from packages/opencode:

- PASS: `bun typecheck`.
- PASS: `bun run script/build-node.ts`.
- PASS: `bun test test/session/pascalcase-tools.test.ts test/session/tool-safety-flags.test.ts test/session/toolcall-flooding.test.ts test/session/toolcall-flooding-stream.test.ts test/tool/names.test.ts test/flag/pascal-case-tools-flag.test.ts test/session/prefix-snapshot.test.ts` — 54 passed, 0 failed after rebase and flooding integration fix.
- PASS: `bun test test/session/pascalcase-tools.test.ts test/session/invalid-tool-cascade.test.ts test/util/tool-compat.test.ts` — 41 passed, 0 failed after invalid-tool guidance fix.
- Earlier prompt verification: `bun test test/agent/agent.test.ts` — 52 passed, 0 failed.
- Direct and API-alias matching checks passed for provider-prefixed and mixed-case
  MiMo v2.6 flash/pro/pro-ultraspeed IDs, including a non-Xiaomi provider.
- Independent complete-diff review and affected-area follow-ups passed for spec
  compliance, correctness, and codebase consistency.

**Journey log**

- Confirmed lowercase schema failure before implementation; real Write/Read
  execution verifies canonical persistence and subsequent history replay.
- Limited the patch to known internal tools and explicit tool references; removed
  custom override/collision handling and unnecessary prose explanations.
- Review identified missing naming metadata in captured request prefixes; fixed
  propagation and passed re-review.
- Rebased onto main's first-tool flooding behavior. Reproduced 18 persisted parts
  instead of 17; forwarding releasedCallID preserves the first actual result.
- Invalid-tool names were already projected correctly by the SDK, but its error
  listed hidden tools. Using activeTools makes suggestions match request schemas.

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
Preserve releasedCallID while restoring flooding error names; unknown-tool
recovery must list the exposed active tools.

GPT/Codex tool surfaces, including exec, exec_command, apply_patch, view_image,
and nested tools, retain their existing names. Harness selection follows the
existing model/override rules. Prompt descriptions use display labels such as Read, Grep, Glob and Edit
independently of the casing switch; callers must use the exact current schema
name. Only explicit tool references use display names; ordinary action verbs
remain ordinary English. Shared reminders use plain display names across harnesses. Update the principal default system instructions and
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
- [x] T2: Align primary system, memory and first-user reminders — acceptance: guidance uses display names independently of schema casing; shared reminders use plain display names across harnesses without rewriting user content (covers: S2).
- [x] T3: Verify and independently review — acceptance: focused behavioral tests, package typecheck and Node build pass or documented baseline failures are identified; no critical review findings remain (covers: S2; depends: T1, T2).
