---
feature: mcp-tool-use
status: delivered
updated: 2026-10-20
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2684
---

# MCP Tool Use

## Report

**What was built** — In deferred MCP mode, searched tools no longer join `activeTools`. A fixed native
`mcp_tool_use` tool (`{ name, arguments }`) is exposed next to `mcp_tool_search` and dispatches into the
existing MCP execution pipeline, so provider-facing tool definitions stay byte-stable across searches and
the prompt-cache prefix survives. Permission, plugin hooks and metrics (including the processor error
metric) use the real MCP tool name; the tool part and gate key are `mcp_tool_use`.

Arguments are pre-checked (object + own top-level `required` properties) after `tool.execute.before`;
failures return a recoverable error with the tool's `<functions>` schema. Unknown names point at
`mcp_tool_search`. Direct calls to deferred tools are rejected after the actor-whitelist check, with a
`mcp_tool_use` hint (or an `exec` hint on the GPT toolset). The TUI renders dispatched calls as the
underlying tool. Harness prompts (anthropic, gemini, beast) and search/reminder wording were updated.

**Verification**
- `bun run typecheck` (packages/cli): PASS.
- `bun test` on mcp-tool-search, prompt-effect, llm, tool-fail-cascade, tool-gate-cancel, tool-script: 266 pass / 3 skip / 0 fail after review fixes; deferred subset re-run after the last fix: PASS.
- Full `bun test` (packages/cli): 6092 pass / 66 fail under full-suite load; failing files (project, vcs, project-id, memory/paths, tool-gate-cancel, tool-fail-cascade, actor) pass in isolation on branch and main — PRE-EXISTING load flakes.
- Independent review: no critical findings; important/minor items fixed and re-reviewed.

**Journey log**
- Codex/GPT models defer MCP tools but reach them only via `exec`; older tests that searched then called a deferred tool directly with a GPT model exercised an unreachable path and were moved to the non-GPT model.
- The processor's `executeTool` checks the persisted part's tool name, so dispatched calls must batch under `mcp_tool_use`, not the MCP key.
- No JSON Schema validator is a direct dependency and the lockfile must not change, so argument checking stays structural and full validation is left to the MCP server.

## [S1] Problem

With MCP Tool Search (deferred mode), `mcp_tool_search` returns the schema of matched tools and
the next request adds those tools to `activeTools` (`session/prompt.ts`, `loadedMcpTools`, capped by
`MCP_TOOL_SEARCH_MAX_LOADED`). The provider-facing tool definitions therefore change after every
search. Tool definitions sit at the front of the prompt-cache prefix, so each search invalidates the
cached prefix for the rest of the conversation.

## [S2] Design

Keep the provider-facing tool list byte-stable for the whole session in deferred mode by routing every
deferred MCP call through one fixed dispatcher tool.

- **`mcp_tool_use` tool.** A native tool call (not text/XML) with parameters
  `{ name: string, arguments?: object }`. It is exposed exactly when `mcp_tool_search` is exposed
  (deferred mode, non-GPT toolset, model supports tool calls) and placed in `activeTools` next to it.
  It is built in `SessionPrompt` (not the registry) so it can reuse the request-scoped MCP executor.
- **No more loading.** In deferred mode, searched tools are no longer added to `activeTools`;
  `loadedMcpTools` and `MCP_TOOL_SEARCH_MAX_LOADED` are removed. `mcp_tool_search` keeps returning the
  `<functions>` schema block (appended to history, so it never touches the cached prefix) and keeps its
  `matchedTools` metadata.
- **Dispatch.** `mcp_tool_use` resolves `name` against the request's searchable MCP catalog and runs the
  same MCP execution pipeline as a direct call (availability, actor whitelist, `tool.execute.before/after`
  plugin hooks with the real MCP tool name, permission ask keyed by the real tool name, truncation,
  metrics with the real tool name, progress metadata). The processor batch/gate key is `mcp_tool_use`,
  matching the persisted tool part. Its result is the underlying tool's result.
- **No search prerequisite.** Any request-authorized deferred MCP tool can be called without a prior
  search (search is a context optimization, not an authorization boundary, as with `exec`).
- **Errors (recoverable, loop continues).**
  - Unknown or unauthorized `name` → error naming the tool and telling the model to use
    `mcp_tool_search`.
  - `arguments` not an object, or missing a top-level `required` property of the tool's input schema →
    error that includes the tool's full schema in a `<functions>` block so the model can retry.
    (Full JSON Schema validation is left to the MCP server; no new validator dependency.)
- **Direct calls in deferred mode.** A direct call to a deferred MCP tool name is rejected with an error
  telling the model to call it through `mcp_tool_use`.
- **Always-direct MCP tools.** Config (`mcp.<server>.alwaysDirectTools`) can mark server-local tools as
  never deferred and never in the `mcp_tool_use` catalog: they sit in `activeTools` as ordinary top-level
  tools on every toolset (including GPT) and reject `mcp_tool_use` dispatch as an unknown deferred name.
  See `always-direct-mcp-tools`.
- **Guidance text.** The `mcp_tool_search` description, the deferred-tools `<system-reminder>`, and the
  search result tell the model to call tools via `mcp_tool_use` with `{ name, arguments }`.
- **Provider filter.** `llm.ts` `resolveTools` exempts `mcp_tool_use` from permission-disabled filtering
  when it is active, as it does for `mcp_tool_search` (real-tool permission is enforced at dispatch).
- **TUI.** A `mcp_tool_use` part renders as the underlying tool: name from `input.name`, arguments from
  `input.arguments`.
- Non-deferred mode (`MIMOCODE_MCP_TOOL_SEARCH=false`, or `auto` below threshold) and the GPT/`exec` path
  are unchanged.
- **Stability across MCP churn (amendment).**
  - An empty catalog counts as deferred: unless mode is `never`, `mcp_tool_search`/`mcp_tool_use` are
    exposed even before any MCP server connects or is configured, so the first server to arrive never
    changes the tool list.
  - Deferral is sticky per conversation: once history shows a deferred-tools announcement or a search/use
    call, `auto` stays deferred even if the catalog drops under its threshold or empties. In `auto`, an
    empty first catalog persists a "no deferred MCP tools yet" announcement as that evidence.
  - Deferred-tools announcements are appended only while the last user message is the tail of the
    conversation; changes that happen mid-turn are announced on the next turn, so earlier messages are
    never rewritten. `mcp_tool_search` always searches the live catalog meanwhile.

## [S3] Out of Scope

- XML/text-embedded tool calls.
- Full JSON Schema validation of `arguments`.
- Changing when deferral is decided (`shouldDeferMcpTools`) or the reminder delta mechanism.
- Web/desktop app renderers.

## Tasks
- [x] T1: Add `MCP_TOOL_USE_ID`, its parameters/description, and an argument pre-check helper to `tool/mcp-tool-search.ts`; update search description/reminder/result wording; remove `MCP_TOOL_SEARCH_MAX_LOADED` — acceptance: unit tests for the pre-check (non-object, missing required, valid) and wording pass (covers: S2)
- [x] T2: Build the `mcp_tool_use` dispatcher in `session/prompt.ts`, drop search-based loading, reject direct deferred calls, exempt it in `llm.ts` — acceptance: session tests show the tool list is identical before and after a search, a `mcp_tool_use` call completes with the MCP result, unknown name / missing required args produce recoverable errors, direct deferred calls are rejected (covers: S2; depends: T1)
- [x] T3: Render `mcp_tool_use` parts in the TUI as the underlying tool — acceptance: typecheck passes and the part shows the MCP tool name and its arguments (covers: S2; depends: T1)
- [x] T4: Update harness prompt text mentioning deferred MCP tools — acceptance: prompts reference `mcp_tool_use` where loading via search was implied (covers: S2)
