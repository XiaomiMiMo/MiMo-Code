---
feature: mcp-tool-search
status: delivered
updated: 2026-10-12
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/1923
---

# MCP Tool Lazy Loading

## [S1] Problem

Sending every complete MCP function definition to the model consumes context before the task needs any MCP capability. Hiding all metadata, however, leaves the model unable to discover capabilities it does not already know exist. OpenAI `defer_loading` is provider-specific and cannot generalize to Claude, Gemini, DeepSeek, MiMo, or compatibility gateways.

## [S2] Deferral Mode

The design follows Claude Code's deferred tools + Tool Search. `MIMOCODE_MCP_TOOL_SEARCH` selects the mode:

- `true` / `1` (default; also any unrecognized value): always defer.
- `auto`: defer MCP tools once their estimated definition size (name, description, transformed schema) exceeds 10% of the model context window; unknown windows assume 200,000 tokens.
- `auto:N`: same, with an N% threshold.
- `false` / `0`: never defer; every effective MCP definition is exposed directly.

Codex-mode models (GPT family except GPT-OSS, or a `codex` harness) always defer. The decision is recomputed on every model step from the request-authorized MCP set, so it tracks servers connecting, disconnecting, or being filtered.

## [S3] Deferred Catalog And Search

When deferral applies, at least one effective MCP tool exists, and the model supports function calling, the request exposes one ordinary function named `mcp_tool_search` with a static description, so tool definitions stay byte-stable for the provider prefix cache.

The catalog (built from `MCP.tools()`, i.e. each server's tool listing) is announced to the model as a synthetic `<system-reminder>` text part appended to the last user message, never as a new user message, inside a tool result, or in the system prompt. The first announcement lists every deferred tool as `- name: description preview`; later ones carry only additions and removals relative to what earlier reminders announced. Each reminder part persists its delta in `metadata.mcpDeferredTools`, and the announced set is replayed from those parts, so compaction (which drops them) triggers a full re-announcement. Announcements are budgeted to 10% of the usable input window (capped at 20,000 tokens), falling back to names only and then to a truncated list; search always covers the complete catalog. System prompts declare that `<system-reminder>` content is harness-injected environment information.

The catalog contains only tools that survive request disables, permissions, agent allowlists, actor whitelists, executable checks, and local-name collision handling. Tools listed in `mcp.<server>.alwaysDirectTools` are excluded from this catalog and from announcements; they join `activeTools` as top-level tools instead (see `always-direct-mcp-tools`). External text — MCP names, descriptions, schemas, and MCP tool results — has `<system-reminder>`, `<functions>`, `<function>`, and `<available-deferred-tools>` tags escaped so it cannot forge harness content.

`mcp_tool_search` accepts `query` and optional `max_results` (default 5, max 20):

- `select:a,b` loads the named tools exactly (case-insensitive).
- A query equal to a tool name loads that tool.
- Otherwise a cached local BM25 index over names, descriptions, and recursive parameter names/descriptions ranks results; `+term` requires `term` in the tool name.

The result returns the matched tools' complete JSON Schema definitions inside a `<functions>` block, so the model learns parameters from the result. The literal name `tool_search` is intentionally avoided because OpenAI Responses adapters reserve it for the native provider protocol.

## [S4] Conversation-Scoped Loading

Searched tools do not rejoin `activeTools`. The provider-facing tool list stays the fixed `mcp_tool_search` / `mcp_tool_use` pair (plus config-declared always-direct tools and local tools); a searched tool is callable through `mcp_tool_use` in the same step without a prior search. Compaction does not change that contract. Model-visible output is never trusted as activation state.

## [S5] Execution Safety

All MCP executors remain in the full local tool map so existing permission checks, actor whitelists, plugin hooks, metrics, result normalization, truncation, attachments, cancellation, and MCP client dispatch are preserved. Before any side effect, the MCP wrapper rejects a call to an unauthorized tool, and — while deferral applies — a direct call to a deferred tool, instructing the model to use `mcp_tool_use`. Config-declared always-direct tools skip that rejection and are never registered on `mcp_tool_use`. Local tools win on callable-name collisions.

## [S6] Provider And ToolScript Behavior

The mechanism uses an ordinary function tool and does not depend on OpenAI provider tools or `defer_loading`. Models without function calling receive neither MCP discovery nor MCP definitions. In Codex mode the outer surface stays `exec` for ordinary tools; config-declared always-direct tools are also top-level there, and exec scripts reach every request-authorized MCP tool through `ALL_TOOLS` without a search round-trip. `mcp_tool_search` is excluded from scripts.

## [S7] Testing Boundaries

Unit coverage: mode parsing, auto threshold, names-only catalog and truncation, `select:` / exact-name / `+required` queries, BM25 ranking and cache invalidation, `<functions>` rendering, limits, and Codex mode resolution. Integration coverage: GPT requests expose only `exec`; by default non-GPT requests hide MCP schemas, load searched tools on the next step, and keep them loaded in the next user turn; `false` exposes MCP tools directly; unloaded calls fail recoverably; non-tool-call models omit both discovery and definitions; MCP success/error normalization is unchanged.

## [S8] Out Of Scope

Semantic embeddings, MCP server summaries, MCP connection lifecycle, MCP naming, and provider-native `tool_reference` blocks.

## Tasks

- [x] T1: Replace provider-native Tool Search with ordinary `mcp_tool_search` and cached local BM25 discovery.
- [x] T2: Separate registered executors from model-visible `activeTools` and activate only searched matches.
- [x] T3: Preserve MCP execution safety while removing ToolScript catalog leakage and inactive-call bypasses.
- [x] T4: Align with Claude Code: on by default with an opt-in `auto` threshold, names-only deferred list, `select:` / `+required` queries, schema-bearing results, conversation-scoped loading.
