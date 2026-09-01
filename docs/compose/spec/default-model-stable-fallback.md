---
feature: default-model-stable-fallback
status: in-progress
updated: 2026-09-01
branch: default-model-stable-fallback
commits: 
---

# Default Model Stable Fallback

## Report

## [S1] Problem

`Provider.defaultModel()` is the engine's last-resort model resolver for internal tasks (title generation, predict, agents, MCP sampling) when no session context is available.

Its final fallback currently does:

1. pick the first allowed provider
2. run `sort()` over that provider's models (`priority` substrings `gpt-5` / `claude-sonnet-4` / `gemini-3-pro`, then `latest`, then id desc)

That sort was written for TUI menu ranking, not as a product default. On MiMo Desktop:

- `cfg.model` is not injected
- TUI-only `state/model.json` `recent` is almost always empty
- the registry may contain router leftovers (e.g. `claude-sonnet-4-6-006`)

Result: title generation and other cheap tasks can resolve to an unavailable or unsupported model while the user's conversation model works fine. Log evidence already exists in Desktop (`title generation` → 400 Unsupported model / `ProviderModelNotFoundError`).

`cfg.model` also returns without existence validation, so a stale configured default is forwarded until the request fails.

## [S2] Design

`Provider.defaultModel()` becomes a **stable, validated chain**. No product-priority substring ranking.

```text
1. cfg.model
   - parse provider/model
   - MUST exist in the live provider registry
   - missing → fall through (do not throw)
2. state/model.json recent[]
   - first entry whose provider+model still exist
3. mimo/mimo-auto if present (existing TUI free-channel special case)
4. first allowed provider (same cfg.provider whitelist as today)
   - first model in that provider by id ascending (deterministic)
   - no priority list, no "latest" preference
5. no provider / no model → throw the existing clear errors
   ("no providers found" / "no models found")
```

Contracts:

- `sort()` stays for TUI menus / `defaultModelIDs` / ACP listing. Only `defaultModel()` stops using it.
- `defaultModel()` return type is unchanged: `Effect<{ providerID, modelID }>`.
- Call sites that catch resolution failure keep working; success no longer depends on priority substrings.
- Existence checks use the same in-memory `InstanceState` provider map already used for recent.

Not changing in this feature:

- cheap-task preferred session model (separate fix, Plan B)
- Desktop injecting `model` / `model_groups.lite`
- writing `recent` from Desktop

## [S3] Out of Scope

- Changing `getSmallModel` / `genTitle` to prefer the conversation model
- Injecting Desktop `model_groups.lite`
- Rewriting TUI's own UI fallback in `packages/app` or `cli/cmd/tui/context/local.tsx`
- Deleting `Provider.sort` or `defaultModelIDs`

## Tasks

- [ ] T1: Rewrite `defaultModel()` chain (validate cfg.model, keep recent + mimo-auto, drop sort) — acceptance: unit tests cover invalid cfg fallthrough, recent hit, mimo-auto hit, first-provider stable pick, and no priority substring preference (covers: S2)
- [ ] T2: Adjust/extend provider tests — acceptance: `bun test packages/opencode/test/provider` passes; new cases assert the chain order and that `gpt-5`-like ids are not auto-preferred when earlier steps miss (covers: S2; depends: T1)
