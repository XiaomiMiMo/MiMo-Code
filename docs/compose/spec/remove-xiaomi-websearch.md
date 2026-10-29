---
feature: remove-xiaomi-websearch
status: delivered
updated: 2026-10-29
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2744
---

# Remove Xiaomi Gateway Websearch

## Report

**What was built** — `websearch` and `codesearch` are off for every provider (Xiaomi family and `opencode` included) unless `MIMOCODE_ENABLE_EXA` is set; `websearch` always searches through Exa. The Xiaomi gateway client and its plugin-console messages are gone; an empty result tells the model to try another query or `webfetch`. `fact-check`, `deep-research` and the bundled `deep-research` skill use `websearch` or a search MCP tool and, without one, read named primary sources and public APIs instead of scraping search-engine pages. A "How to set up web search" FAQ entry in README (English and Chinese) and the bundled `mimocode-docs` guide explain how to enable search: the Exa tools, or an Exa, Tavily or Volcengine Doubao Search MCP server, and the `xiaomi-auth-provider-split` doc no longer claims family websearch routing.

**Verification**
- `bun run typecheck` (packages/cli): PASS.
- `bun test test/tool/registry-toolset.test.ts test/workflow/builtin.test.ts test/workflow/deep-research-cluster.test.ts test/skill/builtin.test.ts test/skill/search.test.ts test/skill/skill.test.ts test/skill/skill-description.test.ts test/tool/skill-search.test.ts test/skill/mimocode-docs.test.ts`: all pass; the new registry case fails on the base commit. The flag-on case is not unit-tested: `Flag.MIMOCODE_ENABLE_EXA` is read once at import.
- GitHub CI (lint, typecheck, unit shards 1-4): pass on 1264225; rerun on the final head.
## [S1] Problem

The built-in `websearch` tool is offered to every Xiaomi-family model and, for those models, searches through the Xiaomi MiMo web-search plugin. That plugin is billed per call against a pay-as-you-go API key and is not part of Token Plan, so it can only work for the `xiaomi` API-key channel with the plugin enabled and a supported model; Token Plan sessions (and legacy `xiaomi` entries holding a token-plan key) get a tool that always answers a misleading "enable the plugin" fallback. Even where it works, it returns only a few short source snippets per call while billing both per-search fees and the side request's tokens.

MiMoCode no longer ships this first-party search. Users who want web search configure it themselves: the built-in Exa channel when explicitly enabled, or any search MCP server.

## [S2] Design

### S2.1 Tool availability

`websearch` and `codesearch` are offered only when `MIMOCODE_ENABLE_EXA` is on, for every provider. Xiaomi-family providers no longer enable `websearch`, and the `opencode` provider no longer enables either tool by default: it reached the same keyless public Exa endpoint, so it gets the same explicit opt-in.

### S2.2 Execution

`websearch` always uses the Exa MCP channel (`mcp.exa.ai`, with `EXA_API_KEY` when set). The Xiaomi gateway client (`tool/websearch/mimo.ts`) and its quota text are removed. When Exa returns nothing, the tool tells the model to try another query or `webfetch` a relevant URL; it no longer mentions the Xiaomi plugin console.

### S2.3 Built-in workflows

`fact-check`, `deep-research` and the bundled `deep-research` skill search with the `websearch` tool or a configured search MCP tool. Without either they do not scrape search-engine result pages: they `webfetch` primary sources they can name directly and use free public APIs (arXiv, GitHub search, …); `fact-check` returns no hits when that finds nothing, and `deep-research` states that web search was not configured.

### S2.4 Documentation

README (English and Chinese) gains a collapsible "How to set up web search" FAQ entry that only explains how to enable search: the built-in Exa tools, and `mcp` configuration examples for Exa (remote), Tavily (remote, API key header or keyless header) and Volcengine Doubao Search (official `mcp-server-askecho-search-infinity`, local via `uvx`, `ASK_ECHO_SEARCH_INFINITY_API_KEY`). Keys use `{env:VAR}` substitution. The `xiaomi-auth-provider-split` feature doc is corrected: Xiaomi-family models no longer route websearch.

## [S3] Out of Scope

- The other Xiaomi-family checks from #2739 (request attribution header, output-token defaults, voice credential order, model ordering); they are audited separately.
- Any desktop change; the desktop never enables Exa, so it loses nothing it uses.
- A generic search-provider abstraction or bundling any MCP server.

## Tasks

- [x] T1: Drop the Xiaomi websearch gate and gateway client — acceptance: no provider gets `websearch` or `codesearch` without `MIMOCODE_ENABLE_EXA`; `tool/websearch/mimo.ts` is gone and the fallback text no longer mentions the Xiaomi plugin console (covers: S2.1, S2.2)
- [x] T2: research workflows and skill search fallback — acceptance: the `fact-check` and `deep-research` workflow prompts and the bundled `deep-research` skill name `websearch` or a search MCP tool and, without one, only primary sources and public APIs — no search-engine scraping (covers: S2.3)
- [x] T3: README "How to set up web search" entry and `xiaomi-auth-provider-split` correction — acceptance: the FAQ entry documents the configuration paths with valid `mcp` entries and no Xiaomi-specific wording; the old spec no longer claims family websearch routing (covers: S2.4)

## Journey log

- The first attempt kept the gateway search and made it resolve endpoint and key like the chat request, plus a `MIMOCODE_DISABLE_WEBSEARCH` switch for embedders. It was dropped once it became clear the plugin is pay-as-you-go only, so the family gate itself was wrong, and the low result quality did not justify keeping a first-party search.
- Several MCP and provider-refresh suites mock modules process-wide and run isolated in CI (`.github/workflows/test.yml`); running them in one process with other files produces unrelated failures.
