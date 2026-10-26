---
feature: drop-mimo-npm-pin
status: delivered
updated: 2026-10-20
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2717
---

# Drop mimo model-id npm pin

## Report

**What was built** — Model `api.npm` is pass-through (`model.provider.npm` → `provider.npm` → existing → models.dev → default `@ai-sdk/openai-compatible`). Deleted `isMimoOrSmartModel` / `resolveModelNpm`, which forced any `mimo`-named id onto `@ai-sdk/openai-compatible` and broke Anthropic-protocol custom providers (#2660). Official `xiaomi` / desktop `mimo-desktop` tracks already declare openai-compatible in catalog/config and are unaffected. Tests now assert explicit `@ai-sdk/anthropic` / `@ai-sdk/openai` survive on mimo-named ids.

**Verification** —
- `bun typecheck` (packages/cli): PASS
- `bun test test/provider/` (packages/cli): 612 pass / 0 fail
- Desktop gate (source review + reviewer): `xiaomi` and `mimo-desktop` bootstraps both `npm: "@ai-sdk/openai-compatible"`; `interleaved.reasoning_content` preserved; no xiaomi→Copilot loader remains (Copilot only via `@ai-sdk/github-copilot`)
- Reviewer (general-1): spec compliance / correctness / consistency all met; no critical findings

## [S1] Problem

`resolveModelNpm` / `isMimoOrSmartModel` force any model id matching `/(^|[/_-])mimo(?:-|$)/i` onto `@ai-sdk/openai-compatible`, even when the user or catalog explicitly declared another adapter (`@ai-sdk/anthropic`, `@ai-sdk/openai`, …). That breaks Anthropic-protocol custom providers (issue #2660): the request goes to `<baseURL>/chat/completions` instead of `/messages` and 400s.

The pin was added after a real desktop bug (Xiaomi chat routed through the Copilot fork, which strips `reasoning_content`), but the root cause was the Copilot chat schema — not the adapter package name. Official `xiaomi` / desktop `mimo-desktop` providers already declare `npm: "@ai-sdk/openai-compatible"` plus `interleaved.reasoning_content`. Protocol choice must follow explicit `npm`, not model-name heuristics.

## [S2] Design

### S2.1 npm resolution is pass-through

Model `api.npm` is the first non-empty of:

1. `model.provider.npm`
2. `provider.npm`
3. existing model `api.npm`
4. models.dev provider `npm`
5. default `@ai-sdk/openai-compatible`

No post-pass rewrites the value based on model id. Delete `isMimoOrSmartModel` and `resolveModelNpm` (and the pin comment).

### S2.2 Call sites

- `fromModelsDevModel`: use the resolution chain above on `model.id` only as data, never as a pin trigger.
- Config provider registration: same chain for `modelID` / `apiID`; both remain ordinary ids.

### S2.3 Desktop path (pre-merge gate, not code change here)

MiMo Desktop official tracks already set:

- `xiaomi` bootstrap and `mimo-desktop` bootstrap: `npm: "@ai-sdk/openai-compatible"`
- models.dev `xiaomi`: provider `npm: "@ai-sdk/openai-compatible"`, models `interleaved: { field: "reasoning_content" }`
- proxy accepts both `/route/chat/completions` and `/route/responses`

Removing the pin cannot change desktop official-track adapter selection because those configs never relied on the pin (their npm is already openai-compatible). Pre-merge verification must re-check that claim against the live desktop sources and note any residual coupling (e.g. a desktop-side pin or Copilot special-case).

## [S3] Out of Scope

- Desktop (`~/src/mimo-desktop`) code or config changes
- Copilot fork / `@ai-sdk/github-copilot` behavior
- models.dev catalog content
- Issue #2660 workaround docs

## Tasks

- [x] T1: Remove `isMimoOrSmartModel` / `resolveModelNpm` and pass npm through at both call sites — acceptance: no name-based npm rewrite remains in `packages/cli/src/provider/provider.ts` (covers: S2.1, S2.2)
- [x] T2: Replace pin tests with explicit-npm-respected cases — acceptance: tests assert `@ai-sdk/anthropic` and `@ai-sdk/openai` survive on mimo-named ids; stock default still openai-compatible (covers: S2.1)
- [x] T3: Verify desktop official path is unaffected — acceptance: desktop `xiaomi`/`mimo-desktop` npm and interleaved fields re-confirmed from `~/src/mimo-desktop` sources; no remaining xiaomi→Copilot loader (covers: S2.3)
- [x] T4: Typecheck + provider tests green in the worktree — acceptance: recorded command results (depends: T1, T2)

## Journey log

- The pin's original motivation (Copilot fork stripping `reasoning_content`) was real but was fixed by dropping the xiaomi→Copilot loader (`294328d7`), not by name-based npm rewriting. Keep protocol selection on explicit `npm` only.
