---
feature: toolcall-flooding
status: delivered
updated: 2026-09-22
branch: codex/toolcall-flooding
commits: 47920126..0ffdd318
---

# Tool Batch Safety

## Report

**What was built** — Two independent protections are enabled by default. The
flooding guard normally waits for provider finish before releasing client tool calls. A
17th call cancels an unrecoverable batch without executing its tools, records English
cancellation results, adds a system reminder repeating the existing guidance to prefer 1–3 calls and
avoid more than 8, and continues sampling.
Recovery is limited to two attempts per agent turn. A third flooded response
still cancels every tool, then stops the turn with a visible error instead of
sending another reminder or model request.

MiMo models using the OpenAI-compatible adapter can instead yield the first 16
complete client calls at that boundary. Their real tool results let the model
continue the task instead of repeatedly regenerating a cancelled batch. See the
MiMo exception in S2 for the validation and accounting limits.

Failure cascade cancels the remaining batch after any non-read/search failure
or any invalid call. Only execution failures of valid `read`, `grep`, and `glob`
calls are exempt. Invalid read/search arguments use exclusive admission;
whitelisted actors and the injected StructuredOutput tool obey the same gate.
Earlier successes and the original failure remain in context. Ordinary failures
consume the full model stream, preserving usage and cached-token accounting.
Each `MIMOCODE_DISABLE_*` flag accepts `1` or `true` to disable its own protection.

**Verification** — Dependencies installed with `bun ci`; the lockfile is
unchanged. All test and typecheck commands ran from `packages/opencode`.

- PASS: the following integrated regression command, 163 tests in 16 files,
  906 assertions, zero failures:

```sh
bun test \
  test/session/toolcall-flooding.test.ts \
  test/session/toolcall-flooding-stream.test.ts \
  test/session/tool-fail-cascade.test.ts \
  test/session/invalid-tool-cascade.test.ts \
  test/session/tool-safety-flags.test.ts \
  test/tool/fail-cascade.test.ts test/tool/gate.test.ts \
  test/session/tool-gate-cancel.test.ts \
  test/session/tool-gate-hook.test.ts \
  test/session/tool-gate-orchestration.test.ts \
  test/session/length-tool-safety.test.ts \
  test/session/structured-output.test.ts \
  test/session/llm-retry.test.ts test/session/max-mode.test.ts \
  test/session/auto-resume-after-tools.test.ts \
  test/provider/openai-compatible-tool-id.test.ts
```

- PASS: after sharing invalid classification with hook/whitelist rejection,
  `bun test test/session/invalid-tool-cascade.test.ts test/session/tool-fail-cascade.test.ts test/session/tool-safety-flags.test.ts`
  passed 31 tests and 495 assertions. This includes all four flag combinations,
  with both DISABLE variables genuinely unset for the default case.
- PASS: `bun typecheck` on the final implementation.
- PASS: `bunx oxlint --format json` on all changed TypeScript files, zero new
  diagnostics. PRE-EXISTING `lint-baseline`: 83 warnings on unchanged lines.
- PASS: `git diff --check` and `git diff --cached --check`.
- PASS: independent review of `47920126..0ffdd318`, with separate passing
  conclusions for every acceptance criterion, correctness, and codebase
  consistency. All verification processes exited before review.

**Journey log**

1. The barrier must release at provider finish. SDK finish-step waits for tool
   execution and would deadlock a closed execution gate.
2. Real SDK tests verify streaming restoration when the guard is disabled;
   the existing OpenAI-compatible adapter independently buffers complete calls.
3. Ordinary failures and invalid calls retain the full stream and context for
   usage accounting. Flooding is the only new generation-abort condition.
4. All invalid calls cascade, including malformed read/search arguments; only
   execution failure of a valid read/search call is exempt.
5. Independent review exposed whitelist interception of the invalid handler and
   ungated StructuredOutput capture. Targeted tests reproduced both defects;
   fixes and regression tests passed re-review.

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
Allow 16 calls; on call 17, immediately cancel the upstream stream. By default, discard all
buffered executions, and report a distinct flooding error. Cancel/error/EOF
without a finish must never release a partial batch. Provider-executed tools
cannot have their remote side effects rolled back; the barrier controls client
execution only. Calls made inside exec scripts retain script-owned semantics.

### MiMo bounded continuation

For the OpenAI-compatible adapter and a model whose family is `mimo` or whose
API ID starts with `mimo-`, call 17 is a local batch boundary. If all first 16
calls have complete JSON object arguments and unique IDs, release that prefix
through the existing SDK schema validation, permission checks and execution
gate. The discarded call must not create a pending session part. Close open
text/reasoning/input blocks, mark the local finish with
`mimocode_tool_call_limit`, and continue with the real tool observations.
Do not ask the model to regenerate calls that already ran.

This exception only handles local function calls without opaque provider
metadata. Partial inputs, duplicate IDs, provider execution, provider results
or approvals use the cancellation/recovery path instead. Transport errors,
premature EOF and user cancellation never yield buffered calls. Calls below
the cap still wait for provider finish; other adapters retain their existing
behavior. The global opt-out still disables both behaviors.

The interrupted response has no provider usage chunk. Report unknown usage at
the SDK boundary rather than fabricated counts, and include the local limit
in response metadata. Token totals for interrupted generations are therefore
incomplete. Normal provider finishes retain their usage unchanged.

The processor converts every pending call in a flooded step to a cancelled tool
error with the result `Tool call cancelled because tool-call flooding was detected.`
Preserve complete arguments when available, finalize streamed text/reasoning, and mark the step
as tool-calls without a terminal assistant error. Append a synthetic user
system-reminder identifying toolcall flooding, stating no tools executed, and
repeating the existing system prompt sentence verbatim:
`Prefer 1–3 tool calls per step. Avoid more than 8 calls in a single step.`
Continue model sampling with those tool results and the reminder. User stop
remains terminal. A new request owns a new buffer and count.

The recovery budget is shared across assistant steps in the current agent turn.
Allow two recovery requests; on the third flooded response, preserve the
cancellation results, record and publish a terminal assistant error, and stop
without another reminder. Intervening successful steps do not replenish the
budget, and neither text-loop recovery nor the goal judge may restart an
exhausted turn. A later user turn starts with a fresh budget.

The threshold intentionally exceeds the prompt's guidance to leave headroom.
This trades time-to-first-tool for preventing side effects from an abnormal
batch; normal batches retain their existing execution order after generation.
The guard bounds calls per step and flooding recovery attempts per turn, not
argument bytes or the total number of successful steps.

## [S3] Out of Scope

Changing TUI controls, changing the existing parallel group, counting nested exec
calls, token/time limits, or changing provider-native tool
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
result. Ordinary failures do not truncate the suffix or synthesize a finish event
or usage; the explicit MiMo batch boundary above is the exception. Normal sampling resumes with the full observations. Disabling cascade
allows subsequent tools to execute, while invalid calls still report failure.

## Tasks

- [x] T1: Add request-local generation barrier and opt-out flag — acceptance: 16 calls execute only after generation finishes; call 17 cancels without client tool side effects; disabled mode streams as before (covers: S2).
- [x] T2: Persist cancellation and recover the model step — acceptance: all observed calls have the exact aborted result and the next request contains the reminder and resumes successfully (covers: S2).
- [x] T3: Verify boundaries and compatibility — acceptance: partial calls, transport failure, user cancellation, independent requests, FIFO scheduling, focused tests and package typecheck pass; independent review completes (covers: S2, S3).
- [x] T4: Add default-on failure cascade at gate release — acceptance: exclusive-tool failure cancels queued and late-arriving calls, including StructuredOutput, before their bodies run; valid read/search execution failures and unrelated gates remain runnable; the opt-out restores admission (covers: S4).
- [x] T5: Verify cascade through real session execution — acceptance: edit failure prevents a subsequent bash side effect; bash nonzero, invalid calls and hook/MCP failures follow the failure contract; successful and exempt read/search batches still run (covers: S4).
- [x] T6: Handle invalid calls through natural cascade — acceptance: invalid names and arguments (including whitelisted read/search calls) trigger cascade and report their original errors, following calls remain in context as cancelled observations, successful prefix results remain intact, provider usage/cached tokens survive, and the cascade opt-out lets following tools execute (covers: S5).
- [x] T7: Verify the four feature combinations — acceptance: default with both DISABLE variables unset, each protection alone, and both disabled all handle a 17-call batch followed by a failing small batch correctly; flags remain independent and gates reset each step (covers: S2, S4, S5).
