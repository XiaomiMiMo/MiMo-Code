# Sort Appended MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the established local-tool order while appending MCP tools in deterministic ascending tool-name order.

**Architecture:** Keep tool ordering policy at the `SessionPrompt.resolveTools` request-assembly boundary. The local registry continues to populate the tools record first; only the MCP entries are sorted before the existing append loop, so other MCP service consumers and local-tool ordering remain unchanged.

**Tech Stack:** TypeScript, Effect, Bun test, AI SDK tools

## Global Constraints

- Preserve the existing registration order of all non-MCP tools.
- Append every directly exposed MCP tool after all non-MCP tools.
- Sort appended MCP tools by their final sanitized tool name using `localeCompare`.
- Do not change MCP tool filtering, permissions, execution, or MCP Tool Search behavior.
- Run tests and type checking from `packages/opencode`, never from the repository root.

---

### Task 1: Deterministic MCP Tool Ordering

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts:1480`
- Test: `packages/opencode/test/session/prompt-effect.test.ts:324-345,1214-1245`

**Interfaces:**
- Consumes: `MCP.Service.tools(context): Effect<Record<string, AITool>>` and the existing insertion-ordered local `tools` record.
- Produces: the same `Record<string, AITool>` request tool map, with local tools first and MCP entries ordered by ascending final key.

- [ ] **Step 1: Make the MCP fixture expose reverse-ordered names**

In the `mcpIt` fixture in `packages/opencode/test/session/prompt-effect.test.ts`, place `mcp_success` before `mcp_result`. Keep both tool definitions otherwise unchanged. This ensures the test can distinguish source enumeration order from normalized request order.

- [ ] **Step 2: Assert local tools precede the sorted MCP suffix**

Extend `exposes MCP tools directly for non-GPT models by default` after reading `tools`:

```ts
const names = tools.map(wireToolName).filter((name): name is string => name !== undefined)
const firstMcp = names.findIndex((name) => name.startsWith("mcp_"))
expect(firstMcp).toBeGreaterThan(0)
expect(names.slice(firstMcp)).toEqual(["mcp_result", "mcp_success"])
```

Retain the existing assertions that `mcp_tool_search` is absent and both direct tools execute correctly.

- [ ] **Step 3: Run the focused test and verify it fails**

Run from `packages/opencode`:

```bash
bun test test/session/prompt-effect.test.ts -t "exposes MCP tools directly for non-GPT models by default"
```

Expected: FAIL because the MCP suffix is currently `["mcp_success", "mcp_result"]`.

- [ ] **Step 4: Sort MCP entries at the append boundary**

Replace the MCP entry construction in `SessionPrompt.resolveTools` with:

```ts
const mcpTools = Object.entries(yield* mcp.tools(input.mcpContext)).toSorted(([a], [b]) => a.localeCompare(b))
```

Do not sort the complete `tools` record or change the subsequent MCP append loop.

- [ ] **Step 5: Run focused verification**

Run from `packages/opencode`:

```bash
bun test test/session/prompt-effect.test.ts -t "exposes MCP tools directly for non-GPT models by default"
```

Expected: PASS.

- [ ] **Step 6: Run broader session tests and type checking**

Run from `packages/opencode`:

```bash
bun test test/session/prompt-effect.test.ts
bun typecheck
```

Expected: both commands exit successfully with no test failures or type errors.

- [ ] **Step 7: Review the final diff**

Run:

```bash
git diff --check
git diff -- packages/opencode/src/session/prompt.ts packages/opencode/test/session/prompt-effect.test.ts
```

Expected: no whitespace errors; the diff contains only the reverse-ordered fixture, the ordering assertions, and the MCP-only sort.
