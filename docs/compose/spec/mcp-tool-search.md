---
feature: mcp-tool-search
status: completed
updated: 2026-07-26
branch: feature/mcp-tool-search
commits: c946f4c215aaf326036342a8c3dec6ad12d8772a..HEAD
---

# MCP Tool Skillization

## [S1] Problem

Sending every complete MCP function definition to the model consumes context before the task needs any MCP capability. Hiding all metadata, however, leaves the model unable to discover capabilities it does not already know exist. OpenAI `defer_loading` is provider-specific and cannot generalize to Claude, Gemini, DeepSeek, MiMo, or compatibility gateways.

## [S2] Private Catalog And Generic Discovery

MiMoCode keeps every transformed schema and execute closure in a local registry. When MCP Tool Search is enabled, at least one effective MCP tool exists, and the selected model supports function calling, the request exposes one ordinary function named `mcp_tool_search`. Its description contains a deterministic catalog of the effective MCP tools so the model knows what it can search for, while individual MCP function definitions and schemas remain hidden until activation.

At context pressure levels 0-1 (below 70% of the usable input window), the catalog includes every effective callable name and description when the complete rendering fits its budget. At levels 2-3, or when the rich catalog itself exceeds the budget, it degrades to callable names only. The catalog budget is 10% of the model's usable input window capped at 20,000 estimated tokens; unknown windows use the 20,000-token cap. If all names still exceed the budget, the renderer includes a deterministic prefix plus an omitted-count notice. Local search always covers the complete catalog.

The catalog is recomputed on every model step because API requests are stateless and context pressure may change after compaction. It contains only tools that survive request disables, permissions, agent allowlists, actor whitelists, executable checks, and local-name collision handling. Names and descriptions are normalized and explicitly framed as untrusted metadata rather than instructions. Parameter names, parameter descriptions, schemas, and executors are never included in the catalog.

`mcp_tool_search` uses a cached local BM25 index over callable names, descriptions, and recursive parameter names/descriptions. It returns only matched names, descriptions, and scores in its visible output; schemas remain private until activation. The literal name `tool_search` is intentionally avoided because OpenAI Responses adapters reserve it for the native provider protocol.

## [S3] Request-Scoped Loading

A successful search persists a catalog fingerprint and validated matched callable names in ordinary tool-result metadata. On the next existing Session outer-loop step, MiMoCode scans only completed searches parented to the current user message, unions valid matches, and exposes those MCP definitions through the AI SDK `activeTools` subset.

Loaded tools accumulate across searches for the current user request, up to a bounded total. A new user message starts with all MCP functions hidden again. A catalog change invalidates earlier matches. Model-visible output is never trusted as activation state.

## [S4] Execution Safety

All MCP executors remain in the full local tool map so existing permission checks, actor whitelists, plugin hooks, metrics, result normalization, truncation, attachments, cancellation, and MCP client dispatch are preserved. Before any side effect, the MCP wrapper rejects a call not loaded for the current request and instructs the model to use `mcp_tool_search`.

This guard covers hallucinated calls, stale history, repair mistakes, Max Mode replay, and same-step parallel search plus MCP calls. Search matches become callable only on the next outer-loop step. Local tools win on callable-name collisions, and conflicting MCP entries are not advertised.

## [S5] Provider And ToolScript Behavior

The mechanism uses an ordinary function tool and does not depend on OpenAI provider tools or `defer_loading`. It is enabled by default for GPT-family models except GPT-OSS. Other models expose effective MCP definitions directly by default and may opt into discovery with `MIMOCODE_EXPERIMENTAL_MCP_TOOL_SEARCH=true` (or the umbrella `MIMOCODE_EXPERIMENTAL`). Models without function calling receive neither MCP discovery nor MCP definitions.

The GPT ToolScript/`exec` surface no longer embeds or dispatches MCP tools. This prevents ToolScript descriptions and sandbox declarations from leaking the private catalog or bypassing request-scoped activation. Loaded MCP capabilities are invoked through their ordinary direct tool definitions.

## [S6] Testing Boundaries

Focused coverage must prove that initial GPT requests contain `mcp_tool_search` with the effective name/description catalog but no MCP schema or separately callable MCP definitions; non-GPT models expose MCP tools directly by default and can opt into discovery with the feature flag; only search matches become callable on the next request; unmatched tools remain inactive; multiple searches accumulate; new user messages reset loading; non-tool-call models omit both discovery and MCP definitions; inactive calls fail recoverably; and ordinary MCP success/error normalization remains unchanged.

Tests also cover context-pressure boundaries, rich-to-name-only budget fallback, deterministic truncation, BM25 ranking and cache invalidation, active tool wire serialization, ToolScript isolation, reserved search-tool collisions, limits, catalog fingerprints, and package type safety.

## [S7] Out Of Scope

This change does not add semantic embeddings, persist loaded tools across user requests, expose MCP server summaries, change MCP connection lifecycle, redesign MCP naming, or make non-function-calling models capable of tool use.

## Report

Implemented provider-independent, request-scoped MCP discovery with token-aware catalog disclosure, GPT-default gating, direct non-GPT fallback, and execution-time eligibility guards. Focused and integration coverage verifies search activation, direct execution, permission filtering, GPT-OSS exclusion, context-pressure degradation, and schema privacy. Package and repository type checks pass.

## Tasks

- [x] T1: Replace provider-native Tool Search with ordinary `mcp_tool_search` and cached local BM25 discovery.
- [x] T2: Separate registered executors from model-visible `activeTools` and activate only request-scoped matches.
- [x] T3: Preserve MCP execution safety while removing ToolScript catalog leakage and inactive-call bypasses.
- [x] T4: Complete focused/broad verification, independent review, and delivery report.
