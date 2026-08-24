# MCP Tool Name Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MiMo Code accept canonical MCP tool names and both `mcp__server__tool` spellings without changing the declared catalog names.

**Architecture:** Extend the existing tool-name compatibility resolver so native tool-call repair and the exec sandbox share one alias rule. Keep registered names canonical; resolve aliases only at dispatch time so permissions, catalog output, and metrics retain current identifiers.

**Tech Stack:** TypeScript, Bun test, Effect, AI SDK tools.

## Global Constraints

- Do not add PTC/content parsing in this change.
- Exact registered tool names always win.
- Built-in tool IDs continue to win over MCP collisions.
- The three accepted forms are `feishu-mcp-pro_doc_read`, `mcp__feishu-mcp-pro__doc_read`, and `mcp__feishu_mcp_pro__doc_read`.

---

### Task 1: Resolve MCP aliases in native and exec dispatch

**Files:**
- Modify: `packages/opencode/src/util/tool-compat.ts`
- Modify: `packages/opencode/src/tool/tool-script.ts`
- Test: `packages/opencode/test/util/tool-compat.test.ts`
- Test: `packages/opencode/test/tool/tool-script.test.ts`

**Interfaces:**
- Consumes: `ToolCompat.resolveName(name, candidates)` and the exec request-scoped `mcpById` map.
- Produces: alias-aware resolution to the exact registered MCP tool ID.

- [x] **Step 1: Add failing resolver tests**

Add assertions that both prefixed forms resolve to `feishu-mcp-pro_doc_read`, while exact names and unrelated unknown names retain current behavior.

- [x] **Step 2: Run resolver tests and verify RED**

Run: `bun test test/util/tool-compat.test.ts`
Expected: the new MCP alias assertions fail because `resolveName` retains the `mcp__` prefix.

- [x] **Step 3: Implement minimal canonicalization**

Normalize a leading `mcp__<server>__<tool>` envelope to `<server>_<tool>` before the existing separator/case collapse. Preserve the existing exact-match and case-match precedence.

- [x] **Step 4: Run resolver tests and verify GREEN**

Run: `bun test test/util/tool-compat.test.ts`
Expected: all resolver tests pass.

- [x] **Step 5: Add a failing exec integration test**

Register `feishu-mcp-pro_doc_read` in `execMcp.current`, invoke it through each prefixed spelling from sandbox code, and assert both calls execute the same MCP tool.

- [x] **Step 6: Run exec test and verify RED**

Run: `bun test test/tool/tool-script.test.ts --test-name-pattern 'MCP aliases'`
Expected: exec reports `unknown tool` for the prefixed spelling.

- [x] **Step 7: Resolve aliases at exec MCP lookup**

When a name is not a built-in, pass it through `ToolCompat.resolveName` against `mcpById.keys()`, then execute the resolved map entry. Keep trace labels based on the requested ID and keep builtin collision precedence unchanged.

- [x] **Step 8: Run focused and package verification**

Run: `bun test test/util/tool-compat.test.ts test/tool/tool-script.test.ts`
Expected: all tests pass.

Run: `bun typecheck`
Expected: exit code 0.
