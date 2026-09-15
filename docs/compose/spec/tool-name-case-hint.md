---
feature: tool-name-case-hint
status: delivered
updated: 2026-09-15
branch: fix/tool-name-case-hint
commits: 5198ff54..967ca86f
---

# Tool Name Exact Match

## Report

**What was built** — Tool name resolution is exact-only. `resolveName` is
removed; every call site looks up the registered catalog name directly.
Models must emit the exact id (`edit`, not `Edit` / `apply-patch` /
`mcp__server__tool`). Mis-cased or aliased names go to the existing
invalid-tool path, where AI SDK already reports
`Available tools: …`. Parameter-key normalization (`filePath` → `file_path`)
and the exec raw-source wrap remain, but only after an exact name hit.
The `MIMOCODE_IGNORE_TOOL_NAME_CASE` flag is gone.

**Verification** — From `packages/opencode`:
- `bun test test/util/tool-compat.test.ts` — PASS (19 tests)
- `bun typecheck` — PASS

**Journey log**
- Silent case-fold produced unwinnable schema errors on XML-style calls (parser owns types).
- MCP names are case-sensitive per SEP-986; `mcp__server__tool` is a client convention, not a registry id here (catalog uses `server_tool`).
- Separator folding and local similar-name hints were also overreach; AI SDK already lists available tools on failure.

## [S1] Problem

Models sometimes emit a tool name that is not the registered id: wrong case
(`Edit`), separator style (`apply-patch`), or a Claude-style MCP prefix
(`mcp__server__tool`). The old path silently rewrote some of these and then
failed later on argument types the model never controlled (XML parser owned
those types). The model saw an unactionable schema error instead of
"unknown tool name".

## [S2] Design

Exact match only.

- Delete `ToolCompat.resolveName`.
- `repairToolCall` bails unless `toolNames.includes(toolName)`; it still
  normalizes argument keys and wraps raw `exec` source for exact hits.
- Workflow `toolExecutor` looks up `tools[toolName]` directly.
- `tool-script` MCP lookup uses `mcpById.get(id)` directly.
- `canonical` remains for parameter-key folding (`ignoreCase` kept); the
  `mcp__server__tool` flattening was removed with resolveName.
- No local similar-name hint; pass through `failed.error.message`.

## [S3] Out of Scope

- Argument type coercion
- Renaming registered tools
- MCP wire protocol

## Tasks

- [x] T1: Delete resolveName; exact-only lookup at all three call sites — acceptance: `Edit` / `apply-patch` / `mcp__a__b` are unresolved (covers: S2)
- [x] T2: Keep key normalization + exec wrap on exact hits only — acceptance: `repairToolCall` still maps `filePath` → `file_path` for `read` (covers: S2)
- [x] T3: Update unit tests — acceptance: `bun test test/util/tool-compat.test.ts` passes (covers: S2)
