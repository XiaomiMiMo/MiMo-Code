---
feature: mcp-readiness-hint
status: delivered
updated: 2026-10-20
branch: feat/mcp-readiness-hint
commits: 113e3192..WORKTREE
---

# MCP Readiness Hint

## Report

**What was built** — MCP status is no longer inferred from the search catalog. When deferred mode is on and ≥1 MCP server is configured, a standard synthetic user reminder is injected at the turn boundary: one entry listing servers (“Attempting to connect…”) and one outcome per server (connected + tools with description previews, or failed / needs auth). Injection is driven by non-blocking `MCP.readiness()`, via `ensurePersistedUserSynthetic` with stable markers. `mcp_tool_search` empty/miss returns readiness + action hint (**Retry later** only while something is `pending`). Tool-list delta announcements and catalog-driven empty-entry logic were removed.

**Verification**
- `bun run typecheck` (packages/cli): PASS
- `bun test test/tool/mcp-tool-search.test.ts`: 29 pass / 0 fail
- `bun test test/session/prompt-effect.test.ts -t "mcp|MCP|search"`: 32 pass / 0 fail

**Journey log**
- Catalog must not decide injection; readiness does. Catalog stays search-only.
- Entry is unconditional on configured servers (not empty-catalog / auto-only).
- `MCP.status()` awaits `settled`; diagnostics use `MCP.readiness()`.
- `ensurePersistedUserSynthetic` gained optional `metadata` + `syntheticMarker` dedupe.

## [S1] Problem

The model cannot tell **MCP is not ready** from **the tool does not exist**. Announcements were catalog-delta-driven, so “which MCPs exist / are connecting” was missing or delayed, and empty search reused one ambiguous sentence.

## [S2] Design

| Channel | When | Content |
|---|---|---|
| Entry reminder | turn boundary, ≥1 configured server, deferred | `MCP servers configured: a, b. Attempting to connect…` + search/use hint |
| Server outcome reminder | turn boundary, per terminal status / tool-list change | connected: tools + desc previews; failed / needs_auth: short note |
| `mcp_tool_search` | on use | schemas on hit; readiness + hint on empty/miss |
| `mcp_tool_use` | on use | result; unknown name → search |

- `MCP.readiness()` is non-blocking (never `settled`); optional on `Interface`; includes per-server `tools: {name, description}[]` when connected.
- Markers: `mcp:entry:<servers>` / `mcp:server:<name>:<status>:<toolNames>`; metadata `mcpReminder` also feeds sticky defer.
- Descriptions stay on tool lines (preview + budget fallback to names). No live `ToolsChanged` subscription.
- Mid-turn history is never rewritten; updates wait for the next turn boundary.

## [S3] Out of Scope

- Changing `FIRST_TURN_WAIT` or connection lifecycle.
- Mid-turn ambient push into history.
- Full JSON Schema validation of `mcp_tool_use` arguments.
- Consuming `MCP.ToolsChanged` as a dirty signal.

## Tasks

- [x] T1: Entry + per-server outcome reminders, readiness on search miss — acceptance: unit tests for entry, connected/failed/auth/0-tools, markers (covers: S2)
- [x] T2: Non-blocking `MCP.readiness()` with tool names; announce via standard synthetic path — acceptance: prompt-effect deferred/flapping/MCP suite (covers: S2)
- [x] T3: Remove catalog-delta injection; typecheck + focused tests pass (covers: S2)
