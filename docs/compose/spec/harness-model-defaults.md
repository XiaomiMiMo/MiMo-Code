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

### S2.4 Reasoning effort levels (pending design discussion)
Effort levels come only from models.dev `reasoning_options` (or user config);
name-keyed level tables are removed. Per-SDK wire shapes stay. Open point: some
shapes depend on the model family behind an aggregator (Bedrock, Copilot,
gateway); resolved before implementation.

### S2.5 Assistant step classification (pending design discussion)
Remove the GPT-only reasoning-only exception and the heuristic handling of
finish `other`; exact rule decided after the finish-reason investigation.

### S2.6 Kept
`store: false` and `include: ["reasoning.encrypted_content"]` for OpenAI
Responses, per-SDK parameter shapes, OpenAI OAuth / Copilot omission of
`maxOutputTokens`.

## [S3] Out of Scope
- Prompt or toolset changes (done in unify-default-harness).
- Transport compatibility shims (tool-call id scrubbing, schema fixups, cache
  markers, attachment packaging).

## Tasks
- [ ] T1: Output limit from model, 128_000 fallback, remove name heuristic and 32K cap — acceptance: maxOutputTokens equals limit.output for any model; undeclared output resolves to 128_000 (covers: S2.1)
- [ ] T2: Remove per-model sampling defaults — acceptance: no temperature/topP/topK sent unless configured (covers: S2.2)
- [ ] T3: Remove default textVerbosity — acceptance: gpt-5.x options carry no textVerbosity (covers: S2.3)
- [ ] T4: Effort levels from models.dev only (covers: S2.4)
- [ ] T5: Explicit step classification (covers: S2.5)
- [ ] T6: Update tests; typecheck and related suites pass (depends: T1, T2, T3)

## Journey log
None
