---
feature: openai-responses-reasoning-group
status: delivered
updated: 2026-11-27
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2877
---

# Preserve OpenAI Responses Reasoning Block Grouping When Stateless

## Report

**What was built** — Removed both `@ai-sdk/openai` patches (`3.0.113` and nested `3.0.48` used by `@ai-sdk/azure`) from `patches/`, `package.json`, and `bun.lock`. Kept `ProviderTransform.message()` preserving `providerOptions[key].itemId` on `reasoning` parts while stripping `itemId` from non-`reasoning` parts (`text`, `tool-call`, etc.) and message-level options when `store !== true`, letting stock `@ai-sdk/openai` group multi-summary reasoning parts into a single `{ type: "reasoning", id, encrypted_content, summary }` wire item — aligned with current `openai/codex` (PRs `#32312`, `#60771`, `#60977`) and Azure OpenAI v1 / `@ai-sdk/openai` (`vercel/ai#12687`, `#14983`). Updated wire-level regression tests to verify stock `@ai-sdk/openai` and `@ai-sdk/azure` replay behavior.

**Verification** — From the worktree root:
- `bun ci` -> PASS (verified stock unpatched `@ai-sdk/openai@3.0.113` and `3.0.48` installed)
- `bun run typecheck` (all workspaces + `tsconfig.scripts.json`) -> PASS
- `git diff --check` -> PASS
- `bunx oxlint packages/cli/test/provider/openai-responses-reasoning-group.test.ts` -> PASS (0 warnings, 0 errors)
- `bun test --cwd packages/cli --only-failures test/provider/openai-responses-reasoning-group.test.ts test/provider/transform.test.ts test/provider/provider.test.ts test/provider/openai-responses-exec-custom.test.ts test/session/message-v2.test.ts` -> PASS (394 pass, 0 fail, 1702 assertions)
- Independent review (`177f87b3..83b8e3b5`) -> PASS (spec compliance, correctness, and codebase consistency passed with no critical issues).

## [S1] Problem
When a stateless (`store: false`) OpenAI Responses model returns a single `reasoning` output item containing multiple `summary` entries and one `encrypted_content` ciphertext, `@ai-sdk/openai` emits each summary entry as a separate AI SDK `reasoning` part sharing the same `providerMetadata.<ns>.itemId` (`rs_...`).

Before sending history on subsequent turns, `ProviderTransform.message()` strips `itemId` from every part for `@ai-sdk/openai` and `@ai-sdk/azure` whenever `store !== true`, to avoid sending server-side `rs_...` references to stateless proxies. Once `itemId` is gone, `@ai-sdk/openai@3.0.113`'s `convertToOpenAIResponsesInput()` falls into its no-`itemId` branch, which does not group parts:

1. When multiple summary parts carry the same `reasoningEncryptedContent` (non-streaming responses, or streams where `output_item.done` concludes multiple active summary parts together), the single generated `reasoning` item is split into N independent `reasoning` input items, each containing one summary entry and a byte-for-byte duplicate of the same `encrypted_content`.
2. When only the last summary part carries `reasoningEncryptedContent` (standard SSE where earlier summary parts conclude before `output_item.done`), earlier summary parts have neither `itemId` nor `reasoningEncryptedContent` and are silently dropped.

In both cases, the replayed history diverges from the generated reasoning block (`row != G`), triggering downstream `reasoning_content_blocks_changed` / `thinking_stripped` attribution against the harness.

## [S2] Design

### S2.1 Rely on stock `@ai-sdk/openai` without SDK patches
Remove `patches/@ai-sdk%2Fopenai@3.0.113.patch` and `patches/@ai-sdk%2Fopenai@3.0.48.patch` along with their `patchedDependencies` entries in root `package.json` and `bun.lock`.

Stock `@ai-sdk/openai` (`3.0.113` for OpenAI and nested `3.0.48` for `@ai-sdk/azure`) already groups multi-summary `reasoning` parts by `itemId` when `store: false`, appends each non-empty `summary_text` entry in order, preserves `encrypted_content` (including when only the final summary carries it), and emits `{ type: "reasoning", id, encrypted_content, summary }`.

References establishing that stateless Responses reasoning replay preserves prefixed `id` alongside `encrypted_content`:
- `openai/codex`: `codex-rs/protocol/src/models.rs` (`ResponseItem::Reasoning.id` serialized with `skip_serializing_if = "Option::is_none"` and `OptionalWireItemId`), PRs `#32312`, `#60771`, `#60977` — keeps prefixed item IDs (`rs_...`, `msg_...`, `fc_...`) on `store: false` requests (reversing the earlier 2025-09 `#3390` workaround).
- `vercel/ai`: issue `#12687` and closed PR `#14983` — confirmed Azure OpenAI v1 stateless Responses documentation and REST schema expect `id` on replayed reasoning items, so `@ai-sdk/openai` intentionally keeps `id: reasoningId` in the `!store` path.

### S2.2 Keep `reasoning` `itemId` in `ProviderTransform.message()`
In `packages/cli/src/provider/transform.ts`, when `options.store !== true` and `model.api.npm` is `@ai-sdk/openai` or `@ai-sdk/azure`:

1. Continue stripping `providerOptions[key].itemId` from non-`reasoning` parts (`text`, `tool-call`, etc.) and message-level options.
2. Preserve `providerOptions[key].itemId` on `reasoning` parts so stock `@ai-sdk/openai` groups multi-summary parts belonging to the same `reasoning` output item into a single wire item `{ type: "reasoning", id, encrypted_content, summary }` without splitting blocks, duplicating `encrypted_content`, or dropping earlier summary parts. Document the upstream Codex and Vercel AI SDK references in the code comment.

### S2.3 End-to-end wire verification
Verify both `ProviderTransform.message()` and stock (unpatched) `@ai-sdk/openai` / `@ai-sdk/azure` Responses models via request capture against the actual wire JSON `input`:

1. Multi-summary reasoning with identical `reasoningEncryptedContent` on every summary part serializes as **1** `type: "reasoning"` item with `id` preserved (`"rs_..."`), `summary` preserving all distinct `summary_text` entries in order (`summary.length === 2`), and 1 `encrypted_content`.
2. Multi-summary reasoning where only the final summary part carries `reasoningEncryptedContent` (standard SSE sequence) also serializes as **1** `type: "reasoning"` item with `id` preserved, all `summary_text` entries preserved in order, and the single `encrypted_content`.
3. Two distinct reasoning items (different `itemId` / different `encrypted_content`) remain separate `reasoning` items with their respective `id` values, non-`reasoning` parts (`text`, `tool-call`) still omit `id`, and `store: true` still emits `item_reference` with `id`.
4. Azure Responses (`@ai-sdk/azure`, using stock nested `@ai-sdk/openai@3.0.48`) exhibits the same stateless grouping with `id` preserved.
5. Real two-turn SSE round-trips (both unified `output_item.done` and standard `reasoning_summary_part.done`, including custom `providerID` remapping) emit a single `reasoning` block on turn 2 with `id`, both `summary_text` entries, and 1 `encrypted_content`.

## [S3] Out of Scope
- Upgrading `@ai-sdk/openai` to a different version or modifying unrelated provider SDKs (`@ai-sdk/github-copilot`, `@ai-sdk/xai`, `@ai-sdk/openai-compatible`).
- Changing how `SessionProcessor` persists `ReasoningPart` rows or how `MessageV2.toModelMessages` projects stored parts.
- Changing `store: true` stateful Responses behavior or signed request bodies in fetch wrappers.
- Coalescing synthetic/malformed reasoning parts that lack `itemId` entirely (real Responses output items always carry `itemId`).

## Tasks
- [x] T4: Remove `@ai-sdk/openai@3.0.113` and `@ai-sdk/openai@3.0.48` patches from `patches/`, `package.json`, and `bun.lock` — acceptance: `bun ci` succeeds with no `@ai-sdk/openai` entries in `patchedDependencies` (covers: S2.1)
- [x] T5: Update `ProviderTransform.message()` comment with upstream `openai/codex` and `vercel/ai` references — acceptance: comment accurately explains stock `@ai-sdk/openai` grouping and wire `id` preservation without referencing SDK patches (covers: S2.2)
- [x] T6: Update wire-level regression tests for stock `@ai-sdk/openai` and `@ai-sdk/azure` stateless multi-summary reasoning replay (asserting preserved `id`, single block, ordered `summary`, single `encrypted_content`) — acceptance: all S2.3 scenarios pass and `typecheck` / `oxlint` pass (covers: S2.3, depends: T4, T5)

## Journey log
- Live verification against `@ai-sdk/azure@3.0.49` showed that `bun.lock` resolves a nested `@ai-sdk/openai@3.0.48` copy under `@ai-sdk/azure` rather than the top-level `3.0.113`. Applying the identical patch to `@ai-sdk/openai@3.0.48` closed that gap in PR #2875.
- Follow-up verification against latest `openai/codex` (`main`, PRs `#32312`, `#60771`, `#60977`) and `vercel/ai` (`#12687`, `#14983`) showed that both Codex and Azure OpenAI v1 now expect prefixed `id` on stateless (`store: false`) replayed `reasoning` items alongside `encrypted_content`, and `@ai-sdk/openai` intentionally preserves `id` in the `!store` branch. Pivoted to dropping both `@ai-sdk/openai` patches and relying solely on preserving `reasoning` `itemId` in `ProviderTransform.message()`, removing patch maintenance burden and aligning with Codex, Azure v1, and stock `@ai-sdk/openai`.
