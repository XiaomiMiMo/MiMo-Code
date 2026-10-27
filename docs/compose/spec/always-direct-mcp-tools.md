---
feature: always-direct-mcp-tools
status: delivered
updated: 2026-10-22
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2734
---

# Always-Direct MCP Tools

## Report

**What was built** — MCP config (`mcp.<server>.alwaysDirectTools`) declares always-direct tools. The
engine flattens those server-local names to catalog keys and keeps them out of the deferred
`mcp_tool_search` catalog and `mcp_tool_use` dispatcher; they join `activeTools` as top-level tools on
every toolset and allow direct calls while ordinary MCP deferral stays unchanged. Hosts own the product
mapping. Exec `ALL_TOOLS` guest access and sticky `deferredEarlier` are unchanged.

**Verification**
- `bun run typecheck` (packages/cli): PASS.
- `bun test` on mcp-tool-search unit (config-driven always-direct keys): PASS.
- `bun test test/session/prompt-effect.test.ts -t always-direct` (deferred top-level + GPT top-level + exec guest): 3 pass.
- MCP-related prompt-effect subset: 86 pass / 1 intermittent 5s timeout (`MCP structuredContent…`); isolated re-run PASS — PRE-EXISTING load flake.
- Desktop `tests/unit/sharedAutomationMcp.test.ts`: 19 pass / 0 fail (host publishes `alwaysDirectTools`).

## [S1] Problem

Deferred MCP mode routes every MCP call through `mcp_tool_use`. That fits discoverable business tools,
but a host may register a high-frequency programmatic entry — for example a sandbox server whose
`run` / `reset` pair is the model's scripting surface. Burying that entry behind the generic dispatcher
adds a hop on every cell, keeps it out of the provider-facing list even on toolsets where a top-level
call is already legal, and advertises it as a deferred catalog item instead of a first-class tool.
The engine must not learn product tool names to fix this.

## [S2] Design

MCP config declares which tools are always-direct. Those tools skip the deferred `mcp_tool_search` /
`mcp_tool_use` catalog and join `activeTools`.

### S2.1 Identity (config inversion)

Each MCP server config may set `alwaysDirectTools: string[]` — server-local tool names as the server
lists them. The engine flattens each entry to the catalog name `sanitize(server)_sanitize(tool)` via
`mcpCatalogToolName` / `alwaysDirectMcpToolKeys` in `tool/mcp-tool-search.ts`, using the same merge as
`MCP.tools()` (`config.mcp` then `HostMcp`). Hosts set the list when they publish the server; the
engine has no product tool names.

Example: config `mcp.sandbox.alwaysDirectTools = ["run", "reset"]` yields catalog keys `sandbox_run`
and `sandbox_reset`.

### S2.2 Exposure

When a request-authorized always-direct MCP tool exists and the model supports tool calls, it is added to
`activeTools` in every toolset:

- non-GPT deferred mode: direct top-level tool next to `mcp_tool_search` / `mcp_tool_use`
- non-GPT direct mode (`MIMOCODE_MCP_TOOL_SEARCH=false` / `auto` under threshold): unchanged, still direct
- GPT/Codex toolset: also top-level (same as any tool that is "actually exposed separately this turn")

It stays out of `mcpSearchEntries`, deferred `<system-reminder>` announcements, `mcp_tool_use` dispatch,
and the structural `mcp_tool_use` argument pre-check. A `mcp_tool_use` call naming it returns the usual
recoverable "not an available deferred MCP tool" error. Membership uses the same `searchable` gate as
exec guests (available + actor whitelist), so a whitelist that omits the tool keeps it out of
`activeTools`. A request whose deferred catalog is empty after this exclusion still exposes
`mcp_tool_search` / `mcp_tool_use` under `always` / `auto` empty-catalog rules, keeping the
provider-facing list stable if ordinary MCP tools arrive later.

### S2.3 Execution

The normal MCP execute wrapper remains: availability, actor whitelist, `tool.execute.before/after`
hooks, permission ask keyed by the real tool name, truncation, metrics, progress metadata. Direct calls
are never rejected as deferred. Exec `ALL_TOOLS` / `execMcpTools` still include them so scripts can call
`tools.sandbox_run(...)` without a search round-trip.

### S2.4 Deferral stickiness

Calls to always-direct tools are not deferred-catalog evidence. `deferredEarlier` still keys off
`mcp_tool_search` / `mcp_tool_use` parts and deferred-tools reminder metadata only.

### S2.5 Out of band

Host documentation that still claims these tools load schema via `mcp_tool_search` is updated in the
host repository.

## [S3] Out of Scope

- Changing when deferral is decided for ordinary MCP tools (`shouldDeferMcpTools` modes/thresholds).
- Renaming host tool contracts or changing a host's REPL/script protocol.
- Hardcoding product tool names in the engine, or always-direct for servers that do not set `alwaysDirectTools`.
- Host UI presentation of specialized tool rows.

## Tasks
- [x] T1: Add `alwaysDirectTools` to MCP config; export `mcpCatalogToolName` / `alwaysDirectMcpToolKeys`; unit-test flattening and empty configs (covers: S2.1)
- [x] T2: Exclude config-declared always-direct tools from the deferred catalog and `mcp_tool_use` dispatch; allow direct calls; add them to `activeTools` on every toolset — acceptance: deferred-mode request exposes configured tools top-level and rejects `mcp_tool_use` naming them; ordinary MCP tools still defer; GPT request lists them top-level (covers: S2.2, S2.3; depends: T1)
- [x] T3: Keep exec guest access and deferral-sticky semantics unchanged — acceptance: exec can call the configured tools; ordinary deferral evidence is unchanged (covers: S2.3, S2.4; depends: T2)
- [x] T4: Hosts publish `alwaysDirectTools` for their entry tools; engine specs stay product-name-free (covers: S2.1, S2.5)
- [x] T5: Update `mcp-tool-use.md` / `mcp-tool-search.md` current-state wording for the always-direct exception — acceptance: both specs describe the config-driven exception without change-history language (covers: S2.2)

## Journey log
