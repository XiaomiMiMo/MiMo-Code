---
feature: toolcall-flooding
status: designed
updated: 2026-09-23
branch: feat/toolcall-flood-8-dedup
commits:  # filled at delivery
---

# Tool Batch Safety

## Report

Design amendment over the delivered first-tool flooding recovery. Not yet
implemented. Baseline behavior and prior verification live in git history of
this document (last delivered as `codex/flooding-first-tool`).

## [S1] Problem

An affected model can generate an unbounded batch of tool calls, or fill a batch
with identical calls (especially `bash` / `actor`). The historical flood
response cancelled the whole unexecuted batch, then only the first call, behind
a generation barrier that held every tool until provider finish. That quota
discards a valid batch prefix, delays time-to-first-tool, and the recovery
reminder did not stop models from regenerating a flooded batch.

## [S2] Design

One product phenomenon — runaway model tool calling — with two interception
methods and two switches:

| Switch | Default | Catches |
| --- | --- | --- |
| `MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT` | on (set `1`/`true` to disable) | count: ninth call in one assistant step |
| `MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT` | on (set `1`/`true` to disable) | content: exact repeat of an earlier call in the same step |

Both are read per model request. Disabling one does not disable the other.
Provider adapters retain their own buffering (the OpenAI-compatible patch still
delays complete calls until EOF) independently of these switches.

### [S2.1] No generation barrier

Do not hold tool calls until provider finish. Complete tool calls are released
into the normal SDK path as they arrive and may execute while the model is still
streaming. There is no later result that must interrupt an earlier call, so the
barrier is removed. Text, reasoning, and tool argument events remain streamed.
Existing read/search concurrency and the per-assistant-step FIFO gate are
unchanged.

### [S2.2] Flooding (count)

Count calls on `tool-input-start` (fallback: first sight of a complete call).
Do not double-count start and completed. On the **ninth** call, cancel the
upstream generation **before parsing that call** — do not accumulate its
deltas, do not create its tool part, do not forward it to the SDK.

User-visible result: the assistant step contains only the eight earlier calls.
Nothing else is done after the cancel:

- no flooding tool result for the ninth or later remnants;
- no synthetic recovery user message;
- no flooding reminder (experimentally omitted — with threshold 16 the reminder
  did not stop flooded regeneration);
- no released-call bookkeeping, because all eight earlier calls already run.

The eight earlier calls are always allowed to execute. They are not a quota
subject to replacement or cancellation by flood detection. Cancel generation
only; keep the SDK request signal alive so in-flight tools can validate,
request permission, and finish. Preserve each real success or failure. User
stop remains terminal. Other stream errors or EOF without a finish follow
existing behavior. Provider-executed side effects cannot be rolled back; this
guard controls client execution only. Exec guest calls keep script-owned
semantics.

If the ninth call is observed only as a partial fragment (start seen, body not
parseable), drop that fragment so the transcript still shows eight calls.

### [S2.3] Duplicate (content)

When duplicate detection is on, a model-facing call whose signature — canonical
tool name + stable-stringified parsed arguments (raw input string when
arguments are not parseable JSON) — matches an **earlier call in the same
assistant step / model-response batch** is cancelled and is not executed.

- Later exact matches only; the first occurrence runs.
- Multi-step or multi-turn repetition of the same call is normal and is not
  deduped.
- `bash` / `actor` are motivating examples, not a separate policy.
- Nested exec guest calls are out of scope.

Duplicate cancel is a tool return, not a silent drop:
`Tool call cancelled because it exactly matches an earlier tool call in this step and was not executed.`

Duplicate detection is the safety net under flooding and also covers batches
that never hit the ninth call (several identical calls below the count limit).
Classify at admission/execute time so streaming execution cannot start the same
call twice. The first occurrence is not blocked by flood detection.

Worked example `1,2,3,1,1,1,4,3,3` (nine calls, numbers are signatures):
run `1,2,3,4` (the first eight stream-execute; the ninth `3` is the flood
trigger and is dropped before parse — user sees eight calls). Among the eight,
the later `1`s and `3` that completed before the cancel are cancelled as
**duplicate**. If the batch is only `1,2,3,1,1,1,4,3` (eight calls): run
`1,2,3,4`, cancel three `1`s and one `3` as **duplicate**, no flood.

### [S2.4] Failure cascade

Unchanged and independent. A non-read/search failure among running tools still
closes that step's FIFO gate and cancels queued suffix calls with the existing
cascade message. Flood cancel of the ninth does not create cascade failures for
the eight. `MIMOCODE_DISABLE_FAIL_CASCADE=1` or `true` keeps its meaning.

## [S3] Out of Scope

Changing TUI controls, the parallel read group, nested exec counting, model-name
detection, token/time limits, provider-native tool execution semantics,
cross-step or cross-turn dedup, fuzzy matching, special-case `bash`/`actor`
rules, reintroducing a release quota or generation barrier, and restoring the
flooding reminder in this iteration.

## [S4] Invalid Calls and Stream Accounting

Invalid names and arguments do not abort model generation. Only the ninth-call
flood cancel (and existing user cancellation, permission rejection, transport
failures) stop the stream. Unknown names such as `Bash` / `Write` keep the
invalid-tool fallback and still produce a failed tool result. Invalid calls
still trigger failure cascade.

Preserve in the conversation the eight calls and their real results, any
duplicate cancels among them, and any cascade cancels. Do not invent a ninth
tool part or usage. Normal sampling resumes after the eight tool results,
without an injected reminder.

## [S5] Implementation conflicts to resolve

1. **Remove the generation barrier** in `guardToolCallStream` (`toolcall-flooding.ts`).
   Today it buffers `tool-call` / `tool-result` / `tool-approval-request` until
   `finish`. That entire hold-and-release path goes away. Keep only counting and
   ninth-call abort-before-parse.
2. **Drop released-call recovery**. `ToolCallFloodingError.releasedCallID`,
   the single synthetic `tool-call` on overflow, the processor catch that
   rewrites every non-released call, and the `#2490` PascalCase forward of
   `releasedCallID` all assume a release quota. With all eight streaming out,
   flood cancel is a silent ninth-call drop — no processor recovery rewrite.
3. **Ninth-call visibility**. Abort on `tool-input-start` before delta parse;
   ensure no tool part is created (or sweep a partial part) so the user sees
   exactly eight calls.
4. **Duplicate admission point**. Must run at execute/gate admission, not at
   provider finish, because tools now run while streaming. Needs the signature
   (name + stable-stringified args) in the execute path. `loop-streak.ts`
   `stableStringify` is the right primitive; its `toolSignature` on persisted
   parts is too late. `ToolGate` currently only sees `{tool, callID}` — extend
   admission or wrap execute.
5. **New flag** `MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT` in `flag.ts`,
   default off (detection on). Independent of the flood flag.
6. **Reminder removal**. Delete `TOOLCALL_FLOODING_REMINDER` injection from the
   processor flood path. If the ninth is not persisted, that catch path may
   shrink to a no-op or be deleted. Keep a clean seam if the reminder experiment
   needs to return.
7. **OpenAI-compatible late complete calls**. That adapter still delivers
   complete calls at EOF. Ninth-call abort-before-parse must not discard the
   first eight's complete/delta-recovered inputs when they share one burst;
   forward all complete predecessors before reacting to the ninth.
8. **Open PR `#2491`** (MiMo release-first-16 quota) conflicts with no-quota
   streaming execution; do not stack.
9. **Tests** hard-code barrier + 17-call + only-first-runs + reminder text in
   `toolcall-flooding.test.ts`, `toolcall-flooding-stream.test.ts`,
   `tool-safety-flags.test.ts`, PascalCase flooding. Rewrite for: eight
   stream-execute, silent ninth drop, no reminder, duplicate cancel messages,
   both new flag combinations.
10. **FIFO / cascade races**. Eight tools may now be in flight while the ninth
    aborts generation; cleanup must not abort in-flight tools (same rule as the
    old admitted first call).

## Tasks

- [ ] T1: Remove the generation barrier; stream-release complete calls; abort generation on the ninth `tool-input-start` before parse and leave no ninth tool part — acceptance: eight earlier calls execute with real results; the user-visible batch has eight calls; no reminder and no synthetic recovery message (covers: S2.1, S2.2, S3).
- [ ] T2: Same-step exact-duplicate cancel at admission with its own default-on switch — acceptance: `123111433`-shape batches run each signature once and cancel later exact matches with the duplicate tool return; `MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT=1` restores repeats; flood and duplicate switches are independent (covers: S2.3, S2.4, S5; depends: T1).
- [ ] T3: Verify flags, cascade, adapters, and regressions — acceptance: four flag combinations pass; cascade still works on a released exclusive failure; OpenAI-compatible burst does not drop the first eight when the ninth arrives; flooding/stream/flags/PascalCase suites rewritten and green; package typecheck passes; independent review completes (covers: S2, S3, S4, S5; depends: T2).
