---
feature: rl-training-mode
status: delivered
updated: 2026-08-12
branch: feat/codex-rl-mode
commits: 3d3bf2eb0c13cdd4b45a9166b9d12e353e17af10..7a062e63ee38f2e11fc9398dc38ec1ef16469823
---

# RL Training Mode

## Report

**What was built** — RL training behavior is enabled by default. Set `MIMOCODE_RL_MODE=false` or `0` to restore the ordinary interactive runtime. RL actions use one non-streaming provider sample with all model-request and recovery retries disabled, while completed responses are converted back into the existing processor event protocol for normal persistence.

RL trajectories are append-only, auxiliary title/checkpoint/dream/distill/prediction calls are suppressed, and permissions are fully bypassed for sandboxed training. Automatic compaction and ordinary subagents remain available; compaction may append summaries and boundaries but cannot rewrite historical parts.

**Verification** — `bun typecheck` passed from `packages/opencode`. `env -u MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS bun test test/flag test/permission test/session/llm.test.ts test/session/llm-rl.test.ts test/session/llm-retry.test.ts test/session/processor-effect.test.ts test/session/structured-output-retry.test.ts test/session/invalid-output-continuation.test.ts test/session/text-loop-detection.test.ts test/session/text-loop-integration.test.ts test/session/max-mode-econnreset.test.ts test/session/auto-dream-memory-write.test.ts test/session/checkpoint-memory-write.test.ts test/session/prune.test.ts test/session/prune-main-slice.test.ts test/session/rebuild-microcompact.test.ts test/session/compaction-agent-scope.test.ts test/workflow/retry.test.ts --timeout 20000` passed with 287 tests passing, 3 skipped, and 0 failing across 33 files. Independent review and the post-fix targeted review found no critical or important findings.

**Journey log**

- The historical RL commit was used as intent evidence only; its behavior was reimplemented against the current mainline behind a default-on master switch with an explicit normal-mode opt-out.
- A live mock-provider integration test exposed that returning a bare `generateText` Promise from an Effect generator did not await it; wrapping it in `Effect.promise` fixed the real request path.
- The test runner environment injected `MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS=1`; permission regression verification explicitly removed it to avoid a false baseline failure.
- Synthetic events only carry fields consumed by the current processor; if processor persistence later consumes additional start/finish metadata, the adapter must evolve with it.
- The test preload pins `MIMOCODE_RL_MODE=false` so the existing suite continues to verify normal interactive behavior; RL tests opt in explicitly and the flag test separately verifies the production default.

## [S1] Problem

RL training runs need an auditable trajectory in which each agent action maps to one provider sample. The normal interactive runtime currently adds hidden variability through streaming retries, recovery continuations, auxiliary model calls, and history pruning. Applying the old `feat/rl-training-mode` behavior globally would also remove normal TUI streaming and permission safety from ordinary users.

## [S2] Mode Contract

RL mode enables the complete training contract by default. `MIMOCODE_RL_MODE=false` or `0` restores existing interactive behavior; `true` or `1` explicitly keeps RL mode enabled.

In RL mode:

- Main-session model actions use one non-streaming `generateText` request with AI SDK retries disabled. The completed response is converted to the existing processor event protocol so assistant text, reasoning, tool calls, usage, and finish metadata continue to be persisted by the normal session path.
- Processor-level provider retries, assistant-prefill recovery resends, output-length continuation, empty/invalid-output continuation, text-tool-call recovery, structured-output retries, n-gram recovery, text-loop recovery, max-mode candidate/judge retries, and workflow retries do not issue another model request. The first failure is persisted and terminates that action. Existing retry behavior remains available outside RL mode.
- Persisted trajectory parts are append-only. Pruning, checkpoint rebuild microcompaction, and compaction cleanup may not rewrite or clear prior tool results, reasoning, or media. Automatic compaction may still append a summary and boundary.
- Automatic title generation, checkpoint writing, dream, distill, and next-prompt prediction are disabled. Ordinary subagents and automatic compaction remain enabled.
- Permission asks, explicit deny rules, forced confirmations such as `bash_delete`, and deny-based tool hiding are bypassed. This behavior is intentionally restricted to isolated training sandboxes.

The mode improves trajectory auditability but does not guarantee identical model output: provider sampling, external tools, and concurrent subagents may remain nondeterministic.

## [S3] Compatibility and Boundaries

- No dedicated TUI mode, CLI option, or configuration-file field is added.
- Existing fine-grained flags and config fields retain their normal-mode meaning. RL invariants take precedence while `MIMOCODE_RL_MODE=true`; users cannot selectively re-enable a conflicting retry, auxiliary call, pruning, or permission check inside RL mode.
- MCP sampling and unrelated small-model utilities are outside scope unless they are invoked automatically by the main training trajectory.
- Actor cancellation/worktree cleanup detachment from the historical branch is outside scope because it is cleanup latency behavior rather than a trajectory-sampling invariant.
- The historical commit `3544de8fa` is reference material only; integration targets the current branch and preserves subsequent mainline behavior.

## [S4] Verification

Tests must prove both sides of the mode boundary:

- The master flag defaults on and parses explicit true/false values correctly.
- RL mode makes a single non-streaming, zero-retry provider request and persists its synthetic processor events; normal mode still streams and retains configured retries.
- Each recovery category covered by the implementation makes one request in RL mode and preserves existing normal-mode retry behavior.
- RL mode does not mutate historical tool/reasoning/media parts during prune, compaction, or checkpoint rebuild.
- RL mode suppresses every listed auxiliary model path while retaining compaction and ordinary actor availability.
- RL full permission overrides deny and forced-confirmation rules and keeps tools visible; normal permission behavior is unchanged when the mode is off.

## Tasks

- [x] T1: Add the isolated RL master flag and mode-boundary tests — acceptance: `MIMOCODE_RL_MODE` defaults true, recognizes true/false values, and explicit opt-out restores normal-mode behavior (covers: S2, S3, S4)
- [x] T2: Implement single-sample main-session requests in RL mode — acceptance: RL uses one `generateText` call with `maxRetries: 0`, converts all supported result parts into processor events, and normal mode still uses `streamText` (covers: S2, S4; depends: T1)
- [x] T3: Disable recovery resampling in RL mode — acceptance: provider, output, structured-output, loop, max-mode, and workflow failure paths terminate after their first model attempt while normal mode retains its current policies (covers: S2, S3, S4; depends: T1)
- [x] T4: Make persisted RL trajectories append-only — acceptance: prune, compaction, and checkpoint rebuild do not rewrite prior parts in RL mode, while compaction may append a summary boundary (covers: S2, S4; depends: T1)
- [x] T5: Suppress auxiliary model calls in RL mode — acceptance: title, checkpoint, dream, distill, and next-prompt prediction do not run; compaction and ordinary subagents remain enabled (covers: S2, S3, S4; depends: T1)
- [x] T6: Enable RL-only full permission — acceptance: RL bypasses explicit deny, `bash_delete` confirmation, and tool hiding while normal mode preserves all checks (covers: S2, S4; depends: T1)
- [x] T7: Run focused and package-level verification, then independent review — acceptance: relevant tests and `bun typecheck` pass from `packages/opencode`, and review finds no critical spec-compliance, correctness, or consistency issue (covers: S4; depends: T2, T3, T4, T5, T6)
