---
feature: harness-model-defaults
status: delivered
updated: 2026-11-12
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2799
---

# Harness Model Defaults

## Report

**What was built** — The request layer takes model behavior from the model's own
declarations and vendor defaults. `maxOutputTokens` is `limit.output` (fallback
128_000; context fallback 1_000_000) with the name heuristic, 32K cap and output
flag removed. temperature/topP/topK are sent only when configured; no default
textVerbosity. Effort levels come only from models.dev `reasoning_options` or
user config, mapped to per-SDK shapes in `effortOptions()` with family detection
only behind aggregator SDKs; `options()` sends only reasoning transport and
`smallOptions()` uses the lowest declared non-off level. Assistant steps record
`rawFinish`; `stop` ends the turn even when only reasoning was produced; a live
stream that ends without a finish frame raises a retryable
`StreamIncompleteError` (stream budget), max-mode drops such candidates, and a
raw-less `other` in history is judged by content; `other` with a raw reason ends
the turn and is recorded.

**Verification** — `bun run typecheck` (packages/cli): PASS. Related suites
(provider, session llm/prompt/classify/classify-integration/auto-resume-after-
tools/invalid-output-continuation/retry/prompt-effect/max-mode*/structured-output/
message-v2, server/session-recovery, tool/actor, llm-server): 1341 pass, then
345 pass on the final classify adjustments. Two independent reviews; criticals
fixed. MiMo Anthropic endpoint probed live (mimo-v2.6-pro, multi-turn tools).
Full suite: PR CI.

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

Request defaults carry no name-keyed effort either: `options()` sends only the
reasoning transport (`reasoningSummary`/encrypted reasoning for Responses-API
SDKs, `includeThoughts` for Google) and never a default effort or thinking level.
The one exception is a thinking on/off switch an endpoint needs before it returns
any reasoning (e.g. Kimi K2.5 over the Anthropic protocol needs `thinking:
enabled`, which the protocol requires to carry a budget); each such switch is
commented as transport.
`smallOptions()` (titles, summaries) uses the model's lowest declared non-off
effort level mapped through the same SDK shape; with no declaration the vendor
default applies (no forced minimal / zero-budget / disabled thinking).

### S2.5 Assistant step classification is driven by the finish reason
- The provider's raw finish reason (`rawFinishReason` from the AI SDK
  `finish-step`) is persisted on the assistant message (optional field in the
  existing JSON payload; no migration).
- `stop` with no client tool calls ends the turn whether it produced text or only
  reasoning; the `think-only` path and the GPT-only exception are removed.
  A step with no text, reasoning or tool call stays `invalid` (retried).
- `other` with no raw reason on a live step means the stream ended without a
  terminal frame: the processor raises an explicit retryable
  `StreamIncompleteError` handled by SessionRetry (stream budget), and it never
  counts as terminal for tool auto-resume or trailing-error swallowing. Max-mode
  drops such candidates; if all are incomplete it falls back to the single
  process path. A raw-less `other` that reaches classification is therefore
  persisted history (pre-upgrade, or a step interrupted before the check) and is
  judged by its content, like `stop`, including with completed tools.
- `other` with a raw reason ends the turn and logs/records the raw reason.
- Anthropic `pause_turn` is not special-cased: the harness sends no Anthropic
  server tools, so it cannot occur, and the continuation request shape is
  unverified. Revisit if server tools are added.
- Consequence: a reasoning-only stop also settles subagents and the
  checkpoint-writer with no text (checkpoint-writer-safety S2.2's think-only
  recovery no longer applies; the writer still ends on CHECKPOINT_COMPLETE per
  its S2.3); writers act through tools, and subagent results
  carry whatever text exists.
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
- [x] T4: Effort levels from models.dev only; shapes by SDK package — acceptance: undeclared reasoning models get no variants; declared levels map to the SDK shape; no name/date level lists remain; options() sends no default effort; smallOptions() uses the lowest declared non-off level (covers: S2.4)
- [x] T5: Finish-reason-driven step classification with persisted raw reason — acceptance: stop+reasoning-only ends the turn for every model; other without raw retries with an explicit error; other with raw ends with the reason recorded; pause_turn continues (covers: S2.5)
- [x] T6: Update tests; typecheck and related suites pass (depends: T1, T2, T3, T4, T5)

## Journey log
- Review found max-mode replay looping forever on a stream-incomplete winner
  (classify returned invalid, dropEmptyAssistant deleted it, repeat). Fixed by
  dropping incomplete candidates in max-mode and judging persisted raw-less
  `other` by content, which also keeps pre-upgrade answers from being deleted on
  resume.
- `pause_turn` continuation was implemented and then removed: no Anthropic server
  tools are sent, and appending a "Continue." user turn after an unresolved
  server tool use is an unverified request shape.
- Probed MiMo's Anthropic-compatible endpoint (mimo-v2.6-pro, multi-turn with a
  tool): thinking is always on, no signatures are returned, and
  `thinking.display` is accepted but ignored, so `display: "summarized"` is kept
  for adaptive thinking (needed on Claude 4.7+, a no-op elsewhere).
