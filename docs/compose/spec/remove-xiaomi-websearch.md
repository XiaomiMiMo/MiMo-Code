---
feature: remove-xiaomi-websearch
status: delivered
updated: 2026-10-29
source: fix/remove-xiaomi-websearch
---

# Remove Xiaomi Gateway Websearch

## Report

**What was built** — Xiaomi-family providers no longer get the `websearch` tool; it is offered only for the `opencode` provider or when `MIMOCODE_ENABLE_EXA` is set, and always searches through Exa. The Xiaomi gateway client and its plugin-console messages are gone; an empty result now points at `webfetch` and at configuring a search MCP server. `fact-check` falls back from `websearch` to a search MCP tool and then to `webfetch` on DuckDuckGo HTML. README and the bundled `mimocode-docs` guide document Exa, Tavily and Volcengine Doubao Search setups, and the `xiaomi-auth-provider-split` doc no longer claims family websearch routing.

**Verification**
- `bun run typecheck` (packages/cli): PASS.
- `bun test test/tool/registry-toolset.test.ts test/workflow/builtin.test.ts test/skill/mimocode-docs.test.ts test/skill/builtin.test.ts`: 22 pass, 0 fail; the new registry case fails on the base commit.
- Full suite and lint: delegated to CI on the PR (local `oxlint` cannot run inside a nested `.worktrees` checkout).
## [S1] Problem

The built-in `websearch` tool is offered to every Xiaomi-family model and, for those models, searches through the Xiaomi MiMo web-search plugin. That plugin is billed per call against a pay-as-you-go API key and is not part of Token Plan, so it can only work for the `xiaomi` API-key channel with the plugin enabled and a supported model; Token Plan sessions (and legacy `xiaomi` entries holding a token-plan key) get a tool that always answers a misleading "enable the plugin" fallback. Even where it works, it returns only a few short source snippets per call while billing both per-search fees and the side request's tokens.

MiMoCode no longer ships this first-party search. Users who want web search configure it themselves: the built-in Exa channel when explicitly enabled, or any search MCP server.

## [S2] Design

### S2.1 Tool availability

`websearch` is offered only when `MIMOCODE_ENABLE_EXA` is on or the model's provider is `opencode` (both unchanged). Xiaomi-family providers no longer enable it.

### S2.2 Execution

`websearch` always uses the Exa MCP channel (`mcp.exa.ai`, with `EXA_API_KEY` when set). The Xiaomi gateway client (`tool/websearch/mimo.ts`) and its quota text are removed. When Exa returns nothing, the tool answers a fallback that points at configuring a search MCP server and at `webfetch`, not at the Xiaomi plugin console.

### S2.3 Built-in workflows

`fact-check` searches with `websearch` when it is available, otherwise with any configured search MCP tool, otherwise via `webfetch` on DuckDuckGo HTML — the same fallback `deep-research` already documents.

### S2.4 Documentation

README gains a "Web search" section: enabling the built-in Exa channel, and `mcp` configuration examples for Exa (remote), Tavily (remote, API key header or keyless header) and Volcengine Doubao Search (official `mcp-server-askecho-search-infinity`, local via `uvx`, `ASK_ECHO_SEARCH_INFINITY_API_KEY`). Keys use `{env:VAR}` substitution. The `xiaomi-auth-provider-split` feature doc is corrected: Xiaomi-family models no longer route websearch.

## [S3] Out of Scope

- The other Xiaomi-family checks from #2739 (request attribution header, output-token defaults, voice credential order, model ordering); they are audited separately.
- Any desktop change; the desktop never enables Exa, so it loses nothing it uses.
- A generic search-provider abstraction or bundling any MCP server.

## Tasks

- [x] T1: Drop the Xiaomi websearch gate and gateway client — acceptance: Xiaomi-family providers no longer get `websearch`; `opencode` and `MIMOCODE_ENABLE_EXA` still do; `tool/websearch/mimo.ts` is gone and the fallback text no longer mentions the Xiaomi plugin console (covers: S2.1, S2.2)
- [x] T2: `fact-check` search fallback — acceptance: the search prompt names the MCP and `webfetch` fallbacks when `websearch` is unavailable (covers: S2.3)
- [x] T3: README "Web search" section and `xiaomi-auth-provider-split` correction — acceptance: the four configuration paths are documented with valid `mcp` entries; the old spec no longer claims family websearch routing (covers: S2.4)

## Journey log

- The first attempt kept the gateway search and made it resolve endpoint and key like the chat request, plus a `MIMOCODE_DISABLE_WEBSEARCH` switch for embedders. It was dropped once it became clear the plugin is pay-as-you-go only, so the family gate itself was wrong, and the low result quality did not justify keeping a first-party search.
- Several MCP and provider-refresh suites mock modules process-wide and run isolated in CI (`.github/workflows/test.yml`); running them in one process with other files produces unrelated failures.
