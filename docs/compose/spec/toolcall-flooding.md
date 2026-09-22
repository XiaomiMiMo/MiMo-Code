---
feature: toolcall-flooding
status: in-progress
updated: 2026-09-22
branch: codex/flooding-first-tool
commits:
---

# Tool Batch Safety

## Report

## [S1] Problem

An affected model can generate an unbounded batch of tool calls. Streaming
execution allows side effects before the batch can be identified as flooding.
Cancelling every call can leave the model repeating the same flooded batch
without progress. This experiment permits the first call while blocking the rest.

## [S2] Design

Protection is enabled for model-facing calls by default, regardless of model ID.
`MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT=1` or `true` restores streaming execution
and removes the flooding cap. The flag is read for each model request.
Provider adapters retain their own buffering: the existing OpenAI-compatible
patch still delays complete calls until EOF even when this guard is disabled.

A request-local generation barrier buffers complete tool-call events before the
AI SDK executes them. Text, reasoning, and tool argument events remain streamed.
On the provider's successful finish event, release the buffered calls in order
into the existing per-assistant-step FIFO gate. Do not wait for the SDK's
finish-step: it waits for tool results and would deadlock a closed gate.
Existing read/search concurrency and independent agent gates remain unchanged.

Count each call when its input starts, with a fallback for providers emitting
only complete tool calls. Do not double-count the start and completed call.
Allow 16 calls; on call 17, immediately cancel the upstream stream. Release only
the first observed call into the normal SDK validation and execution path, then
report the flooding condition. Recover its input from the accumulated deltas
when the provider buffers complete calls until EOF. Release it only if its input
is complete JSON, it is client-executed, and its ID is unambiguous within the
observed batch. Otherwise release no call; never substitute a later call.
Discard all remaining buffered executions. Normal argument repair/validation,
permission checks, hooks, FIFO admission, and invalid-tool handling still apply.
Wait for the first call's actual result before recovering the model step; do not
interrupt its execution when the flooding notification arrives. Preserve its
original success or failure, and do not replace it with a flooding cancellation.
Other stream errors, user cancellation, or EOF without a finish must never
release a partial batch. Provider-executed tools
cannot have their remote side effects rolled back; the barrier controls client
execution only. Calls made inside exec scripts retain script-owned semantics.

The processor converts every unadmitted call in a flooded step to a cancelled tool
error with the result `Tool call cancelled because tool-call flooding was detected.`
Preserve complete arguments when available, finalize streamed text/reasoning, and mark the step
as tool-calls without a terminal assistant error. Append a synthetic user
system-reminder identifying toolcall flooding, stating that only the first call
was allowed through and later client calls were blocked, and directing the model to
inspect the first result before continuing. Do not imply successful execution
when validation, permissions, or the tool itself failed. When no call could be
released, explain that the first call could not safely be submitted and none
were allowed to execute. Repeat the existing system prompt sentence verbatim:
`Prefer 1–3 tool calls per step. Avoid more than 8 calls in a single step.`
Continue model sampling with those tool results and the reminder. User stop
remains terminal. A new request owns a new buffer and count.

The threshold intentionally exceeds the prompt's guidance to leave headroom.
This trades time-to-first-tool for bounding a flooded batch to at most one
client tool execution; normal batches retain their existing execution order after generation.
The guard bounds calls per step, not argument bytes or the number of recovery
steps. No additional recovery-attempt limit is introduced. Repeated flooded
responses may each execute their first call; this is an intentional experiment,
not a guarantee that model repetition will stop. Existing opt-out flags retain
their defaults and independence; no additional experiment flag is introduced.

## [S3] Out of Scope

Changing TUI controls, changing the existing parallel group, counting nested exec
calls, model-name detection, token/time limits, or changing provider-native tool
execution semantics.

## [S4] Failure Cascade

Failure cascade is enabled by default and independent of the flooding guard.
`MIMOCODE_DISABLE_FAIL_CASCADE=1` or `true` restores the previous continue-after-
failure behavior. Each processor handle owns its assistant step's gate and
shares it with the resolved tool map. Cancelled call IDs remain available to
processor cleanup so permission rejection cannot replace the cascade reason
with a generic abort when it stops consuming SDK events early.

When a model-facing tool outside the existing `read` / `grep` / `glob` parallel
group fails, permanently close admission for that batch before releasing the
failed tool's slot. All queued and subsequently arriving calls in that batch,
including reads, are cancelled with natural English:
`Tool call cancelled because an earlier tool call in this response failed.`
The original failed call retains its original error/output, including a bash
result's exit code. Execution failure of a valid read/search call does not poison
the gate; earlier completed tools are not rolled back.
The injected StructuredOutput tool also enters this gate before capturing the final
answer, so a cancelled call cannot terminate the turn. The next assistant step
starts with a clean gate and receives the original failure plus the cancelled-call
observations through ordinary continuation.

Failures include thrown execution/cleanup errors, MCP error results, invalid
calls routed through the existing invalid-tool handler, permission/hook
rejections, bash nonzero exit statuses, and failed workflow run results. Use
structured failure signals, not heuristics over output text. Every invalid call
triggers cascade, including malformed arguments to lowercase read/search tools.
Validate read/search arguments before gate admission so an invalid call is exclusive and cannot admit its suffix concurrently. User/session
interruption follows existing cancellation semantics. Exec guest calls retain
script-owned control flow; a failed top-level exec is subject to cascade like every other exclusive tool.

The cascade is recorded before draining the queue, so edit failure cannot admit
a queued bash command. Closed gates also reject calls registered later while
the model is still streaming with flooding protection disabled. Disabling either
feature does not disable the other.

## [S5] Invalid Calls and Stream Accounting

Tool failures, including invalid names and arguments, do not abort model
generation. Continue consuming the stream through provider finish so its usage
and cached-token accounting are preserved. The >16 flooding guard is the sole
new early-abort exception. Existing user cancellation, explicit permission
rejection, and transport failures retain their stop behavior.

The existing compatibility helper requires exact tool-name matches and repairs
only parameters; it does not lowercase names. Unlisted names such as `Bash`,
`Grep`, `Read`, and `Write` use the existing invalid-tool fallback. That fallback
now produces an actual failed tool result, not a successful text observation.
Invalid names and invalid arguments always trigger cascade, including lowercase
`read`, `grep`, and `glob` calls with malformed arguments. Only execution failures
of valid read/search calls are exempt. The internal invalid handler bypasses an
actor's execution whitelist because it only reports errors; actual tools still
require whitelist admission.

Preserve all calls and results in the conversation: earlier successful results,
the original failure, and every subsequent call with its cascade cancellation
result. Do not truncate or hide the suffix, and do not synthesize a finish event
or usage. Normal sampling resumes with the full observations. Disabling cascade
allows subsequent tools to execute, while invalid calls still report failure.

## Tasks

- [ ] T1: Release only the first eligible call at flooding detection — acceptance: call 17 cancels upstream, at most the first call reaches the SDK, incomplete/ambiguous/provider-executed first calls never admit a substitute, and normal finish/error/cancel behavior stays intact (covers: S2, S3).
- [ ] T2: Preserve the first result through recovery — acceptance: its real success, failure, or invalid result survives; every suffix call has the flooding cancellation; recovery waits for completion and includes an accurate English reminder plus the unchanged 1–3/eight-call guidance (covers: S1, S2, S4, S5; depends: T1).
- [ ] T3: Verify repeated flooding and compatibility — acceptance: repeated flooding admits one call per step, first-call failure never admits a suffix, user stop stays terminal, all four flag combinations and relevant regressions pass, package typecheck passes, and independent review completes (covers: S2, S3, S4, S5; depends: T2).
