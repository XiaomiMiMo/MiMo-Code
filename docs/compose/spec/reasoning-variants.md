---
feature: reasoning-variants
status: in-progress
updated: 2026-11-02
source: feat/reasoning-variants
---

# Reasoning Variants

## Report

## [S1] Problem

1. The models.dev schema drops `reasoning_options`, so `ProviderTransform.variants()` derives effort levels purely from model-name rules. A model that models.dev declares as toggle-only (e.g. `xiaomi-token-plan-cn/mimo-v2.6-flash`, `reasoning_options: [{type: "toggle"}]`) still gets the generic openai-compatible `low/medium/high`, and selecting one sends `reasoning_effort` the model does not support. Conversely, declared levels the name table does not know (e.g. `xhigh`/`max` on openai-compatible, models excluded by name such as kimi/qwen/glm) are never offered.
2. A subagent spawned through the `actor` tool inherits only the parent's `providerID/modelID`. The parent's `variant` is dropped, so the child request carries no effort parameter regardless of what the user selected for the main conversation.

## [S2] Design

### S2.1 Carry declared effort levels from models.dev

- `ModelsDev.Model` accepts optional `reasoning_options: Array<{ type: string; values?: unknown[] }>`; unknown option types and non-string values are tolerated (a strict shape would reject the whole catalog), and only string `effort` values are used.
- `Provider.Model.capabilities` gains optional `efforts?: string[]`:
  - `undefined` — models.dev made no declaration (no `reasoning_options`); legacy behavior.
  - `[]` — declared, but no `effort` option (toggle-only / budget-only).
  - non-empty — the union of `values` across `effort` options, in declaration order, de-duplicated.
- `capabilities.reasoningBudget?: boolean` records whether a `budget_tokens` option is also declared (set alongside `efforts`).
- `fromModelsDevModel` fills it; config-declared models that extend a models.dev model inherit it from the existing model. Config-only models have no declaration.

### S2.2 Declared levels drive `variants()`

When `capabilities.reasoning` is true and `capabilities.efforts` is defined:

- The result has exactly the declared levels.
- Parameters come from the adapter's built-in table (computed without model-family exclusions, so kimi/qwen/glm/deepseek-on-other-providers… are not dropped) when that table covers every declared level; otherwise the whole set uses the adapter-standard shape, so one model never mixes shapes (e.g. Anthropic budget `enabled` for high/max but `adaptive` for the rest). Adapter-standard shapes: openai-compatible / gateway / deepinfra / venice → `{ reasoningEffort }`; `@ai-sdk/openai` / `@ai-sdk/azure` → `{ reasoningEffort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }`; `@ai-sdk/anthropic` / `@ai-sdk/google-vertex/anthropic` → `{ thinking: { type: "adaptive" }, effort }`, or `{ thinking: { type: "enabled", budgetTokens }, effort }` when `reasoningBudget` is true (budget-controlled models such as Opus 4.5 accept `effort` but not adaptive thinking); `@openrouter/ai-sdk-provider` → `{ reasoning: { effort } }`. Adapters with no standard shape keep only levels the built-in table provides; levels neither source can express are dropped.
- `efforts: []` with no budget control (toggle-only) yields `{}`. `efforts: []` with `reasoningBudget` (budget-only) keeps the built-in table, so fixed-budget levels such as Anthropic `high`/`max` stay available.
- When `efforts` is undefined, behavior is unchanged.
- Config `variants` are still merged on top afterwards (and `disabled` honored), so user configuration keeps final say.

### S2.3 Subagents inherit the parent's variant

In the `actor` tool, after the child model is resolved:

- If the child agent has its own configured `variant` and runs on its configured model (no explicit `--model`), do not pass anything — the agent's variant applies as today. An explicit `--model` always counts as an override, even when it names the agent's own model.
- Otherwise, take the parent assistant message's `variant`. Pass it when the child model is the parent model; when the child model differs, pass it only if the child model's `variants` contains that key.
- The value flows `actor.spawn` → child prompt `variant`, so the child's user message records it and `llm.ts` merges the matching variant.

## [S3] Out of Scope

- Desktop changes (engine-pin bump happens in the desktop repo after this lands).
- Changing `capabilities.reasoning` defaults for config-only models.
- Effort declarations in user config other than existing `variants`.

## Tasks

- [ ] T1: models.dev `reasoning_options` parsed into `capabilities.efforts` — acceptance: toggle-only model → `[]`, effort model → declared values, undeclared → undefined; config model extending a models.dev model keeps it (covers: S2.1)
- [ ] T2: `variants()` honors declared efforts — acceptance: toggle-only openai-compatible model has no variants; declared `low…max` openai-compatible model gets all five with `reasoningEffort`; Anthropic declared levels keep built-in adaptive params; name-excluded family with declaration gets levels; undeclared models unchanged; config `variants`/`disabled` still apply (covers: S2.2; depends: T1)
- [ ] T3: actor spawn passes inherited variant — acceptance: same-model child user message records parent variant; different model with/without the key; agent-configured variant still wins (covers: S2.3)

## Journey log
