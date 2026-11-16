---
feature: subagent-model-follow
status: delivered
updated: 2026-11-16
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2814
---

# Subagent model follows the main model

## Report

**What was built** — `actor_registry` records the raw explicit `model` of `actor spawn`/`run` in a new nullable `model_ref` column (new migration), read through `ActorRegistry.modelRef`. Child model/variant resolution is one helper in the `actor` tool, used by spawn (unchanged behavior) and by `send`. When `send` targets a finished (`idle`) subagent, the wake model is resolved again — explicit spawn model > agent config > the target session's latest main-slice model — and passed to `Inbox.accept` through its new optional `model`; a running subagent keeps the model it started with. An explicit model that no longer resolves falls back to the subagent's last model instead of failing the send.

**Verification** — `packages/cli bun run typecheck` PASS; `bun test test/actor test/inbox test/storage` PASS 430/0; `bun test test/tool/actor.test.ts test/tool/actor-send.test.ts test/tool/actor-spawn-preference.test.ts` PASS 38/0. Without the `send` override, the three wake tests that expect a new model fail. Full suite left to CI.

## [S1] Problem

A subagent's model is resolved once, when the `actor` tool spawns it: explicit `model` > the agent's configured `modelRef`/`model` > the parent assistant message's model (with variant inheritance, see reasoning-variants S2.3). Running subagents and new spawns already behave as wanted.

A subagent that has finished and is woken again by `actor send` does not. `Inbox.accept` seeds the wake turn's user message from `resolveDrainSeed`, i.e. the subagent's own last message, so after the user switches the main model the woken subagent keeps running on the model it last used. The explicit `model` passed at spawn is not recorded anywhere, so it cannot be told apart from an inherited one.

## [S2] Design

### S2.1 Model rules

| Subagent | Model |
|---|---|
| Running or pending (foreground or background) | The model it was started with. A message sent while it runs keeps that model, even if it is processed after the current run ends. |
| New spawn | Unchanged: explicit `model` > agent config > the spawning parent turn's model. |
| Finished (`idle`) and woken by `actor send` | Resolved again with the same priority: the explicit `model` given at spawn > agent config > the main model of the target session at send time. |
| Agent with its own configured model | Always its configuration. |

"Finished" is decided when `actor send` accepts the message, from the receiver's registry row: `mode === "subagent"` and `status === "idle"`. Peers and `main` are out of scope and keep today's seed.

### S2.2 Shared resolution

One helper in the `actor` tool resolves `{ model, variant }` from the agent info, the explicit model ref (if any) and a parent `{ providerID, modelID, variant }`. Spawn and send both use it:

- Model: explicit ref (via `Provider.resolveModelRef`) > agent `modelRef` / `model` > parent model.
- Variant: an agent with its own `variant` running on its configured model (no explicit ref) uses that variant when the model offers it. Otherwise the parent's variant is kept on the same model, and on a different model only when that model's `variants` contains the key. Spawn behavior is unchanged.

### S2.3 Recording the explicit model

`actor_registry` gains a nullable `model_ref` column holding the raw `model` argument of `actor spawn`/`run` (a group name or `provider/model`). It is stored as given and resolved again on wake, so a changed `model_groups` entry takes effect. It is read through `ActorRegistry.modelRef(sessionID, actorID)` and is not part of the public `Actor` schema. Rows that predate the column read as "no explicit model".

### S2.4 Wake path

In `actor send`, when the receiver is a finished subagent:

1. Parent model = the latest main-slice model of the target session (`resolveDrainSeed(…, "main")`). When the main agent sends during its turn this is that turn's model.
2. Resolve with S2.2 using the receiver's agent and recorded `model_ref`.
3. Pass the result to `Inbox.accept` as the optional `model` of the input. `accept` uses it instead of the receiver's own last model; every other caller is unchanged.

## [S3] Out of Scope

- Peer actors (`session` tool) and cross-session sends to peers.
- Desktop changes (engine-pin bump happens in the desktop repo after this lands).

## Tasks

- [x] T1: record explicit model at spawn — acceptance: `actor spawn --model X` stores `model_ref = X`; spawn without `model` stores NULL; migration adds the column to existing databases (covers: S2.3)
- [x] T2: shared resolver — acceptance: existing spawn model/variant tests stay green (covers: S2.2)
- [x] T3: wake re-resolves — acceptance: after the main user message switches model, `send` to a finished subagent produces a wake user message on the new model and variant; an unsupported variant is dropped; explicit spawn model and agent-configured model are kept; `send` to a running subagent keeps its start model (covers: S2.1, S2.4; depends: T1, T2)
