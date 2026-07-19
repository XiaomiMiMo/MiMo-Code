# Audit: gpt-5.5 empty output / `reasoning part rs_… not found`

Date: 2026-07-02 · Branch: `vb/603e-gpt-5-5-bug` · Author: wqymi <wangqiying@xiaomi.com>

## Problem

Users on `gpt-5.5` (and other gpt-5.x reasoning models) via the `@ai-sdk/openai`
Responses API frequently saw:

- **Empty output** — the model returned a step with only reasoning / no text, which
  `session/classify.ts:108-116` labels `think-only` / `"empty output"`.
- **`reasoning part rs_… not found`** — a server-side Responses API rejection, seen even
  when the user's config already set `include: ["reasoning.encrypted_content"]`, and
  specifically against a **custom `baseURL` proxy** (MiMo Router), not `api.openai.com`.

Initial hypotheses that were **ruled out**:
- "ai-sdk too old" — false. `ai@6.0.168`, `@ai-sdk/openai@3.0.53` are current and identical
  to upstream `anomalyco/opencode` dev.
- Provider-level config `options` — the user's `reasoningEffort/include/…` were placed in the
  **provider-level** `options` block, which only feeds the SDK constructor
  (`provider.ts` resolveSDK), not per-request `providerOptions`. Per-request options come from
  the **model-level** `options` (`session/llm.ts:349`). So `reasoningEffort:'high'` was silently
  ignored (base `medium` shipped); `include` still shipped because base injects it. Not the
  root cause of `rs_ not found`, but a real config foot-gun (see "Operator guidance").

## Root causes & mechanics

The Responses API with `store: false` (forced for `providerID==="openai"` /
`npm==="@ai-sdk/openai"` at `transform.ts` `options()`) is **stateless**: encrypted reasoning
items must be echoed back on every turn, and the SDK drops any reasoning input item lacking
`encrypted_content` (`@ai-sdk/openai` dist `convert-to-openai-responses-input`: "Reasoning parts
without encrypted content are not supported when store is false").

1. **Missing `include` in base options.** MiMoCode's base `options()` set `store:false` +
   `reasoningEffort:medium` + `reasoningSummary:auto` for `@ai-sdk/openai`, but only set
   `include: ["reasoning.encrypted_content"]` when `providerID` started with `opencode` (or inside
   an explicitly-selected reasoning variant). Without `include`, OpenAI never returns
   `encrypted_content` → stored reasoning parts have `itemId` but no encrypted content → next turn
   the SDK drops them while the dependent `function_call` still references the reasoning `rs_` →
   `reasoning part rs_… not found`. Upstream sets `include` unconditionally for `@ai-sdk/openai`.

2. **Blanket item-id strip in the fetch wrapper (proxy-incompatible).** `provider.ts` had a
   fetch-wrapper block that, for `@ai-sdk/openai` non-Azure POSTs, ran `JSON.parse(opts.body)` →
   deleted `id` from **every** `input[]` item → re-serialized — **after request signing**. This
   "codex-style" strip is tolerated by official OpenAI (matches reasoning↔function_call by
   encrypted_content/position in stateless mode) but breaks against proxies that still validate
   the `rs_` reference. This code came from early upstream but upstream **refactored it away** in
   PR #31429 (commit `a86ecf3bb`, "adjust item id stripping to happen prior to request signing"):
   they moved it into the transform layer and strip only the `itemId` key from `providerOptions`,
   before serialization. MiMoCode's fork was stuck on the old implementation.

3. **8 ai-sdk provider deps behind upstream.** Not the cause of the above, but a maintenance gap;
   the notable ones carry real fixes (openrouter duplicate tool-call; google Vertex
   thoughtSignature).

## Changes (3 commits)

### 1. `915b1056c` — request encrypted reasoning for `@ai-sdk/openai` gpt-5.x
- `provider/transform.ts` (+7): in base `options()`, after the existing `reasoningSummary` gate,
  add `result["include"] = ["reasoning.encrypted_content"]` for `npm === "@ai-sdk/openai"` (non-pro
  gpt-5.x). Mirrors upstream.
- `test/provider/transform.test.ts` (+19): assert `include` + `store:false` for gpt-5.5 / gpt-5,
  and that `gpt-5-pro` does NOT set `include`.
- Effect: OpenAI returns `encrypted_content` → stored → replayed → survives the store:false filter.

### 2. `c67c94f5e` — strip openai Responses itemId in transform, not fetch wrapper (port of upstream PR #31429)
- `provider/provider.ts` (−15): removed the fetch-wrapper blanket id-strip block.
- `provider/transform.ts` (+): extracted `mapProviderOptions()` helper (also reused by the existing
  providerID→SDK-key remap). Added, in `message()`, a strip that runs **before serialization** and
  removes **only** `providerOptions[key].itemId` when `options.store !== true` and
  `npm ∈ {@ai-sdk/openai, @ai-sdk/azure}`. Keyed by `sdkKey(npm)` so a custom `providerID` (proxy)
  on the openai SDK still strips via the `openai` key. Preserves `reasoningEncryptedContent` and all
  other options.
  - Deliberate divergence from upstream: dropped `@ai-sdk/amazon-bedrock/mantle` from the npm list
    (MiMoCode uses `@ai-sdk/amazon-bedrock`, and the old code never stripped bedrock). Kept
    `openai` + `azure` to match prior MiMoCode behavior.
- `test/provider/transform.test.ts`: rewrote the "strip openai metadata when store=false" suite to
  assert the new behavior (itemId stripped for openai/azure when store≠true; encrypted content and
  other options preserved; store:true keeps id; non-openai/azure npm untouched; azure namespace).
- Effect: request body is no longer mutated post-signing, and reasoning `rs_` handling goes through
  a clean SDK-built body — fixes `rs_ not found` on custom-baseURL proxies.

### 3. `0dcdd77d7` — bump ai-sdk providers to match upstream (`anomalyco/opencode` dev)
Version bumps in `packages/opencode/package.json`:

| Package | Old → New | Notable |
|---|---|---|
| @ai-sdk/amazon-bedrock | 4.0.96 → 4.0.112 | routine |
| @ai-sdk/anthropic | 3.0.71 → 3.0.82 | model IDs + niche tool fixes |
| @ai-sdk/cerebras | 2.0.41 → 2.0.60 | routine |
| @ai-sdk/google | 3.0.63 → 3.0.73 | 3.0.71 fixes Vertex no-args streaming tool call dropping thoughtSignature (Gemini-3 thinking multi-turn 400) |
| @ai-sdk/google-vertex | 4.0.112 → 4.0.128 | routine |
| @openrouter/ai-sdk-provider | 2.5.1 → 2.9.0 | **2.9.0 fixes duplicate tool-call emit (streamText executing tools twice)**; 2.8.1 empty reasoning_details multi-turn; 2.6.0 deterministic tool-arg serialization |
| gitlab-ai-provider | 6.6.0 → 6.10.0 | see below |
| venice-ai-sdk-provider | 2.0.1 → 2.1.1 | routine |

Accompanying code change (hard requirement):
- **Dropped the obsolete `gitlab-ai-provider@6.6.0` patch** — removed root `package.json`
  `patchedDependencies` entry and deleted `patches/gitlab-ai-provider@6.6.0.patch`. Verified: the
  6.6.0 `dist/index.mjs` had 4 `__require` occurrences (the ESM dynamic-require shim the patch
  fixed); 6.10.0 has **0** and ships clean ESM. The version-pinned patch could no longer apply, so
  `bun install` would fail if it were carried forward. Upstream ships no gitlab patch.

xai stayed at 3.0.82 (already matched upstream).

## Verification

- `bun install` — clean, no patch-apply failure.
- `bun typecheck` (packages/opencode) — clean (no type-level API breakage from any bump).
- `bun test test/provider/` — 304/304 pass (incl. rewritten transform suite).
- Reverse test: the `include` tests fail with the fix reverted, pass with it applied.
- `bun.lock`: residual old versions appear only transitively under `ai-gateway-provider/*` (that
  package pins its own ai-sdk copies, as upstream does); direct deps resolve to the new versions.

## Operator guidance (config)

- `reasoningEffort` (and other per-request model behavior) must live in the **model-level**
  `options`, not the provider-level block:
  ```jsonc
  "openai": {
    "npm": "@ai-sdk/openai",
    "options": { "baseURL": "…", "apiKey": "…" },        // SDK-construction only
    "models": { "gpt-5.5": { "name": "gpt-5.5", "options": { "reasoningEffort": "high" } } }
  }
  ```
- `include` / `reasoningSummary` / `textVerbosity` / `store` are auto-injected by base `options()`
  for `@ai-sdk/openai` gpt-5.x — no need to set them manually (and avoid a stray backslash such as
  `reasoning.encrypted\_content`, which would be an invalid include value).

## Resolved follow-up

- **`smallOptions` include symmetry (done).** `smallOptions()` set `store:false` + `reasoningEffort`
  for gpt-5.x but not `include`. Small-model calls today are single-shot with no tool loop
  (title gen `prompt.ts:396` `tools:{}`; summarizer `prompt.ts:489`), so this could not trigger
  `rs_ not found` in practice — but it was an asymmetry with the main-model path. Added
  `include: ["reasoning.encrypted_content"]` for `@ai-sdk/openai` gpt-5.x in `smallOptions`
  (github-copilot excluded — it uses its own include path) as defense-in-depth, with tests
  (reverse-verified: they fail without the change).

## Open follow-up (not done)

Upstream also has a signature/redactedData-aware reasoning filter in `normalizeMessages`
(preserves empty-text reasoning parts carrying a `signature`/`redactedData`) plus an
`@ai-sdk/google@3.0.73` patch (pops empty Gemini `model` entries). MiMoCode's filter
(`transform.ts` normalizeMessages, anthropic/bedrock branch) still drops `text===""` reasoning
parts. This is an independent robustness improvement for thinking/thoughtSignature multi-turn — not
required by the bumps — and was intentionally left for separate evaluation.
