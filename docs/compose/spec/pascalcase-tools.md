---
feature: pascalcase-tools
status: in-progress
updated: 2026-09-22
branch: codex/pascalcase-tools
commits:
---

# Default PascalCase Tool Surface

## Report

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
- Editing mimo-desktop. Its later integration needs an engine pin update and
  its own overriding system prompt/skills adjusted; stable internal IDs preserve
  the existing event, permission, history, diff, and artifact consumers.

## Tasks

- [ ] T1: Project default built-in names at the model boundary — acceptance: MiMo v2.6 automatically advertises PascalCase, other models stay lowercase, explicit true/false override both defaults; calls execute through unchanged canonical IDs; GPT and MCP tool names remain intact; history and prefix snapshots retain correct names (covers: S2).
- [ ] T2: Align primary system, memory and first-user reminders — acceptance: guidance uses display names independently of schema casing; GPT guidance retains its own tools without rewriting user content (covers: S2).
- [ ] T3: Verify and independently review — acceptance: focused behavioral tests, package typecheck and Node build pass or documented baseline failures are identified; no critical review findings remain (covers: S2; depends: T1, T2).
