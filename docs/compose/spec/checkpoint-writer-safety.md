---
feature: checkpoint-writer-safety
status: in-progress
updated: 2026-10-23
source: fix/checkpoint-writer-loop-bound
---

# Checkpoint Writer Safety

## Report

**What was built** - The checkpoint writer is now confined to normal paths under the memory tree at the unified write gate; the existing precise memory allowlist remains authoritative inside that tree. Dream/distill retain their prior memory-or-`.mimocode/` behavior, while ordinary agents retain normal source writes. The gate now obtains its worktree from `InstanceState.context`, so InstanceRef-bound actor fibers cannot skip the sandbox.

Invalid-output recovery now selects an explicit role policy. Primary turns keep the user-facing reminder, ordinary actors receive a parent-facing reminder, and checkpoint writers receive a scoped recovery instruction that either finishes authorized memory edits or returns `CHECKPOINT_COMPLETE`. System-agent policy coverage is exhaustive. Terminal assistant errors now fail actor outcomes, so exhausted checkpoint recovery leaves the watermark unchanged through the existing transactional settlement path.

**Verification** - From `packages/cli`, `bun test test/tool/memory-path-guard.test.ts test/tool/apply_patch.test.ts test/agent/ask-routing.test.ts test/session/invalid-output-continuation.test.ts test/actor/spawn.test.ts test/session/checkpoint-watermark-transactional.test.ts test/session/checkpoint-child-session.test.ts test/session/checkpoint-permission.test.ts` passed 151 tests with 286 assertions and 0 failures. `bun typecheck` passed. `git diff --check` passed. Targeted oxlint reported 0 errors; remaining warnings were existing large-file/test idioms. Independent final review approved spec compliance, correctness, and codebase consistency with no remaining findings.

**Journey log**

- The incident was one writer reactivated by the generic user-facing empty-output reminder, not duplicate checkpoint-writer spawns.
- The unified memory guard was precise only after a path entered the memory tree; a separate checkpoint-writer memory-only sandbox was required for source paths.
- `SessionPrompt.prompt` could return a terminal assistant error that Actor previously converted to success; propagating that error restores watermark transactionality.
- A combined AppRuntime watermark E2E was process-state dependent, so stable boundary tests cover checkpoint exhaustion → actor failure and writer failure → unchanged watermark separately.
- Symlink/hardlink topology inside the application-managed memory tree is explicitly user-owned and outside this lexical path-boundary threat model.

## [S1] Problem

The checkpoint writer is a system-spawned actor whose successful work is expressed through memory-file edits followed by an intentionally empty stop. The generic invalid-output continuation treats that empty stop as a missing user-facing answer and injects a prompt telling the writer to answer the user or call another tool. Because the writer receives full parent context, that retry can make it resume the parent's development task instead of terminating.

The writer also receives general file-editing tools. Those tools call the unified write gate, but the current system-agent sandbox covers only `dream` and `distill`. The memory-specific guard precisely restricts checkpoint-writer paths only after a target is recognized as part of the memory tree; it permits non-memory targets to pass through. A drifted checkpoint writer can therefore edit source files with `write`, `edit`, or `apply_patch`.

The observed incident used both gaps: a generic empty-output retry reactivated a completed checkpoint writer, and the missing hard path boundary allowed it to patch project source. Prompt instructions and tool allowlists alone are insufficient because either can drift or be widened later.

A later incident showed that empty-output recovery itself had no bound for background writers. Writers in one process each ran more than a thousand steps: a step whose only tool call was rejected ended with `finish=stop` and no text, `dropEmptyAssistant` removed it and started an identical step, and nothing counted the drops. Every step re-sent a context of about 10 MB, the provider answered 429, and the `stream error` log serialized the whole request body on each failure, so CPU and log volume stayed high indefinitely. Separately, a writer that completed its edits and stopped with no text, as its prompt asked, was retried under the persistent empty-output budget with no end.

## [S2] Design

### [S2.1] Checkpoint Writer Write Boundary

The unified write gate must enforce a checkpoint-writer-specific sandbox before applying the existing precise memory allowlist:

- `checkpoint-writer` may target only files under the resolved memory root.
- Within the memory root, `assertMemoryWriteAllowed` remains authoritative for canonical `MEMORY.md`, `checkpoint.md`, `notes.md`, permitted spillovers, and permitted task narratives.
- `checkpoint-writer` must not write project source, repository configuration, any worktree path, or `.mimocode/`.
- `dream` and `distill` retain their existing memory-root or worktree `.mimocode/` sandbox.
- Primary and ordinary agents retain their existing source-write behavior.
- Every file-mutating tool that uses `assertWriteAllowed`, including `write`, `edit`, `apply_patch`, and `notebook_edit`, receives the same boundary. `apply_patch` must enforce it for add, update, delete, and both sides of move operations.

Removing `apply_patch` from the checkpoint writer's tool whitelist is not a substitute for this boundary.

### [S2.2] Invalid-Output Recovery

An empty or think-only step never injects a reminder message; recovery resends the same history. Two paths exist, chosen by whether the step can be replayed:

- A replayable step (`retrySafe`, no tool parts, finish other than `length`, not `json_schema`) raises `InvalidOutputError` inside `SessionProcessor.process`, and `SessionRetry.policy` replays it. The primary agent and ordinary actors use the persistent `server` budget; system-spawned agents use the bounded budget in [S2.7].
- A step that cannot be replayed (tool side effects ran, or tool parts remain) is removed by `dropEmptyAssistant` in the run loop, which then starts a fresh step. The number of consecutive drops is bounded by [S2.6].

### [S2.3] Checkpoint Completion Signal

The checkpoint writer's task prompt instructs it to reply with exactly `CHECKPOINT_COMPLETE`, with no further tool calls and no summary, once its authorized edits are written. The marker is ordinary non-empty assistant text, so existing classification ends the run as `final` without a checkpoint-specific classifier branch, and a completed writer never enters invalid-output recovery. A writer whose model omits the marker ends with an empty stop and falls under the bounded budget in [S2.7]. This design intentionally does not add a checkpoint content hash, write ledger, or dedicated commit tool; the hard write boundary in [S2.1] makes drift non-destructive.

### [S2.4] Actor Error Outcomes

If `SessionPrompt.prompt` returns a terminal assistant carrying `assistant.error`, `Actor.runAgentLoop` must fail instead of converting the result into a successful actor outcome with no text. This applies to all actors/subagents and does not change direct primary-session behavior.

For checkpoint writers, exhausting invalid-output recovery ([S2.6] or [S2.7]) therefore produces a failed actor outcome. The checkpoint settlement watcher must leave `last_checkpoint_message_id` unchanged, preserving the existing invariant that an uncheckpointed delta is re-covered by a later writer.

### [S2.5] Regression Contract

Tests must cover the real boundaries rather than prompt text alone:

- checkpoint-writer source and `.mimocode/` writes fail through the unified gate;
- valid checkpoint and project-memory writes continue to pass;
- unauthorized memory-tree paths continue to fail;
- `apply_patch` cannot mutate source as checkpoint-writer;
- empty-output recovery injects no reminder message for any agent;
- a checkpoint writer that returns `CHECKPOINT_COMPLETE` succeeds;
- repeated unreplayable empty steps stop at the [S2.6] limit with a terminal `InvalidOutputError`, for the primary agent and for actors;
- a system-spawned agent that keeps returning empty output stops after the `retry.unknown` budget, while the primary agent keeps the persistent budget;
- actor terminal assistant errors produce failure outcomes;
- the stream error log carries no request body; and
- existing dream/distill sandbox behavior does not regress.

### [S2.6] Bounded Dropped Empty Steps

`dropEmptyAssistant` replays an unchanged context after tool side effects, so a model that deterministically repeats the same unproductive step would loop without end. The run loop counts consecutive drops:

- The counter is local to one run loop and resets whenever an after-process classification is neither `think-only` nor `invalid`.
- `Flag.MIMOCODE_EMPTY_STEP_DROP_LIMIT` (default 2) is the number of drops allowed in a row.
- When the counter has reached the limit, the next empty step is not dropped. Its assistant receives a terminal `InvalidOutputError` carrying the classification reason, `Session.Event.Error` is published, and the loop exits.
- The bound applies to every agent, the primary agent included, and to all three drop sites (stale assistant at loop start, fork path, and normal path).

### [S2.7] Bounded Empty-Output Budget for System Agents

System-spawned agents (`SYSTEM_SPAWNED_AGENT_TYPES`: `checkpoint-writer`, `dream`, `distill`) run in the background where no user can cancel them, so the persistent `server` budget would retry a deterministic empty output indefinitely with the full context.

- `SessionRetry.policy`'s `budget` callback receives the parsed error alongside the decision.
- `SessionProcessor.process` selects the resolved `retry.unknown` budget (default 8 retries within 15 minutes) when the error is `InvalidOutputError` and the assistant's agent is system-spawned. Every other error kind, and every other agent, keeps `SessionRetry.budgetFor`.
- Exhaustion follows the existing terminal path: `halt` stamps the assistant error, and [S2.4] turns it into a failed actor outcome.

### [S2.8] Stream Error Log Summary

The `streamText` `onError` callback receives an event `{ error }`. The `stream error` log line records `ProviderError.summarizeCause(error)` (name, message, code and status code for each cause) and never serializes the error object itself, whose `requestBodyValues` holds the full system prompt and context. The debug line records the inner error's message.

## [S3] Out of Scope

- Modifying Compose skills, `compose.txt`, the Compose workflow, or PR descriptions.
- Changing the checkpoint writer's full-context or child-session architecture.
- Removing file-editing tools from the checkpoint writer solely as a safety mechanism.
- Introducing a dedicated checkpoint commit tool, transactional multi-file writes, checkpoint hashes, or tool-history success ledgers.
- Changing checkpoint content schemas, spillover formats, memory paths, or watermark selection.
- Sandboxing direct shell filesystem writes for agents that are allowed to use shell tools; checkpoint-writer does not currently receive a shell tool.
- Detecting symlink or hardlink escapes deliberately placed inside the application-managed memory tree; this boundary protects normal resolved paths and `..` traversal, not adversarial filesystem topology controlled by the user.
- Modifying or repairing historical database records.
- Changing rate-limit (429) or other transport retry budgets.
- Changing the persistent empty-output budget for the primary agent and ordinary actors.
- Narrowing the writer's LLM-visible tool schema, which mirrors the parent for prompt-cache parity.

## Tasks

- [ ] T1: Bound consecutive dropped empty steps - acceptance: a scripted run whose model keeps calling a rejected tool with `finish=stop` and no text stops after `MIMOCODE_EMPTY_STEP_DROP_LIMIT` drops with a terminal `InvalidOutputError`, for the primary agent and for an actor; a productive step between empty steps resets the count (covers: S2.6, S2.5)
- [ ] T2: Bounded empty-output budget for system-spawned agents - acceptance: a checkpoint writer receiving only empty stops stops after the configured `retry.unknown` budget with a failed actor outcome, while the primary agent under the same config keeps retrying past it (covers: S2.7, S2.4, S2.5)
- [ ] T3: Checkpoint completion marker in the writer prompt - acceptance: the writer task prompt instructs replying exactly `CHECKPOINT_COMPLETE`, and a writer run ending on that text resolves success without retry (covers: S2.3, S2.5)
- [ ] T4: Summarize the stream error log - acceptance: a provider error carrying `requestBodyValues` produces a `stream error` log line with the status code and no request body content (covers: S2.8, S2.5)
- [ ] T5: Verify and review - acceptance: focused session/actor suites and `bun typecheck` pass from `packages/cli`, and an independent review approves (depends: T1, T2, T3, T4)
