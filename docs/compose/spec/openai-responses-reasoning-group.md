---
feature: openai-responses-reasoning-group
status: delivered
updated: 2026-11-27
source: fix/openai-responses-reasoning-group
---

# Preserve OpenAI Responses Reasoning Block Grouping When Stateless

## Report

**What was built** — Patched `@ai-sdk/openai@3.0.113` and `@ai-sdk/openai@3.0.48` (the nested copy resolved by `@ai-sdk/azure@3.0.49`) across all four runtime entry files (`dist/index.{mjs,js}` and `dist/internal/index.{mjs,js}`) so stateless (`store: false`) Responses serialization keeps grouping multi-summary `reasoning` parts by `itemId` without emitting wire `id`, and coalesces no-`itemId` parts sharing identical `reasoningEncryptedContent` per assistant message. Updated `ProviderTransform.message()` to retain `itemId` on `reasoning` parts as the local grouping key while continuing to strip `itemId` from non-`reasoning` parts (`text`, `tool-call`, etc.) and message-level options when `store !== true`.

**Verification** — From the worktree root:
- `bun ci` -> PASS
- `bun run typecheck` (all workspaces + `tsconfig.scripts.json`) -> PASS
- `git diff --check` -> PASS
- `bunx oxlint packages/cli/test/provider/openai-responses-reasoning-group.test.ts` -> PASS (0 errors, 4 warnings)
- `bun test --cwd packages/cli --only-failures test/provider/openai-responses-reasoning-group.test.ts test/provider/transform.test.ts test/provider/provider.test.ts test/provider/openai-responses-exec-custom.test.ts test/session/message-v2.test.ts` -> PASS (396 pass, 0 fail, 1712 assertions)
- Independent review (`41f7f90c..cdd6c2eb`) -> PASS (spec compliance, correctness, and codebase consistency passed with no critical issues).

## [S1] Problem
When a stateless (`store: false`) OpenAI Responses model returns a single `reasoning` output item containing multiple `summary` entries and one `encrypted_content` ciphertext, `@ai-sdk/openai` emits each summary entry as a separate AI SDK `reasoning` part sharing the same `providerMetadata.<ns>.itemId` (`rs_...`).

Before sending history on subsequent turns, `ProviderTransform.message()` strips `itemId` from every part for `@ai-sdk/openai` and `@ai-sdk/azure` whenever `store !== true`, to avoid sending server-side `rs_...` references to stateless proxies. Once `itemId` is gone, `@ai-sdk/openai@3.0.113`'s `convertToOpenAIResponsesInput()` falls into its no-`itemId` branch, which does not group parts:

1. When multiple summary parts carry the same `reasoningEncryptedContent` (non-streaming responses, or streams where `output_item.done` concludes multiple active summary parts together), the single generated `reasoning` item is split into N independent `reasoning` input items, each containing one summary entry and a byte-for-byte duplicate of the same `encrypted_content`.
2. When only the last summary part carries `reasoningEncryptedContent` (standard SSE where earlier summary parts conclude before `output_item.done`), earlier summary parts have neither `itemId` nor `reasoningEncryptedContent` and are silently dropped.

In both cases, the replayed history diverges from the generated reasoning block (`row != G`), triggering downstream `reasoning_content_blocks_changed` / `thinking_stripped` attribution against the harness.

## [S2] Design

### S2.1 Decouple local reasoning grouping from wire `id` in `@ai-sdk/openai`
Patch `@ai-sdk/openai@3.0.113` (`patches/@ai-sdk%2Fopenai@3.0.113.patch`) and the nested `@ai-sdk/openai@3.0.48` resolved by `@ai-sdk/azure@3.0.49` (`patches/@ai-sdk%2Fopenai@3.0.48.patch`), registered in root `package.json` `patchedDependencies` and `bun.lock`, across all four runtime entry files per package (`dist/index.mjs`, `dist/index.js`, `dist/internal/index.mjs`, `dist/internal/index.js`):

1. **Stateless `itemId` grouping without wire `id`**: In `convertToOpenAIResponsesInput()`'s `assistant` / `reasoning` handler, when `reasoningId != null` and `!store`, continue grouping all `reasoning` parts sharing `reasoningId` into one entry in `reasoningMessages[reasoningId]`, appending each non-empty `part.text` as a separate `{ type: "summary_text", text }` item and updating `encrypted_content` whenever a part provides a non-null `reasoningEncryptedContent`. Omit the `id` property from the emitted wire `reasoning` object (`{ type: "reasoning", encrypted_content, summary }`) so stateless proxies never receive `rs_...` references.
2. **Stateful & conversation modes unchanged**: When `store === true`, keep emitting a single `{ type: "item_reference", id: reasoningId }`. When `hasConversation || hasPreviousResponseId`, keep skipping items that have `reasoningId != null`.
3. **Encrypted-content fallback grouping**: When `reasoningId == null` and `encryptedContent != null`, maintain a per-assistant-message map `reasoningByEncryptedContent` keyed by `encryptedContent`. Parts sharing the same `encryptedContent` append non-empty `summary_text` entries into the single emitted `reasoning` item rather than emitting duplicate items with copied ciphertext. Parts with neither `itemId` nor `encryptedContent` retain the existing warning and skip behavior.

### S2.2 Keep `reasoning` `itemId` as grouping key in `ProviderTransform.message()`
In `packages/cli/src/provider/transform.ts`, when `options.store !== true` and `model.api.npm` is `@ai-sdk/openai` or `@ai-sdk/azure`:

1. Continue stripping `providerOptions[key].itemId` from non-`reasoning` parts (`text`, `tool-call`, etc.) and message-level options so wire requests stay free of `msg_...` / `fc_...` item IDs.
2. Preserve `providerOptions[key].itemId` on `reasoning` parts so `@ai-sdk/openai` can group multi-summary parts belonging to the same `reasoning` output item (including when earlier summary parts lack `reasoningEncryptedContent`) while omitting `id` on the wire per S2.1.

### S2.3 End-to-end wire verification
Add tests exercising both `ProviderTransform.message()` and the real installed `@ai-sdk/openai` / `@ai-sdk/azure` Responses models against a local HTTP server (or request capture) to assert the actual wire JSON `input`:

1. Multi-summary reasoning with identical `reasoningEncryptedContent` on every summary part serializes as **1** `type: "reasoning"` item with `id === undefined`, `summary` preserving all distinct `summary_text` entries in order (`summary.length === 2`), and 1 `encrypted_content`.
2. Multi-summary reasoning where only the final summary part carries `reasoningEncryptedContent` (standard SSE sequence) also serializes as **1** `type: "reasoning"` item with `id === undefined`, all `summary_text` entries preserved in order, and the single `encrypted_content`.
3. Multi-summary reasoning whose `itemId` is absent on all parts but sharing identical `reasoningEncryptedContent` still coalesces into **1** `type: "reasoning"` item without duplicating `encrypted_content`.
4. Two distinct reasoning items (different `itemId` / different `encrypted_content`) remain separate `reasoning` items, non-`reasoning` parts (`text`, `tool-call`) still omit `id`, and `store: true` still emits `item_reference` with `id`.
5. Azure Responses (`@ai-sdk/azure`, which imports `OpenAIResponsesLanguageModel` from `@ai-sdk/openai/internal`) exhibits the same stateless grouping without wire `id`.

## [S3] Out of Scope
- Upgrading `@ai-sdk/openai` to a different version or modifying unrelated provider SDKs (`@ai-sdk/github-copilot`, `@ai-sdk/xai`, `@ai-sdk/openai-compatible`).
- Changing how `SessionProcessor` persists `ReasoningPart` rows or how `MessageV2.toModelMessages` projects stored parts.
- Changing `store: true` stateful Responses behavior or signed request bodies in fetch wrappers.

## Tasks
- [x] T1: Create `@ai-sdk/openai@3.0.113` patch and register it in `package.json` and `bun.lock` — acceptance: `bun ci` succeeds with the patch applied across `dist/index.{mjs,js}` and `dist/internal/index.{mjs,js}` (covers: S2.1)
- [x] T2: Update `ProviderTransform.message()` to keep `itemId` on `reasoning` parts while still stripping it from non-`reasoning` parts when `store !== true` — acceptance: unit tests verify `reasoning` keeps `itemId` and `text`/`tool-call` drop `itemId` (covers: S2.2)
- [x] T3: Add wire-level regression tests for `@ai-sdk/openai` and `@ai-sdk/azure` stateless multi-summary reasoning replay — acceptance: all S2.3 scenarios pass against the real installed SDKs and `typecheck` passes (covers: S2.3, depends: T1, T2)

## Journey log
- Live verification against `@ai-sdk/azure@3.0.49` showed that `bun.lock` resolves a nested `@ai-sdk/openai@3.0.48` copy under `@ai-sdk/azure` rather than the top-level `3.0.113`. Applying the identical patch to `@ai-sdk/openai@3.0.48` closed that gap.
