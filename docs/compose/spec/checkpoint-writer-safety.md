---
feature: checkpoint-writer-safety
status: delivered
updated: 2026-07-22
branch: investigate/checkpoint-writer-sandbox
commits: 0cb81dba827e27549bde6fba794e27509ef1bf65..25f175dd
---

# Checkpoint Writer Safety

## Report

**What was built** - The checkpoint writer is now confined to normal paths under the memory tree at the unified write gate; the existing precise memory allowlist remains authoritative inside that tree. Dream/distill retain their prior memory-or-`.mimocode/` behavior, while ordinary agents retain normal source writes. The gate now obtains its worktree from `InstanceState.context`, so InstanceRef-bound actor fibers cannot skip the sandbox.

Invalid-output recovery now selects an explicit role policy. Primary turns keep the user-facing reminder, ordinary actors receive a parent-facing reminder, and checkpoint writers receive a scoped recovery instruction that either finishes authorized memory edits or returns `CHECKPOINT_COMPLETE`. System-agent policy coverage is exhaustive. Terminal assistant errors now fail actor outcomes, so exhausted checkpoint recovery leaves the watermark unchanged through the existing transactional settlement path.

**Verification** - From `packages/opencode`, `bun test test/tool/memory-path-guard.test.ts test/tool/apply_patch.test.ts test/agent/ask-routing.test.ts test/session/invalid-output-continuation.test.ts test/actor/spawn.test.ts test/session/checkpoint-watermark-transactional.test.ts test/session/checkpoint-child-session.test.ts test/session/checkpoint-permission.test.ts` passed 151 tests with 286 assertions and 0 failures. `bun typecheck` passed. `git diff --check` passed. Targeted oxlint reported 0 errors; remaining warnings were existing large-file/test idioms. Independent final review approved spec compliance, correctness, and codebase consistency with no remaining findings.

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

### [S2.2] Role-Specific Invalid-Output Policies

Invalid-output continuation must select a policy from the execution role rather than sharing one user-facing prompt across all agents:

- A primary turn (`agentID === "main"`) retains the existing user-facing retry that asks for a final answer or a valid tool call.
- An ordinary actor/subagent receives an actor-facing retry that asks it to return a usable result to its parent or continue the necessary tool work. It must not claim that it is answering the user directly.
- `checkpoint-writer` receives the checkpoint-specific policy in [S2.3].
- Existing system agents must declare an explicit policy. The declared policy keys and `SYSTEM_SPAWNED_AGENT_TYPES` must remain synchronized by a regression test so a future system agent cannot silently inherit a default user-facing retry.
- `dream` and `distill` require a non-empty summary and use a system/actor-facing retry rather than the primary-user wording.

Policy selection must be centralized near the invalid-output continuation. Do not scatter independent agent-name checks across the three run-loop classification sites.

### [S2.3] Checkpoint-Specific Retry

An empty or think-only checkpoint-writer stop remains retryable, but it must never receive the generic primary-agent reminder. The synthetic checkpoint reminder must:

- restate that the actor is the checkpoint writer;
- forbid answering or continuing the parent session's task;
- restrict further work to the authorized checkpoint and memory paths already supplied to the writer;
- tell the writer to finish any incomplete authorized edits; and
- tell the writer to return exactly `CHECKPOINT_COMPLETE` without further tool calls when the authorized edits are already complete.

The fixed marker is ordinary non-empty assistant text, so existing classification terminates naturally without a checkpoint-specific classifier branch. Existing bounded invalid-output retry limits remain in force. This design intentionally does not add a checkpoint content hash, write ledger, or dedicated commit tool: a capable model gets one correctly scoped recovery instruction, while the hard write boundary makes drift non-destructive.

### [S2.4] Actor Error Outcomes

If `SessionPrompt.prompt` returns a terminal assistant carrying `assistant.error`, `Actor.runAgentLoop` must fail instead of converting the result into a successful actor outcome with no text. This applies to all actors/subagents and does not change direct primary-session behavior.

For checkpoint writers, exhausting invalid-output recovery therefore produces a failed actor outcome. The checkpoint settlement watcher must leave `last_checkpoint_message_id` unchanged, preserving the existing invariant that an uncheckpointed delta is re-covered by a later writer.

### [S2.5] Regression Contract

Tests must cover the real boundaries rather than prompt text alone:

- checkpoint-writer source and `.mimocode/` writes fail through the unified gate;
- valid checkpoint and project-memory writes continue to pass;
- unauthorized memory-tree paths continue to fail;
- `apply_patch` cannot mutate source as checkpoint-writer;
- primary, ordinary actor, and checkpoint-writer empty outputs receive their respective prompts;
- the checkpoint reminder contains no instruction to answer the user and converges when the model returns `CHECKPOINT_COMPLETE`;
- actor terminal assistant errors produce failure outcomes;
- primary invalid-output recovery and existing dream/distill sandbox behavior do not regress; and
- every system-spawned agent has an explicit invalid-output policy.

## [S3] Out of Scope

- Modifying Compose skills, `compose.txt`, the Compose workflow, or PR descriptions.
- Changing the checkpoint writer's full-context or child-session architecture.
- Removing file-editing tools from the checkpoint writer solely as a safety mechanism.
- Introducing a dedicated checkpoint commit tool, transactional multi-file writes, checkpoint hashes, or tool-history success ledgers.
- Changing checkpoint content schemas, spillover formats, memory paths, or watermark selection.
- Sandboxing direct shell filesystem writes for agents that are allowed to use shell tools; checkpoint-writer does not currently receive a shell tool.
- Detecting symlink or hardlink escapes deliberately placed inside the application-managed memory tree; this boundary protects normal resolved paths and `..` traversal, not adversarial filesystem topology controlled by the user.
- Modifying or repairing historical database records.

## Tasks

- [x] T1: Enforce the checkpoint-writer memory-only sandbox in the unified write gate - acceptance: checkpoint-writer source and `.mimocode/` targets are rejected while valid memory targets, dream/distill behavior, and normal-agent source writes pass (covers: S2.1, S2.5)
- [x] T2: Add centralized role-specific invalid-output policy selection and checkpoint completion-marker retry - acceptance: primary, ordinary actor, checkpoint-writer, dream, and distill receive their specified prompts, the checkpoint path converges on `CHECKPOINT_COMPLETE`, and system-agent policy coverage is exhaustive (covers: S2.2, S2.3, S2.5)
- [x] T3: Propagate terminal assistant errors as actor failures - acceptance: an actor whose prompt terminates with `assistant.error` resolves failure, while successful text and structured actor results remain successful (covers: S2.4, S2.5)
- [x] T4: Add apply-patch and checkpoint outcome regressions - acceptance: checkpoint-writer `apply_patch` cannot mutate source, valid checkpoint and project-memory mutations succeed, exhausted checkpoint recovery resolves actor failure, failed writer settlement leaves the watermark unchanged, and primary recovery remains unchanged (covers: S2.1, S2.3, S2.4, S2.5; depends: T1, T2, T3)
- [x] T5: Run focused tests and package typecheck, then obtain independent review - acceptance: all focused suites and `bun typecheck` pass from `packages/opencode`, and review confirms write-boundary, retry-policy, actor-outcome, and scope compliance (covers: S2.1, S2.2, S2.3, S2.4, S2.5; depends: T4)
