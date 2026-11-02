---
feature: reasoning-variants
status: delivered
updated: 2026-11-02
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2768
---

# Reasoning Variants

## Report

**What was built** — models.dev `reasoning_options` are parsed into `capabilities.efforts` / `capabilities.reasoningBudget` (`"default"`/`null` effort values are not levels). Declared effort levels drive `ProviderTransform.variants()`: always-on and toggle-only models get no levels, declared levels are offered exactly (adapter table when it covers all of them, otherwise the adapter-standard shape; budget-controlled Anthropic models pair `effort` with budgeted thinking; legacy Claude ≤4.5 and Anthropic `none`/`minimal` never get adaptive and keep only built-in budget levels), budget-only models keep the built-in fixed-budget levels, and undeclared models are unchanged. `ProviderTransform.configuredVariants` merges config `variants` for both models.dev-backed and config-only models and fills levels that config only names with the adapter-standard parameters (dropping those it cannot express), so clients write level names, never protocol parameters. The `actor` tool passes the parent turn's variant to the child (same model, or a different model offering that level), unless the child agent runs its own configured variant on its configured model; `Actor.spawn` forwards it to the child prompt.

**Verification** — `packages/cli bun run typecheck` PASS; `packages/sdk bun run typecheck` PASS; `bun test test/provider` PASS 649/0; `bun test test/actor` PASS 274/0; `bun test test/tool/actor*.test.ts` PASS 69/0; `bun test test/session/prompt.test.ts test/session/boundary.test.ts test/session/prompt-effect.test.ts` PASS 214/0. New tests were confirmed red before each change. Full suite left to CI. Independent reviews: spec compliance met; Anthropic shape, strict-parse, budget-only, legacy-Claude adaptive and config-only-level findings fixed.

## [S1] Problem

1. The models.dev schema drops `reasoning_options`, so `ProviderTransform.variants()` derives effort levels purely from model-name rules. A model that models.dev declares as toggle-only (e.g. `xiaomi-token-plan-cn/mimo-v2.6-flash`, `reasoning_options: [{type: "toggle"}]`) still gets the generic openai-compatible `low/medium/high`, and selecting one sends `reasoning_effort` the model does not support. Conversely, declared levels the name table does not know (e.g. `xhigh`/`max` on openai-compatible, models excluded by name such as kimi/qwen/glm) are never offered.
2. A subagent spawned through the `actor` tool inherits only the parent's `providerID/modelID`. The parent's `variant` is dropped, so the child request carries no effort parameter regardless of what the user selected for the main conversation.
3. A config `variants` level must carry its full protocol parameters to do anything. Clients that let users pick levels (the desktop app) had to duplicate the per-adapter parameter table, and got it wrong where the engine knows better (adaptive thinking for legacy Claude, adaptive merged over the engine's budgeted params). A level named with empty params silently sends nothing.

## [S2] Design

### S2.1 Carry declared effort levels from models.dev

- `ModelsDev.Model` accepts optional `reasoning_options: Array<{ type: string; values?: unknown[] }>`; unknown option types and non-string values are tolerated (a strict shape would reject the whole catalog), and only string `effort` values are used.
- models.dev semantics (its schema and contributor policy): `reasoning_options` lists the caller controls a host exposes — `toggle` (same model ID on/off via a request field), `effort` (graded levels, low to high), `budget_tokens` (a real reasoning-token budget field); they combine freely (e.g. DeepSeek V4 = toggle + `low/high/max`). An empty array means always-on reasoning with no caller control. Every `reasoning: true` model carries the field.
- `Provider.Model.capabilities` gains optional `efforts?: string[]`:
  - `undefined` — no models.dev declaration (config-only models); legacy behavior.
  - `[]` — declared without effort levels: always-on (`[]`), toggle-only, budget-only, or toggle + budget.
  - non-empty — the union of `values` across `effort` options, in declaration order, de-duplicated. `"default"` (and `null`) mean "the provider's own default", i.e. send no variant, so they are not levels; `none` is kept.
- `capabilities.reasoningBudget?: boolean` records whether a `budget_tokens` option is also declared (set alongside `efforts`).
- `fromModelsDevModel` fills it; config-declared models that extend a models.dev model inherit it from the existing model. Config-only models have no declaration.

### S2.2 Declared levels drive `variants()`

When `capabilities.reasoning` is true and `capabilities.efforts` is defined:

- The result has exactly the declared levels.
- Parameters come from the adapter's built-in table (computed without model-family exclusions, so kimi/qwen/glm/deepseek-on-other-providers… are not dropped) when that table covers every declared level; otherwise the whole set uses the adapter-standard shape, so one model never mixes shapes (e.g. Anthropic budget `enabled` for high/max but `adaptive` for the rest). Adapter-standard shapes: openai-compatible / gateway / deepinfra / venice → `{ reasoningEffort }`; `@ai-sdk/openai` / `@ai-sdk/azure` → `{ reasoningEffort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }`; `@ai-sdk/anthropic` / `@ai-sdk/google-vertex/anthropic` → `{ thinking: { type: "adaptive" }, effort }`, or `{ thinking: { type: "enabled", budgetTokens }, effort }` when `reasoningBudget` is true; Anthropic has no standard shape for `none`/`minimal` or for legacy Claude (3.x and 4.0–4.5, a closed set that predates adaptive thinking), so those keep only the built-in fixed-budget levels — legacy models stay usable without effort support; `@openrouter/ai-sdk-provider` → `{ reasoning: { effort } }`. Adapters with no standard shape keep only levels the built-in table provides; levels neither source can express are dropped.
- `efforts: []` with no budget control (always-on or toggle-only) yields `{}`. `efforts: []` with `reasoningBudget` (budget-only, or toggle + budget) keeps the built-in table, so fixed-budget levels such as Anthropic `high`/`max` stay available.
- When `efforts` is undefined, behavior is unchanged.
- This stays the only variant mechanism. Every client (TUI `/variant` and its cycle keybind, `run --variant`, ACP model ids, the desktop app) lists the keys of `model.variants` from the provider registry and sends just the key as the prompt `variant`; `llm.ts` merges `model.variants[key]`. No client-specific parameter path is added.

### S2.4 Config `variants` name levels; the engine owns their parameters

`ProviderTransform.configuredVariants(model, config)` produces `model.variants` for both models.dev-backed and config-only models:

- Config `variants` deep-merge over `variants(model)`; `disabled` levels are removed.
- A level left with no parameters (config only names it, e.g. `{ high: {} }`) gets the adapter-standard shape from S2.2. If there is none (unknown adapter, Anthropic `none`, legacy Claude), the level is dropped, so every listed level changes the request.
- Hand-written parameters are kept as written; a level the engine already defines keeps the engine's parameters unless config overrides them.
- Clients that manage levels for the user (the desktop app) therefore write only level names and `disabled`, never protocol parameters.

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

- [x] T1: models.dev `reasoning_options` parsed into `capabilities.efforts` — acceptance: toggle-only and always-on (`[]`) models → `[]`, effort model → declared values without `"default"`/`null`, undeclared → undefined; config model extending a models.dev model keeps it (covers: S2.1)
- [x] T2: `variants()` honors declared efforts — acceptance: toggle-only openai-compatible model has no variants; declared `low…max` openai-compatible model gets all five with `reasoningEffort`; Anthropic declared levels keep built-in adaptive params; legacy Claude declaring effort gets only built-in budget levels; Anthropic `none`/`minimal` dropped; name-excluded family with declaration gets levels; undeclared models unchanged (covers: S2.2; depends: T1)
- [x] T3: actor spawn passes inherited variant — acceptance: same-model child user message records parent variant; different model with/without the key; agent-configured variant still wins (covers: S2.3)
- [x] T4: config `variants` that only name a level — acceptance: config-only openai-compatible / `@ai-sdk/openai` / Anthropic models get the adapter-standard params; legacy Claude and Anthropic `none` are dropped; hand-written params kept; a level the engine defines keeps the engine's params; `disabled` removed (covers: S2.4; depends: T2)

## Journey log

- Gating Anthropic's fallback on the name-based adaptive list would have dropped levels for 5.x models; the closed legacy set (≤4.5) is gated instead, since new names keep appearing but old ones do not. models.dev's `budget_tokens` is not a reliable adaptive signal on relays (e.g. zenmux declares effort without budget for Claude 4.1/4.5).
- `efforts: []` initially collapsed toggle-only and budget-only declarations; budget-only must keep the built-in fixed-budget levels.
- Checked against models.dev's schema and live api.json: `[]` is the always-on case (1135 reasoning models), not only toggle/budget; Groq Qwen declares effort `"default"`, which as a level would collide with the TUI/ACP `"default"` = unset sentinel.
