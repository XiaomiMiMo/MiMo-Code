---
feature: toolcall-flooding
status: in-progress
updated: 2026-09-22
branch: codex/toolcall-flooding
commits:
---

# Tool Batch Safety

## Report

## [S1] Problem

An affected model can generate an unbounded batch of tool calls. Streaming
execution allows side effects before the batch can be identified as flooding.

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
Allow 16 calls; on call 17, immediately cancel the upstream stream, discard all
buffered executions, and report a distinct flooding error. Cancel/error/EOF
without a finish must never release a partial batch. Provider-executed tools
cannot have their remote side effects rolled back; the barrier controls client
execution only. Calls made inside exec scripts retain script-owned semantics.

The processor converts every pending call in a flooded step to a cancelled tool
error with the result `Tool call cancelled because tool-call flooding was detected.`
Preserve complete arguments when available, finalize streamed text/reasoning, and mark the step
as tool-calls without a terminal assistant error. Append a synthetic user
system-reminder identifying toolcall flooding, stating no tools executed, and
repeating the existing system prompt sentence verbatim:
`Prefer 1–3 tool calls per step. Avoid more than 8 calls in a single step.`
Continue model sampling with those tool results and the reminder. User stop
remains terminal. A new request owns a new buffer and count.

The threshold intentionally exceeds the prompt's guidance to leave headroom.
This trades time-to-first-tool for preventing side effects from an abnormal
batch; normal batches retain their existing execution order after generation.
The guard bounds calls per step, not argument bytes or the number of recovery
steps. No additional recovery-attempt limit is introduced.

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
result's exit code. A read/search failure does not poison the gate; earlier completed tools are not rolled back.
The next assistant step starts with a clean gate and receives the original
failure plus the cancelled-call observations through ordinary continuation.

Failures include thrown execution/cleanup errors, MCP error results, invalid
calls routed through the existing invalid-tool handler, permission/hook
rejections, bash nonzero exit statuses, and failed workflow run results. Use
structured failure signals, not heuristics over output text. Invalid read/search arguments retain their original
tool classification. User/session interruption follows existing cancellation
semantics. Exec guest calls retain script-owned control flow; a failed top-level
exec is subject to cascade like every other exclusive tool.

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
Classify its cascade using the original requested name: invalid `Read` is not
in the lowercase read/search exemption, while invalid arguments to `read` are.

Preserve all calls and results in the conversation: earlier successful results,
the original failure, and every subsequent call with its cascade cancellation
result. Do not truncate or hide the suffix, and do not synthesize a finish event
or usage. Normal sampling resumes with the full observations. Disabling cascade
allows subsequent tools to execute, while invalid calls still report failure.

## Tasks

- [ ] T1: Add request-local generation barrier and opt-out flag — acceptance: 16 calls execute only after generation finishes; call 17 cancels without client tool side effects; disabled mode streams as before (covers: S2).
- [ ] T2: Persist cancellation and recover the model step — acceptance: all observed calls have the exact aborted result and the next request contains the reminder and resumes successfully (covers: S2).
- [ ] T3: Verify boundaries and compatibility — acceptance: partial calls, transport failure, user cancellation, independent requests, FIFO scheduling, focused tests and package typecheck pass; independent review completes (covers: S2, S3).
- [ ] T4: Add default-on failure cascade at gate release — acceptance: exclusive-tool failure cancels queued and late-arriving calls before their bodies run; read/search failure and unrelated gates remain runnable; the opt-out restores admission (covers: S4).
- [ ] T5: Verify cascade through real session execution — acceptance: edit failure prevents a subsequent bash side effect; bash nonzero, invalid calls and hook/MCP failures follow the failure contract; successful and exempt read/search batches still run (covers: S4).
- [ ] T6: Handle invalid calls through natural cascade — acceptance: uppercase tool names produce failed invalid results, following calls remain in context as cancelled observations, successful prefix results remain intact, provider usage/cached tokens survive, and the cascade opt-out lets following tools execute (covers: S5).
- [ ] T7: Verify the four feature combinations — acceptance: default with both DISABLE variables unset, each protection alone, and both disabled all handle a 17-call batch followed by a failing small batch correctly; flags remain independent and gates reset each step (covers: S2, S4, S5).
