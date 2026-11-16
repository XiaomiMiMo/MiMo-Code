---
feature: subagent-model-follow
status: delivered
updated: 2026-11-16
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2814
---

# Subagent model follows the main model

## Report

**What was built** — `actor_registry` records the explicit `model` of `actor spawn`/`run`, resolved to `provider/model`, in a new nullable `model_ref` column (new migration), read through `ActorRegistry.modelRef`. Child model/variant resolution is one helper in the `actor` tool, used by spawn (unchanged behavior) and by `send`. When `send` targets a finished (`idle`) subagent, a wake model is resolved — explicit spawn model > agent config > the latest model of its parent lane (`parentActorID`, default main) — and handed to `Inbox.accept` as `idleModel`; the inbox controller applies it only if the receiver is still idle inside the admission transaction, so a running subagent keeps the model it started with. An explicit model that no longer resolves falls back to the subagent's last model instead of failing the send; interrupts are not swallowed.

**Verification** — `packages/cli bun run typecheck` PASS; `bun test test/actor test/inbox test/storage test/tool/actor.test.ts test/tool/actor-send.test.ts test/tool/actor-spawn-preference.test.ts test/session/bootstrap-skip-system.test.ts` PASS 472/0. Without the `send` override the wake tests expecting a new model fail; resolving the parent from `main` fails the parent-lane test; dropping the admission-time idle check fails the admission test. Full suite left to CI.

## [S1] Problem

A subagent's model is resolved once, when the `actor` tool spawns it: explicit `model` > the agent's configured `modelRef`/`model` > the parent assistant message's model (with variant inheritance, see reasoning-variants S2.3). Running subagents and new spawns already behave as wanted.

A subagent that has finished and is woken again by `actor send` does not. `Inbox.accept` seeds the wake turn's user message from `resolveDrainSeed`, i.e. the subagent's own last message, so after the user switches the main model the woken subagent keeps running on the model it last used. The explicit `model` passed at spawn is not recorded anywhere, so it cannot be told apart from an inherited one.

## [S2] Design

### S2.1 Model rules

| Subagent | Model |
|---|---|
| Running or pending (foreground or background) | The model it was started with. A message sent while it runs keeps that model, even if it is processed after the current run ends. |
| New spawn | Unchanged: explicit `model` > agent config > the spawning parent turn's model. |
| Finished (`idle`) and woken by `actor send` | Resolved again with the same priority: the explicit `model` given at spawn > agent config > the current model of its parent lane in the target session. |
| Agent with its own configured model | Always its configuration. |

"Finished" means the receiver's registry row has `mode === "subagent"` and `status === "idle"` at the moment its inbox admission is written (S2.4). Peers and `main` are out of scope and keep today's seed.

The parent lane is the actor that receives the subagent's completion notification: `parentActorID`, or `main` when unset (`actor/notification.ts`). Model-facing `actor spawn` runs only on primary lanes and leaves `parentActorID` unset, so its subagents follow the main lane — the same lane whose turn they were spawned from. Actors registered with a `parentActorID` (e.g. by the workflow runtime) follow that actor's lane; when that actor is itself idle, its last model is used.

### S2.2 Shared resolution

One helper in the `actor` tool resolves `{ model, variant }` from the agent info, the explicit model ref (if any) and a parent `{ providerID, modelID, variant }`. Spawn and send both use it:

- Model: explicit ref (via `Provider.resolveModelRef`) > agent `modelRef` / `model` > parent model.
- Variant: an agent with its own `variant` running on its configured model (no explicit ref) uses that variant when the model offers it. Otherwise the parent's variant is kept on the same model, and on a different model only when that model's `variants` contains the key. Spawn behavior is unchanged.

### S2.3 Recording the explicit model

`actor_registry` gains a nullable `model_ref` column holding the explicit `model` of `actor spawn`/`run` as the `provider/model` it resolved to at spawn. A group name or bare model name resolves against the spawning turn's provider; storing the resolved model keeps the wake on the same model instead of resolving again against whatever provider the parent lane uses later. It is read through `ActorRegistry.modelRef(sessionID, actorID)` and is not part of the public `Actor` schema. Rows that predate the column read as "no explicit model".

### S2.4 Wake path

In `actor send`, when the receiver is a finished subagent:

1. Parent model = the latest model of the parent lane in the target session (`resolveDrainSeed(…, parentActorID ?? "main")`). When the main agent sends during its turn this is that turn's model. `to_session_id` resolves in the target session.
2. Resolve with S2.2 using the receiver's agent and recorded `model_ref`. Resolution failures and defects fall back to no override; interrupts propagate.
3. Pass the result to `Inbox.accept` as `idleModel`. The inbox controller reads the receiver's registry status in the same transaction that writes the wake message and uses `idleModel` only when it is `idle`; otherwise the message keeps the receiver's own last model. The `actor` tool checks `idle` first only to skip needless resolution.

## [S3] Out of Scope

- Peer actors (`session` tool) and cross-session sends to peers.
- Desktop changes (engine-pin bump happens in the desktop repo after this lands).

## Tasks

- [x] T1: record explicit model at spawn — acceptance: `actor spawn --model X` stores the resolved `provider/model` (a group name is stored as the model it resolved to); spawn without `model` stores NULL; migration adds the column to existing databases (covers: S2.3)
- [x] T2: shared resolver — acceptance: existing spawn model/variant tests stay green (covers: S2.2)
- [x] T3: wake re-resolves — acceptance: after the main user message switches model, `send` to a finished subagent produces a wake user message on the new model and variant; an unsupported variant is dropped; explicit spawn model, agent-configured model and an agent's own variant are kept; a subagent with a `parentActorID` follows that lane; a `to_session_id` wake follows the target session; `send` to a running subagent keeps its start model, and the inbox does not apply a wake model to a receiver that is running at admission (covers: S2.1, S2.4; depends: T1, T2)

## Journey log

- Review of the first version: the wake parent was always `main`, while spawn uses the spawning turn — parent lane now follows `parentActorID`, the notification receiver. A raw `model_ref` resolved against the wake-time provider could land on another provider — stored resolved instead. `catchCause` also swallowed interrupts. The idle check ran before admission, leaving a window — moved into the admission transaction.
