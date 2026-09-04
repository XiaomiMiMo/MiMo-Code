---
feature: default-model-stable-fallback
status: delivered
updated: 2026-09-01
branch: default-model-stable-fallback
commits: fa69916897..afdd76ec62
---

# Default Model Stable Fallback

## Report

**What was built** — `Provider.defaultModel()` no longer ranks models with the TUI menu `sort()` priority list (`gpt-5` / `claude-sonnet-4` / `gemini-3-pro`, then `latest`). The chain is now: validated `cfg.model` (warn + fall through if missing) → existing `recent` → first allowed provider with a usable chat model (`toolcall` + text input + non-zero context), first by id ascending. Stale `cfg.model` values that are no longer in the live registry fall through instead of being returned blindly. Capability filter prevents last-resort from selecting models like live `openai/chatgpt-image-latest` (`tool_call: false`, `context: 0`).

**Verification** — `bun test test/provider` → pass / 0 fail (includes new cases: invalid cfg fallthrough, recent hit over id-asc first, valid cfg beats recent, invalid cfg + recent, non-chat last-resort skip, no priority-substring preference). `bun run typecheck` → clean.

**Journey log** — Desktop does not write TUI `state/model.json` `recent`, so empty recent is the common Desktop case, not a rare one; a “first provider model” fallback without a product-default path would re-open the same bug. First review flagged a missing recent-hit test and a weak last-resort test; both were fixed before finalize.

## [S1] Problem

`Provider.defaultModel()` is the engine's last-resort model resolver for internal tasks (title generation, predict, agents, MCP sampling) when no session context is available.

Its final fallback previously did:

1. pick the first allowed provider
2. run `sort()` over that provider's models (`priority` substrings `gpt-5` / `claude-sonnet-4` / `gemini-3-pro`, then `latest`, then id desc)

That sort was written for TUI menu ranking, not as a product default. On MiMo Desktop:

- `cfg.model` is not injected
- TUI-only `state/model.json` `recent` is almost always empty
- the registry may contain router leftovers (e.g. `claude-sonnet-4-6-006`)

Result: title generation and other cheap tasks can resolve to an unavailable or unsupported model while the user's conversation model works fine. Log evidence already exists in Desktop (`title generation` → 400 Unsupported model / `ProviderModelNotFoundError`).

`cfg.model` also returned without existence validation, so a stale configured default was forwarded until the request failed.

## [S2] Design

`Provider.defaultModel()` is a **stable, validated chain**. No product-priority substring ranking.

```text
1. cfg.model
   - parse provider/model
   - MUST exist in the live provider registry
   - missing → warn + fall through (do not throw)
2. state/model.json recent[]
   - first entry whose provider+model still exist
3. first allowed provider that has a usable chat model
   - usable = toolcall && text input && limit.context > 0
   - first such model by id ascending (deterministic)
   - no priority list, no "latest" preference
4. no provider / no usable model → throw the existing clear errors
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
- Cost-aware last-resort pick (google-only setups can still land on an expensive usable model such as deep-research-*; filter only guarantees "usable", not "cheap")

## Tasks

- [x] T1: Rewrite `defaultModel()` chain (validate cfg.model, keep recent, drop menu-priority sort; last-resort requires usable chat model) — acceptance: unit tests cover invalid cfg fallthrough, recent hit, cfg-beats-recent, non-chat skip, first-provider stable pick, and no priority substring preference (covers: S2)
- [x] T2: Adjust/extend provider tests — acceptance: `bun test packages/opencode/test/provider` passes; new cases assert the chain order and that `gpt-5`-like ids are not auto-preferred when earlier steps miss (covers: S2; depends: T1)
