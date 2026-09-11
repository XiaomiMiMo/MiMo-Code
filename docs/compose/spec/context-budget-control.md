---
feature: context-budget-control
status: in-progress
updated: 2026-08-05
branch: investigate/context-limit-double-rebuild
commits: 028f3178..3b15062d
---

# Context Budget Control (user-adjustable early compaction)

## Report

**What was built** — `compaction.max_context` lets a user compact earlier than the model's own window, expressed as a token count, a `"300K"` / `"1M"` / `"50%"` shorthand, or a map keyed by `"<providerID>/<modelID>"` with wildcards. `Overflow.contextWindow()` is the single place that resolves the provider cap (`limit.input || limit.context`), applies the budget as a clamp, and subtracts the reserves; `usable()` is now a thin wrapper over it, so the compaction trigger, checkpoint thresholds, and pruning all follow the budget without further plumbing. With no budget configured the arithmetic reduces to the previous expression for both model shapes.

The prompt and subagent footers divide usage by the internal trigger and mark a configured budget with `↓`; the sidebar instead shows usage against the user-controlled active limit and compares that setting with the provider cap. `/status` gained a diagnostic Context block (window, budget + source, reserved, compact-at, used), and `mimocode models <provider>` prints the same underlying values without `--verbose`. `/context-limit` opens a preset picker (Model default / 200K / 300K / 500K / 1M / Custom…) that writes only the current model's key into the global config, refusing while a session is busy because a config write disposes the instance and cancels in-flight runners.

The 2026-07-31 follow-up makes `usable()` the only automatic context-switch boundary. Checkpoint thresholds continue to keep the checkpoint fresh, but their final 80%/90% rung no longer triggers an early rebuild. The sidebar presents the user-controlled limit relative to the provider cap, so a 300K budget on a 922K model renders `limit 300K of 922K`; the reserve-adjusted trigger remains an internal detail available in `/status`.

Separately, the merged PR #1926 was corrected: it assigned `limit.context = 300_000` for every `gpt-*` model under Codex OAuth, which *raised* the window for gpt-4o (128K) and gpt-3.5-turbo (16K), broke the `limit.context === 0` sentinel for image models, and never moved the compaction trigger for the 1M-class models it targeted because `usable()` reads `limit.input` when the catalog publishes one. It is now a clamp on both fields at **372,000** — the capacity OpenAI's Codex registry declares and that a 350,317-token request demonstrably reaches — applied only when a window exists and only when `limit.input` already exists. The 272K figure circulating for Codex is the 2x-input billing boundary, not capacity, so it ships as a documented `compaction.max_context` recipe (see S2.5).

**Verification**

- `bun typecheck` (packages/opencode) — PASS, post-rebase.
- `bun typecheck` (packages/opencode) — PASS for the 2026-07-31 follow-up.
- `bun test test/session/auto-overflow-writer-first.test.ts test/session/prune.test.ts test/session/prompt-rebuild-reset.test.ts test/session/overflow.test.ts test/session/checkpoint-thresholds.test.ts test/cli/tui/sidebar-context.test.tsx` — 94 pass / 0 fail for the 2026-07-31 follow-up.
- `bun test test/session/overflow.test.ts test/plugin/codex.test.ts test/session/checkpoint-thresholds.test.ts test/session/prune.test.ts` — 96 pass / 0 fail.
- `bun test test/config test/session/checkpoint-thresholds.test.ts` — 188 pass / 4 skip / 0 fail.
- Full `bun test` before the review fixes — 4359 pass / 4 fail; every failure reproduced at base or passed in isolation (`test/util/ssrf.test.ts` DNS fail-closed fails at base; `test/workflow/runtime.test.ts` has 2 fails at base vs 1 here; `test/session/checkpoint-rebuild-unify.test.ts` passes in isolation in both trees). CI runs the full suite.
- CLI: `MIMOCODE_CONFIG_CONTENT='{"compaction":{"max_context":{"openai/gpt-5*":"300K","openai/gpt-5.6":200000}}}' bun run src/index.ts models openai` → `gpt-5.6` window 922K / budget 200K / compacts at 180K; `gpt-5.6-sol` budget 300K / 280K; `gpt-5.3-codex` (272K cap) shows no budget because 300K clamps away; `gpt-4o` and `o3` unchanged.
- Live TUI (tmux, isolated `MIMOCODE_HOME`, `xiaomi/mimo-v2.5`): picking 300K wrote `"xiaomi/mimo-v2.5": 300000` to the global `mimocode.jsonc`, footer became `33.0K/260K↓ (13%)`, and `/status` showed `window 1.05M · budget 300K · compacts at 260K`. The sidebar follow-up renders the user setting against the model limit (`limit 300K of 1.05M`) and covers it with a TUI render test. Custom `"50%"` wrote 524288 (`compacts at 484K`). "Model default" wrote `0` and restored `compacts at 1.01M`. Selecting a tier mid-stream left the config untouched and kept the dialog open; the same action once idle wrote 200000.

**Journey log**

1. PR #1926's real defect was not "insufficient" but inert: `usable()` prefers `limit.input`, which every 1M-class GPT model publishes (922K), so the 300K assignment only changed the display denominator and the MCP tool budget. Any future provider-cap correction must set `limit.input`, not just `limit.context`.
2. `Instance.dispose()` — which every config write triggers — cancels all runners via the `SessionRunState` scope finalizer. Any TUI feature that persists config mid-session needs a busy guard; `sync.data.session_status` is the server-authoritative signal (message-derived status can stay "working" forever after a crash).
3. Config merges cannot delete keys, and `null` would fail schema validation, so "reset to model default" is expressed as `0`. Writing a single leaf key (not a read-modify-write of the whole map) avoids promoting project-level entries into the user's global file and is safe for both the JSON `mergeDeep` and the JSONC `patchJsonc` writers.
4. SDK regeneration is currently broken on `main`: `bun dev generate` emits a dangling `#/components/schemas/__schema0` ref from `ToolStateCompleted.providerOutput`, so `@hey-api/openapi-ts` fails. Confirmed at base commit; new config fields therefore need a narrow cast at the TUI boundary until that is fixed.
5. `usable()` can be 0 for a positive window (window smaller than the reserves, or a large `compaction.reserved`), which would have rendered `Infinity%` in three footers. Any UI that divides by it needs the guard now in `tui/util/model.contextWindow`.
6. Provider "context window" numbers in the wild are frequently a *billing* tier or a client's conservative default, not capacity — Codex ships 372K capacity, a 95% effective window, a 90% auto-compact default, and a 272K price boundary, all four called "the context window" somewhere. Ask which one a number is before hard-coding it into `limit`.

## [S1] Problem

### S1.1 Three different quantities are conflated into `model.limit.context`

| Quantity | Meaning | Who owns it | Today |
| --- | --- | --- | --- |
| Provider hard cap | max prompt tokens the API will actually accept | provider / auth mode / plan | `limit.context`, sometimes `limit.input` |
| Working budget | where *we* choose to compact (quality / cost / latency) | user | not expressible |
| Display denominator | what the `%` in the TUI is a fraction of | UI | `limit.context` (raw) |

Because there is only one field, any attempt to express (1) or (2) corrupts the other two.

### S1.2 PR #1926 audit — the fix does not fire, and it over-raises other models

`packages/opencode/src/plugin/codex.ts:379` (merged in `94a79289`):

```ts
if (modelID.startsWith("gpt-")) model.limit.context = 300_000
```

Defect 1 — **no effect on the auto-compact trigger for the targeted models.**
`packages/opencode/src/session/overflow.ts:21-23` prefers `limit.input` whenever it is set:

```ts
return input.model.limit.input
  ? Math.max(0, input.model.limit.input - reserved)
  : Math.max(0, context - outputReserve - reserved)
```

models.dev catalog (bundled at build time as `packages/opencode/src/provider/models-snapshot.js`, cached at `~/.cache/mimocode/models.json`) for the openai provider:

| model | context | input | usable() before #1926 | usable() after #1926 |
| --- | --- | --- | --- | --- |
| `gpt-5.6` / `gpt-5.6-sol` / `gpt-5.5` / `gpt-5.4` | 1,050,000 | 922,000 | 902,000 | **902,000 (unchanged)** |
| `gpt-5.3-codex` / `gpt-5.2` / `gpt-5.1` | 400,000 | 272,000 | 252,000 | **252,000 (unchanged)** |
| `gpt-4.1-mini` (no `input`) | 1,047,576 | – | 1,015,576 | 263,616 |
| `gpt-4o` (no `input`) | 128,000 | – | 91,616 | **263,616 (raised above the real cap)** |
| `gpt-3.5-turbo` | 16,385 | – | 0 | **263,616** |
| `gpt-image-1` | 0 | 0 | 0 (guarded) | **300,000 (guard defeated)** |

(`reserved` = `min(20_000, maxOutputTokens)`; `outputReserve` = `min(maxOutputTokens, 20_000)`; `maxOutputTokens` = `min(limit.output, 32_000)`, `packages/opencode/src/provider/transform.ts:1550-1555`.)

So for every 1M-class GPT model — the exact case the PR was filed for — compaction still triggers at ~900K. What *did* change is the display denominator (`prompt/index.tsx:480`, `sidebar/context.tsx:81`, `subagent-footer.tsx:55`) and the MCP tool-catalog budget (`prompt.ts:1359`). Net effect: the footer now reads `900,000 (300%)` while the engine keeps going. The user-visible symptom moved, the behaviour did not.

Defect 2 — **assignment instead of clamp.** `gpt-4o` (128K real) and `gpt-3.5-turbo` (16K real) are *raised* to 300K, guaranteeing provider-side overflow errors that previously could not happen. `gpt-image-*` has `limit.context: 0`, a sentinel that `overflow.ts:15,28,50` uses to disable overflow handling entirely; setting it to 300K defeats that guard.

Defect 3 — **not overridable and not per-plan.** The plugin auth loader runs at `provider.ts:1310-1329`, *after* the config-driven model merge at `provider.ts:1169-1279`. A user on a plan with a different real window cannot restore or lower the value from `mimocode.json`. The value is also a bare literal with no provenance, so nothing can explain it in the UI.

Defect 4 — **wrong layer for the general need.** Even a correct provider-layer clamp only serves "the provider lies about its window". It does not serve "I want to compact at 200K on a 1M model" for cost, latency, cache-churn or answer-quality reasons — a request already filed as issue #1837 ("Context occupancy meter (% + tokens) and adjustable auto-compact threshold"), and adjacent to #1840 (switching to a smaller-window model mid-session).

### S1.3 Checkpoint thresholds apply a second context-limit discount

Checkpoint percentages use `usable()` as their denominator, and the final 80%/90% threshold also signals the prompt loop to rebuild. A configured 300K active limit therefore reports a 280K trigger but rebuilds at 252K, while a configured `"90%"` budget rebuilds at roughly `90% × 90%` of the provider cap. Checkpoint thresholds are snapshot scheduling policy, not a second context limit, so they must not trigger an active-context rebuild.

### S1.4 Existing knobs and why they are insufficient

- `compaction.reserved` (`config.ts:254`) can be abused as an early-compact dial (`reserved = context - target`), but it is global across all models, is also consumed by `compaction.ts:49-54` and `prune.ts:274-292` as a *safety* buffer, and produces a nonsensical number for anyone reading the config.
- `provider.<id>.models.<id>.limit.input` (`config/provider.ts:40-46`) *does* already move the trigger, but it is per-model JSON archaeology, it lies about the provider's real cap, and for the Codex case it is overwritten by the plugin (Defect 3).
- `MIMOCODE_DISABLE_AUTOCOMPACT` is all-or-nothing.

### S1.5 Requirement summary

1. A user-settable working budget, distinct from the provider cap, expressible in common tiers (200K / 300K / 500K / 1M) plus "model default" and a custom value.
2. Never exceeds the provider's effective cap — the setting clamps, it never raises.
3. Discoverable from the TUI without editing JSON, and the resulting number must be printable ("what is my current context window, and where will it compact?").
4. The provider-layer Codex bug fixed correctly and independently of (1)–(3).

### S1.6 A completed high-usage turn is rebuilt twice

`SessionProcessor` marks a successfully completed model turn as `"overflow"` when its reported usage reaches `Overflow.usable()`. The post-process overflow handler rebuilds immediately, but the same completed assistant usage remains visible to later prompt loops. The next user turn can therefore consume that usage again in the preflight overflow check, insert a second checkpoint boundary, re-arm checkpoint thresholds, and run tail microcompaction again.

For a configured 372K budget with the default 20K reserve, the first trigger is 352K (`94.6%` of the configured limit). This is the intended trigger. The defect is processing that one high-water usage record twice, not the trigger percentage.

## [S2] Design — route-independent core

### S2.1 Vocabulary

- `hardCap(model)` = `model.limit.input || model.limit.context` — the largest prompt the API accepts. `0` keeps its current meaning: unknown/not applicable, overflow handling disabled.
- `budget(cfg, model, …)` = user-requested working budget, or `undefined`.
- `effectiveCap` = `hardCap === 0 ? 0 : min(hardCap, budget ?? hardCap)`.
- `usable()` keeps its current meaning: `effectiveCap` minus reserves. It stays the single source of truth for "when do we compact".
- Checkpoint thresholds only schedule checkpoint writers. Crossing the final threshold does not rebuild or compact; `usable()` remains the only automatic context-switch boundary.

### S2.2 `Overflow.usable()` becomes budget-aware

`packages/opencode/src/session/overflow.ts:13-24` is the only place the arithmetic changes:

```ts
export function usable(input: { cfg: Config.Info; model: Provider.Model; budget?: number }) {
  const hard = input.model.limit.input || input.model.limit.context
  if (hard === 0) return 0
  const cap = Math.min(hard, resolveBudget(input) ?? hard)
  const reserved = input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const outputReserve = input.model.limit.input ? 0 : Math.min(ProviderTransform.maxOutputTokens(input.model), OUTPUT_CAP)
  return Math.max(0, cap - outputReserve - reserved)
}
```

Invariants:

- With no budget configured, the returned value is **byte-identical to today** for every model (the `limit.input` branch keeps `outputReserve = 0`; changing that is PR #1265's scope, not ours).
- A budget larger than `hardCap` is silently clamped, never applied upward.
- A budget below `reserved + outputReserve` yields `0`; `isOverflow` then fires on the first turn. Reject such values at the *write* boundary (S2.4) rather than letting the session brick.
- `pressureLevel` / `contextPressureLevel` inherit the new denominator for free, so checkpoint thresholds (`prune.ts:274-292`) and `preserveRecentBudget` (`compaction.ts:49-54`) follow the budget automatically.

New exported helper for callers that need the numbers without the reserves:

```ts
export function window(input: { cfg: Config.Info; model: Provider.Model; budget?: number }): {
  hard: number        // provider cap
  effective: number   // after budget clamp
  usable: number      // compaction trigger
  source: "model" | "config" | "session" | "plugin"
}
```

`source` exists so the UI and CLI can explain *why* the number is what it is (fixes Defect 3's opacity).

### S2.3 Budget resolution order

Highest priority wins; each layer is optional:

1. session override (only if Route C is chosen)
2. `compaction.max_context` keyed by `"<providerID>/<modelID>"`, longest-match glob allowed (`"openai/gpt-5*"`)
3. `compaction.max_context` scalar (all models)
4. none → `hardCap`

### S2.4 Config schema

Added to the existing `compaction` struct (`packages/opencode/src/config/config.ts:239-258`):

```ts
max_context: Schema.optional(
  Schema.Union(TokenBudget, Schema.Record(Schema.String, TokenBudget)),
).annotate({
  description:
    'Compact earlier than the model window. Number of tokens or a string ("300K", "1M", "50%"). ' +
    'Either one value for all models, or a map keyed by "<providerID>/<modelID>" (globs allowed). ' +
    "Always clamped to the model's real window; never raises it.",
})
```

`TokenBudget` = number | string. String parsing reuses the existing grammar of `prune.parseThreshold` (`packages/opencode/src/session/prune.ts:65-80`: `"40%"`, `"100K"`, `"1.5M"`, plain digits) — extract it into a shared helper rather than writing a second parser. `%` is relative to `hardCap`.

Validation at write time (config load warns, slash command refuses): value must leave at least `reserved + outputReserve + 1` tokens, else it is ignored with a `log.warn` naming the model.

### S2.5 Provider-layer fix for Codex (independent of the user-facing knob)

`packages/opencode/src/plugin/codex.ts` becomes a clamp that also closes the `limit.input` hole and respects the sentinel:

```ts
const CODEX_GPT_CONTEXT_CAP = 372_000
if (modelID.startsWith("gpt-") && limit.context > 0) {
  limit.context = Math.min(limit.context, CODEX_GPT_CONTEXT_CAP)
  if (limit.input) limit.input = Math.min(limit.input, CODEX_GPT_CONTEXT_CAP)
}
```

Clamping `limit.input` is what actually moves the trigger; clamping `limit.context` is what makes the display honest. `limit.input` is only touched when the catalog already publishes one — introducing it would switch `usable()` to the input branch and silently drop the output reserve (that would move gpt-4o from 91,616 to 111,616). `gpt-image-*` / `gpt-3.5-turbo` / `gpt-4o` keep their real windows.

The cap value, resolved during implementation (2026-07-27):

- **372,000 = capacity.** OpenAI's Codex model registry declares `context_window = max_context_window = 372000` for the gpt-5.6 variants (openai/codex#31860 quotes the served catalog, which also applies `effective_context_window_percent: 95` and a 90% auto-compact default on top), and a direct Codex request with 350,317 input tokens completes (can1357/oh-my-pi#5705). So 272K is not a hard rejection boundary.
- **272,000 = billing.** Prompts above 272K input are priced at 2x input / 1.5x output for the whole request, and Codex's bundled metadata was lowered from 372000 to 272000 (openai/codex#33972) to keep default sessions inside the cheaper tier — after openai/codex#32486 pointed out the 353.4K effective window ran ~81K past it.

Those are the two quantities S1.1 separates, so the provider layer takes 372K and the 272K line is documented as a `compaction.max_context` recipe rather than baked into the cap. Users on plans with a smaller served catalog window (openai/codex#33069 reports 272K for Pro Lite) can lower it the same way; the clamp form can only reduce, so a stale literal never produces an over-long prompt.

### S2.6 Display / "how do I see my context window"

Three surfaces compute `%` independently against raw `limit.context` today, and none of them matches the trigger. All three switch to `Overflow.contextWindow()`:

| Surface | Today | After |
| --- | --- | --- |
| prompt footer `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:469-486` | `162,000 (15%)` vs raw context | `162.0K/300K (54%)` vs `usable`, with a `↓` marker when a budget is active |
| sidebar context widget `.../feature-plugins/sidebar/context.tsx:67-95` | `% used` vs raw context | `% used` vs active limit + `limit 300K of 922K` when a 300K budget is active on a 922K model |
| subagent footer `.../routes/session/subagent-footer.tsx:54-63` | raw context | usage vs internal `usable` trigger, matching the prompt footer |
| `/status` dialog `.../component/dialog-status.tsx` | no context info at all | new **Context** block: model, provider window, budget + its source, reserved, compact-at, current tokens + `%` |
| CLI | `mimo models openai --verbose` dumps the whole model JSON | add a `context` column to non-verbose output, or a `--context` flag printing `hard / effective / usable` |

The TUI may import `Overflow.window` directly — TUI modules already import from `@/session/*` (`app.tsx:55`, `routes/session/index.tsx:100`) — and it already holds `sync.data.config` plus `sync.data.provider[i].models[id].limit`. No new server route is needed for display.

Note this intentionally changes an existing user-visible number: the footer `%` will read higher than before for models whose reserves are large, because it is now measured against the value that actually triggers compaction. That is the point of the change and must be called out in the PR description.

### S2.7 One recovery per assistant usage record

Every overflow recovery path that successfully frees context in the post-process phase sets `skipOverflowCheck` before continuing the current run loop. Across run loops, a checkpoint or compaction boundary with an ascending message ID newer than the completed assistant marks that usage as already recovered. Boundary timestamps are backdated to the checkpoint watermark, so this comparison uses message IDs rather than timestamps.

The next iteration or user turn may call the model on the rebuilt or compacted context, but must not run checkpoint scheduling, preflight overflow, or exit-time pruning against the same completed assistant usage. This applies to main-agent checkpoint rebuilds and subagent/fork compaction paths. If recovery inserts nothing (`insert-failed`), no marker exists and the usage remains eligible because no context was freed.

The invariant is behavioral, not time-based: no cooldown or percentage margin is introduced. A later assistant turn with newly measured high usage may still trigger its own recovery.

## [S3] Routes — decision required

Storage location for the user's budget. All routes share S2.1–S2.2 and S2.6; they differ in where the value lives and therefore in scope, persistence, and cost.

### Route A — config only (`compaction.max_context`), no UI writer

- Add schema (S2.4) + `usable()` (S2.2) + display (S2.6) + docs. Users hand-edit `mimocode.json`.
- Scope: global or per-model, per project or per user. Persistent. Read by *every* `usable()` call site for free (`cfg` is already an argument at all 6 sites).
- Cost: smallest. No SDK regeneration beyond the generated `Config` type, no migration, no new dialog.
- Gap: does not satisfy the user's "slash option with preset tiers" ask; not discoverable.

### Route B — Route A + `/context-limit` slash command writing global config **(recommended)**

- Picker dialog: `Model default · 200K · 300K · 500K · 1M · Custom…`, applied to the currently selected `providerID/modelID`, written as `compaction.max_context["openai/gpt-5.6"]`.
- Mechanism already proven: `sdk.client.global.config.update({ config: patch })` → `sdk.client.instance.dispose()` → `sync.bootstrap()`, exactly as `component/dialog-model.tsx:318-338` and `dialog-modalities.tsx:72-96` do. Server routes exist (`PATCH /global/config`, `server/routes/global.ts:171-195`).
- Constraint discovered during design: a config write forces `Instance.dispose()`, whose finalizer cancels every runner (`session/run-state.ts:36-51`). The command must therefore be **rejected while the session is busy** (guard on session status) or deferred to idle. This is a hard constraint, not a preference.
- Scope: per-model, persistent across sessions and projects. Matches "设置到模型上".
- Cost: Route A + one dialog + one command registration + a busy guard.

### Route C — per-session override (session column)

- Nullable `max_context` column on `session` (`session/session.sql.ts:14-48`), migration folder `migration/<ts>_session_max_context/migration.sql` (`ALTER TABLE session ADD max_context integer;`), touch `fromRow` / `toRow` / `toPartialRow` (`session.ts:64-112`, `projectors.ts:37-63`), `Session.setMaxContext` next to `setTitle` (`session.ts:681-720`), extend the `session.update` body allow-list (`server/routes/instance/session.ts:378-389`), regenerate the SDK (`./packages/sdk/js/script/build.ts`).
- Requires threading `sessionID` (or the resolved budget) into the 6 `usable()` call sites: `processor.ts:638`, `prune.ts:274`, `prune.ts:371`, `compaction.ts:53`, `prompt.ts:1334`, `prompt.ts:1346`, `prompt.ts:3203`. All of them have `sessionID` in scope.
- Writes are safe mid-turn (`patch()` is a `SyncEvent.run`, no dispose) and propagate to the TUI automatically via `session.updated` (`sync/index.ts:215-249`, `server/projectors.ts:11-24`, `tui/context/sync.tsx:439-452`).
- Scope: per session, survives resume. This is what issue #1837's acceptance criteria literally ask for ("per-session and restored on resume", "does not rewrite global config unless save as default").
- Cost: highest — migration + SDK regen + signature churn across 7 call sites.

### Route D — provider-layer fix only (S2.5)

- Fixes the Codex bug correctly. Ships no user-facing knob. Should be done **regardless of A/B/C** because it is a correctness regression fix, and it is independently testable.

### Decision (2026-07-27, user)

**Route D + B**, with A as the substrate. Budget is keyed **per model** — `compaction.max_context["<providerID>/<modelID>"]`; a scalar form stays accepted by the schema but `/context-limit` always writes the keyed form. Route C is deferred (see S4).

### Recommendation

**D + B**, with A as the substrate: D closes the shipped regression, A gives the durable expressible policy that every call site already reads, B makes it discoverable with the preset tiers requested. Defer C until per-session divergence is actually demanded — the per-model config value already covers "I always want 300K on this model", and C's cost is dominated by plumbing rather than by design risk. If C is chosen later it layers on top of A without changing A's semantics (it is priority 1 in S2.3).

Rejected alternatives:

- Overload `provider.*.models.*.limit.context` as the user knob (what #1926 does at plugin level): destroys the distinction in S1.1, lies to the provider-cap consumers (`acp/agent.ts:76`, `prompt.ts:1359`), and cannot express "compact early" without also mis-reporting the model.
- Overload `compaction.reserved`: global-only, and collides with its safety-buffer role in `compaction.ts` and `prune.ts`.
- TUI KV / `model.json` as the store: the TUI runs in a separate realm from the session engine (Worker + HTTP-shaped transport, `tui/thread.ts:270-335`, `tui/worker.ts:50-68`), so server code cannot read it in memory, and it would not apply to `mimo run` / `serve` / ACP clients.
- Per-request `PromptInput.maxContext`: not sticky across compaction continuations, retries, or `LoopInput` wakes (`prompt.ts:4460`), and needs threading into `Processor` anyway.

## [S4] Out of scope

- Per-session budget override (Route C) — deferred by the 2026-07-27 decision; layers on top of S2.3 priority 1 when demanded.
- Multi-pass compaction when history already exceeds the target window (issue #1840). A budget makes that state *rarer*, it does not resolve it.
- Changing the `limit.input` output-reserve semantics (open PR #1265).
- Lowering `DEFAULT_CONTEXT_WINDOW` (`provider.ts:35`), repeatedly proposed and closed (#1863, #648, #626).
- A live slider / drag UI. Preset tiers plus custom entry only.
- Per-agent or per-subagent budgets.
- Automatic budget inference from observed provider overflow errors.

## Tasks

Route D (do first, independent):

- [x] T1: Replace the assignment in `plugin/codex.ts` with a clamp, including `limit.input` and the `limit.context === 0` guard — acceptance: `bun test test/plugin/codex.test.ts` asserts `gpt-5.6-sol` → `{context: 372K, input: 372K}`, `gpt-5.3-codex` → `{context: 372K, input: 272K}`, `gpt-4o` → `{context: 128K}` unchanged and no `input` introduced, `gpt-image-1` → `{context: 0}` unchanged, `o3` → `{context: 200K}` unchanged (covers: S2.5)
- [x] T2: Confirm the real Codex prompt cap and either keep the literal or make it plan-derived — acceptance: the chosen value is documented in a code comment with its source (covers: S2.5; depends: T1). Resolved to **372,000** with sources in the comment: OpenAI's Codex model registry declares `context_window = max_context_window = 372000` for the gpt-5.6 variants (openai/codex#31860 quotes the served catalog), and a direct Codex request with 350,317 input tokens completes (can1357/oh-my-pi#5705). The 272,000 figure that Codex's bundled metadata was lowered to (openai/codex#33972) is the >272K 2x-input / 1.5x-output billing boundary, i.e. a spending policy — documented as a `compaction.max_context` recipe instead of baked into the cap.

Route A (substrate):

- [x] T3: Extract the threshold grammar from `prune.ts` into `Token.parseQuantity` and unit-test `"300K"` / `"1.5M"` / `"50%"` / plain number / invalid input — acceptance: `bun test` covers all five, `prune.ts` behaviour and error messages unchanged (covers: S2.4)
- [x] T4: Add `compaction.max_context` to the config schema with scalar + keyed-map forms and a validation warning — acceptance: a config with `{"compaction":{"max_context":{"openai/gpt-5*":"300K"}}}` type-checks and parses; a value below the reserves logs a warning and is ignored (covers: S2.3, S2.4; depends: T3). The warning fires on first use rather than at load, so it names the model it applies to.
- [x] T5: Make `Overflow.usable()` budget-aware and add `Overflow.contextWindow()` per S2.2 — acceptance: unit tests show (a) no budget → identical numbers to `main` for a `limit.input` model and a context-only model, (b) budget above the cap is clamped, (c) budget `300K` on a 1.05M/922K model yields `usable = 280K` and `isOverflow` fires there (covers: S2.2; depends: T4)
- [x] T6: Document `compaction.max_context` wherever `compaction.*` is documented — acceptance: the doc states the clamp rule and the `"<providerID>/<modelID>"` key form (covers: S2.4; depends: T4)

Route B (UI writer):

- [x] T7: Add `/context-limit` command + preset picker dialog writing `compaction.max_context["<provider>/<model>"]` via `global.config.update` → `instance.dispose()` → `sync.bootstrap()` — acceptance: selecting `300K` on a 1M model persists to the global config, the footer denominator updates without restart, and `Model default` resets the model (covers: S3 Route B; depends: T5). Reset writes `0` instead of deleting the key — a config merge cannot delete.
- [x] T8: Refuse the write while a session is busy, with an explanatory toast — acceptance: invoking the command mid-turn leaves the config untouched; the same action once idle writes (covers: S3 Route B; depends: T7)

Display (needed by any route):

- [x] T9: Switch the prompt footer, sidebar context widget, and subagent footer to `Overflow.contextWindow()` — acceptance: prompt/subagent usage uses the internal trigger, while sidebar usage uses the active setting and compares it with the provider cap (covers: S2.6; depends: T5)
- [x] T10: Add a Context block to the `/status` dialog showing provider window, budget + source, reserved, compact-at, current tokens and `%` — acceptance: with and without a configured budget the block renders correct numbers and the correct `source` label (covers: S2.6; depends: T5)
- [x] T11: Surface the context window in the `models` CLI command without `--verbose` — acceptance: `mimocode models openai` prints each model's provider window and compact-at (covers: S2.6; depends: T5)
- [x] T12: Decouple the final checkpoint threshold from the prompt-loop rebuild condition — acceptance: crossing the final checkpoint threshold below `usable()` writes a checkpoint but inserts no rebuild or compaction boundary; reaching `usable()` still follows the existing rebuild path (covers: S1.3, S2.1; depends: T5)
- [x] T13: Show the configured active limit relative to the provider hard cap in the sidebar — acceptance: a 300K budget on a 922K model renders `limit 300K of 922K`, while the reserve-adjusted trigger remains internal and available in `/status` (covers: S2.6; depends: T5)
- [x] T14: Consume each assistant usage at most once during overflow recovery — acceptance: post-process recovery sets the current-loop skip guard; across user turns, a newer boundary prevents the recovered assistant from driving checkpoint scheduling, preflight overflow, or exit-time pruning; equivalent subagent/fork recovery paths set the same guard (covers: S1.6, S2.7; depends: T12)
- [x] T15: Add regression coverage for duplicate recovery — acceptance: a low-usage initialization turn, a successful high-usage turn, and a following user turn produce two distinct checkpoint boundaries on current `main`, but exactly one boundary and one writer after T14; existing preflight and provider-overflow fallback tests remain green (covers: S1.6, S2.7; depends: T14)
