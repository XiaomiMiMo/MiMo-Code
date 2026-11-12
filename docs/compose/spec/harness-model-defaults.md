---
feature: harness-model-defaults
status: in-progress
updated: 2026-11-12
source: feat/harness-model-defaults
---

# Harness Model Defaults

## Report
[Not finalized yet]

## [S1] Problem
After unify-default-harness, the request layer still carries mid-2026 per-model
tuning keyed on model-name substrings: hardcoded sampling defaults per family,
`textVerbosity: "low"` for gpt-5.x, a claude/gpt/mimo "large model" output cap
that ignores the catalog, name-keyed reasoning-effort tables, and a GPT-only
exception in assistant-step classification. Vendors now publish defaults and
capabilities (models.dev `limit`, `reasoning_options`), so the harness should
take the model's own settings and keep only explicit, protocol-level handling.

## [S2] Design

### S2.1 Context and output limits come from the model
`limit.context` and `limit.output` come from user config or models.dev. When
neither declares a value the fallbacks are `1_000_000` context (unchanged) and
`128_000` output. The request `maxOutputTokens` is `limit.output`. The
claude/gpt/mimo name heuristic (`usesLargeModelDefaults`), the 32K cap and
`MIMOCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` are removed.

### S2.2 No per-model sampling defaults
temperature, topP and topK are sent only when the user or agent config sets
them; the per-model-id defaults are removed so the vendor's server defaults
apply. The existing `capabilities.temperature` gate is kept.

### S2.3 No default text verbosity
The hardcoded `textVerbosity: "low"` for gpt-5.x is removed; the API default
applies unless the user configures it.

### S2.4 Reasoning effort levels come from models.dev
`variants(model)` offers exactly the levels declared by models.dev
`reasoning_options` (`capabilities.efforts`) or user config; a reasoning model
with no declared effort levels gets no levels (budget-only and toggle-only
included). All name/date-keyed level lists are removed. The wire shape of a
level is chosen by SDK package (`api.npm`). Model-family detection survives
only where an aggregator SDK fronts families that need different request shapes
(e.g. Bedrock anthropic vs nova, Copilot gpt vs claude, adaptive-thinking
display flags); each such branch carries a comment stating the protocol reason.
User-config `variants` keep working through `configuredVariants`.

### S2.5 Assistant step classification is driven by the finish reason
- The provider's raw finish reason (`rawFinishReason` from the AI SDK
  `finish-step`) is persisted on the assistant message (optional field in the
  existing JSON payload; no migration).
- `stop` with no client tool calls ends the turn whether it produced text or only
  reasoning; the `think-only` path and the GPT-only exception are removed.
  A step with no text, reasoning or tool call stays `invalid` (retried).
- `other` with no raw reason means the stream ended without a terminal frame:
  it raises an explicit retryable error (stream did not finish normally) handled
  by SessionRetry, and is never treated as terminal (classification, tool
  auto-resume, trailing-error swallowing).
- `other` with a raw reason ends the turn and logs/records the raw reason.
- Anthropic `pause_turn` (raw) continues the turn instead of ending it.
- `length`, `tool-calls`, `error`, `content-filter` behave as today.

### S2.6 Kept
`store: false` and `include: ["reasoning.encrypted_content"]` for OpenAI
Responses, per-SDK parameter shapes, OpenAI OAuth / Copilot omission of
`maxOutputTokens`.

## [S3] Out of Scope
- Prompt or toolset changes (done in unify-default-harness).
- Transport compatibility shims (tool-call id scrubbing, schema fixups, cache
  markers, attachment packaging).

## Tasks
- [x] T1: Output limit from model, 128_000 fallback, remove name heuristic and 32K cap — acceptance: maxOutputTokens equals limit.output for any model; undeclared output resolves to 128_000 (covers: S2.1)
- [x] T2: Remove per-model sampling defaults — acceptance: no temperature/topP/topK sent unless configured (covers: S2.2)
- [x] T3: Remove default textVerbosity — acceptance: gpt-5.x options carry no textVerbosity (covers: S2.3)
- [ ] T4: Effort levels from models.dev only; shapes by SDK package — acceptance: undeclared reasoning models get no variants; declared levels map to the SDK shape; no name/date level lists remain (covers: S2.4)
- [ ] T5: Finish-reason-driven step classification with persisted raw reason — acceptance: stop+reasoning-only ends the turn for every model; other without raw retries with an explicit error; other with raw ends with the reason recorded; pause_turn continues (covers: S2.5)
- [ ] T6: Update tests; typecheck and related suites pass (depends: T1, T2, T3, T4, T5)

## Journey log
None
