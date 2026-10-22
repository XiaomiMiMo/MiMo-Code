---
feature: lossless-session-db
status: in-progress
updated: 2026-10-21
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2691
---

# Lossless Session DB

## Report

**What was built** — No code path rewrites a persisted part to shrink context any more. Turn-end prune and `stripNonEssential` are gone from `session/prune.ts` together with their call in `session/prompt.ts`; the uncalled `SessionCompaction.prune`, the rebuild-time microcompact in `insertRebuildBoundary`, `pressureLevel` / `contextPressureLevel`, `Flag.MIMOCODE_DISABLE_PRUNE` and the `compaction.prune` config key are removed. `fireCheckpoints`, the threshold functions and `resetThresholds` are unchanged.

A config that still contains `compaction.prune` loads normally: `normalizeLoadedConfig` drops the key and logs one warning, the mechanism already used for `auto_worktree`. Legacy rows that carry `time.compacted` keep rendering the cleared marker, and `history get` returns their stored text. The generated SDK type loses `compaction.prune`.

The rebuild boundary is appended after the newest message (S2.6). `insertRebuildBoundary` reads the tail from the database at insert time, digests it up to the last assistant message, copies the unanswered user messages at its end onto the boundary in full, and records undelivered queued inputs as `deferredInputs` instead of digesting them. `collapseCheckpointTail` applies only to legacy boundaries. The checkpoint writer and the runLoop's turn state read the window with the tail restored (`readRebuildTail` / `withRebuildTail`); the runLoop also places deferred inputs that ended undelivered after the boundary (`withEndedInputs`). `recovery` and resume do not treat a rebuild boundary as a turn. The closing reminder is the loop reminder after a tool step and nothing after a finished reply. The generated SDK type gains `CheckpointPart.deferredInputs`.

**Verification** — From `packages/cli`: `bun typecheck` PASS; `packages/sdk` `bun run typecheck` PASS. The rebuild, checkpoint, fork, threshold, writer, reminder, prune, resume, recovery and overflow test files with `server/session-recovery` and the TUI status tests: 51 files, 514 pass / 0 fail after rerunning `plan-reminder-dedup` alone. Every new test for T6–T11 was run on the commit before its change and failed there for the intended reason. Full `bun test` on the final head: 6131 pass / 77 fail / 41 skip; every failing file (MCP, project, worktree, migrate-global, llm-server tokens, tool-fail-cascade, tool-gate-cancel) passes when run alone except one `prompt-effect` MCP reminder test that exceeds its 5 s limit only under load and passes alone in about 2 s — PRE-EXISTING test interference and timing.

**Journey log**
- `compaction.prune` was opt-in on the base commit (unset meant off) and the test preload isolates XDG config, so a regression test for the old prune path must write `compaction.prune: true` into the fixture's `mimocode.json`; the first version of the T1 test omitted it and passed on base.
- Removed config keys are stripped in `normalizeLoadedConfig` because the config schema is strict.
- Proving a test fails on base: copy it into a detached worktree at the base commit with `node_modules` symlinked, run the file, then remove the worktree.
- The full `bun test` run takes about 34 minutes and shows about 79 failures from interference between test files that do not reproduce per file. Under heavy machine load it takes up to 52 minutes and more files fail on 5 s timeouts; rerun each failing file alone.
- Moving the boundary to the end made it the runLoop's newest user message, which also drives turn state, resume and recovery; every reader that inferred the turn from the window needed the restored tail.
- Automatic rebuild sites hold a window read before their current step, so the tail must be read at insert time.
- Inbox receipt state cannot tell an input a rebuild skipped from one that had already ended, so the boundary records the skipped ids, and only the newest boundary's record is read.

## [S1] Problem

References cite symbols in `packages/cli/src`.

The session database (`PartTable`) is the only copy of a conversation, but three code paths rewrite tool output in place:

- Turn-end `prune` in `session/prune.ts`: when `compaction.prune` is explicitly `true` (unset means off, although the docs called it "default true"), the prompt cache is cold and context pressure is high, it soft-trims main-agent tool outputs over 4096 chars to head and tail, or sets `state.time.compacted`, and blanks reasoning and media through `stripNonEssential`.
- `SessionCompaction.prune` in `session/compaction.ts` sets `time.compacted`. It has no caller.
- Rebuild-time microcompact in `insertRebuildBoundary` (`session/checkpoint.ts`) sets `time.compacted` on read/bash/grep/edit outputs after the boundary.

A compacted output renders as `[Old tool result content cleared]` in `toModelMessages` (`session/message-v2.ts`), and `history get` (`history/service.ts`) returns the rewritten data. Anything the model or the user later needs to recover from the session (a test log, a grep hit, a reasoning step) may already be gone, so neither `history get` nor a script reading the database can serve as a source of truth.

The rebuild boundary is also placed in the middle of the conversation. `insertRebuildBoundary` gives the boundary message `time.created` = the watermark message's time + 1 ms, so the tail (the messages between the writer's watermark and the newest message at insert time) sorts after the boundary. `filterCompacted` walks from the newest message back to the newest boundary, so the tail stays in every later window, and every request then filters it again with `collapseCheckpointTail` (non-user tail messages dropped, user tail messages kept live) to avoid sending it next to its `# Recent activity` digest. The digest is generated once and stored on the boundary; the per-request filter only exists because of the boundary's position.

## [S2] Design

### S2.1 Invariant

After this change no code path mutates the content of a persisted part to reduce context size. Parts are only appended or updated by their own lifecycle (streaming, tool state transitions). Context size is controlled exclusively by window boundaries (checkpoint rebuild boundaries and compaction boundaries).

### S2.2 Removals

- `session/prune.ts`: the turn-end `prune` effect, `stripNonEssential`, their `Interface` members, and the turn-end `prune.prune` call in `session/prompt.ts` with the variables that only feed it. `fireCheckpoints`, threshold resolution (`defaultThresholdsFor`, `parseThreshold`, `maxAllowedFor`, `resolveThresholds`) and `resetThresholds` stay unchanged.
- `SessionCompaction.prune`, its async wrapper, and the `prune` member of the compaction `Interface`.
- The rebuild-time microcompact block in `insertRebuildBoundary`.
- `Overflow.pressureLevel` and `Overflow.contextPressureLevel`, whose only consumer is turn-end prune.
- Config key `compaction.prune`, `Flag.MIMOCODE_DISABLE_PRUNE` and the config-loading code that writes the key from the flag, plus their documentation (including the bundled `mimocode-docs` config reference). Existing configs containing `compaction.prune` load with one warning; the value is ignored.
- Constants used only by the removed code (`PRUNE_MINIMUM`, `PRUNE_PROTECT`, `PRUNE_PROTECTED_TOOLS`, the soft-trim constants) once unreferenced.

### S2.3 Legacy data

`ToolStateCompleted.time.compacted` stays in the schema as an optional read-only field so existing rows parse. Rows that already carry it keep rendering `[Old tool result content cleared]`; no new row gets it. Consumers that read the field (the TUI check in `cli/cmd/tui/routes/session/index.tsx`, the skip in `session/instruction.ts`, and `collapseCheckpointTail` neighbours) keep working on legacy rows unchanged.

### S2.4 Behavioral consequence

Turn-end prune only ran for users who set `compaction.prune: true`. For them, a main session resumed after its prompt cache expired now keeps its old tool outputs and reasoning verbatim inside the current window until the next boundary, so usage crosses the checkpoint thresholds and `Overflow.usable` sooner and the existing checkpoint writer and rebuild run earlier. With the default configuration nothing changes at turn end. Subagents are unaffected (turn-end prune only read main-agent messages). Removing the rebuild-time microcompact does not change any request: after S2.6 the tail it used to clear is outside every window, and only the checkpoint writer reads it, in full. No trigger, threshold or ratio changes.

### S2.6 Rebuild boundary at the end of the conversation

**Placement.** `insertRebuildBoundary` creates the boundary message after the newest main-agent message of the session: `time.created` is the insert time, or that message's `time.created` when the clock reads earlier, and the id is ascending as before. It reads the tail from the database at insert time, because its callers hold a window read before their current step: the main-agent messages after the writer's watermark, without earlier boundaries and without queued inputs (below). Its inputs are the session, the watermark, agent and model only (`boundaryCreatedAt`, `digestUpTo` and `lastMessageInfo` inputs and the code in `rebuildFromCheckpoint` that computed them are removed). `CheckpointPart` keeps its fields and gains the optional `deferredInputs` (below): `coveredUpTo` = the writer's watermark, and `digestUpTo` = the last tail message before the unanswered user messages at its end, written whenever there is one (not only when the activity digest rendered lines). The closing reminder of the rebuild context is chosen from the last tail message.

**Unanswered and queued input.** User messages at the end of the tail, after its last assistant message, have not been answered yet. They are neither digested nor quoted: their text parts (including the text read from attached files) are copied onto the boundary in full as synthetic text parts with their metadata, and their file parts are copied as they are, after the rebuild context. Inputs the inbox has accepted or claimed but not yet delivered to a model step (no `delivery_message_id`) are not part of the tail at all: they are left out of the digest, the copies and `Recent user input (verbatim)`, the ids of all inputs still undelivered at insert time (including ones an earlier boundary left out) are recorded on the boundary's `CheckpointPart` as `deferredInputs`, and they reach the model as their own user messages through the runLoop's pending-input path, which also records their delivery. A recorded input whose receipt later ends without delivery (cancelled by stop, swept on restart, rejected) is visible again like any such input outside a rebuild: the runLoop places it right after the boundary. An input whose receipt had already ended before the rebuild is part of the tail like any other user message.

**Model view.** `filterCompacted` stops at the boundary, so no tail message enters a later window. The tail is represented only by content stored on the boundary at insert time: the `# Recent activity` digest (`renderTailDigest`, unchanged), the `Recent user input (verbatim)` section, which quotes the newest main-agent user messages from the database except the copied and queued ones, and the copied unanswered user messages. Messages created after the boundary stay live.

**Per-request filter.** For a boundary placed this way, `collapseCheckpointTail` has nothing to remove: its range lies before the boundary, outside the window. It stays for legacy boundaries, whose message sorts before the end of its range, and is applied only to them. Detection uses only stored data: a boundary is legacy when its message's `time.created` is earlier than the `time.created` of the message `digestUpTo`.

**Reminders.** Synthetic reminders persisted once per user message (MCP readiness and repeated-step reminders, marker-deduplicated) and the plan reminders that `insertReminders` adds lived on the newest user message, which was often a tail user message. After S2.6 the newest user message in the window is the boundary, which carries none of those markers, so the existing reminder insertion attaches them to the boundary or a later user message. The memory paths reminder goes on the first own user message of each context window, which after a rebuild is the boundary. The skill catalog is not affected: it is sent in the system prompt, and catalogs persisted on user messages by older versions are skipped when rendering. No new reminder logic is added.

**Turn state.** The runLoop reads the state of the current turn (the resume parent, the last user message whose settings drive the step, the last and last finished assistant messages) from its window, and the `session.userQuery.pre` hook reads that user message's text. When the newest user message in the window is a rebuild boundary, the turn's user message and steps are in the boundary's tail, so the loop reads that state from the window with the tail restored between the boundary and the later messages, the same list the checkpoint writer receives; the tail is read once per boundary, and the model request is still built from the window alone. A rebuild after a finished step therefore ends the turn without another model call, and a rebuild after a tool step or before an unanswered user message continues under the turn's own user message. A loop-streak crop span is stored on that user message when the window holds it, else on the boundary.

**Recovery and resume.** A rebuild boundary is not a resumable user: `recovery` offers the newest user message that is not a rebuild boundary when only rebuild boundaries follow it, so a rebuild after a finished turn offers nothing and an unanswered user message carried by a boundary is offered and resumed as itself. An interrupted assistant message is offered only when nothing follows it, so one inside a rebuild tail is not offered: its context is no longer in the window. The resume admission checks do not count a rebuild boundary after the parent as a later user message, and a resume whose parent is the boundary itself is checked against the window.

**Closing reminder.** A tail that ends in a tool step gets the loop reminder (below). A tail that ends in a finished reply or a user message gets none: the next request is the user's. An empty tail (the watermark is the newest message) takes the reminder from the newest message.

**Checkpoint writer input.** The writer deliberately reads full-fidelity history: `buildLLMRequestPrefix` is called without `collapseCheckpointTail` for fork capture (`llm-request-prefix.ts`). Before this change it got the tail because the tail stayed in the window. `tryStartCheckpointWriter` now builds its message list as: the window up to and including the newest rebuild boundary, then the stored messages between that boundary's watermark and the boundary (the same tail as at insert time, unanswered user messages included) that the window does not already hold, in stream order, then the messages after the boundary. A legacy boundary's tail is already in the window, so nothing is added. Copied unanswered user messages therefore reach the writer twice, on the boundary and in the tail. This reproduces the list the writer saw before (boundary, tail, live messages), so `computeBoundary`, the fork:false delta and `last_checkpoint_message_id` behave as before.

**Mid-loop rebuild.** An automatic rebuild between steps of a tool loop finishes the current step first, so that step is the newest message and the last message of the tail; the digest lists its tool calls and marks tool parts that were still pending or running as interrupted, as today. Its tool outputs reach the model only through the digest, so the closing reminder for a tail that ends in a tool step tells the model that the outputs are not in context and that it can re-run a call.

### S2.5 Testing boundary

- Real sessions on the scripted test provider; no mocked services.
- A main session with the legacy `compaction.prune: true` opt-in, driven past the old prune conditions (cache cold, usage in the former level-2 band, large tool outputs older than two turns), keeps every `PartTable.data` identical to what the tool returned, and reasoning parts unchanged.
- A checkpoint rebuild leaves outputs after the boundary identical in the database.
- `history get` on any tool part returns the full stored output through paging.
- A legacy row with `time.compacted` still renders the cleared marker.
- Existing tests that assert prune or microcompact behavior are deleted together with the code they test; tests of `fireCheckpoints` and thresholds keep passing unchanged.
- After a rebuild in a session with a non-empty tail (assistant text, tool calls with large outputs, and a tail user message), the boundary message sorts after every tail message; the next request contains the boundary and no tail message, carries the tail user text through `Recent user input (verbatim)` and the tail tools through `# Recent activity`; a message sent after the rebuild is live in the following request.
- A legacy boundary fixture (boundary time = watermark + 1 ms) renders the same request as before, with its tail collapsed.
- A checkpoint writer started after such a rebuild receives the tail messages in full (tool outputs intact) between the boundary and the live messages.
- The memory paths reminder of the new context window is persisted on the boundary and appears in the first request after the rebuild.
- An automatic rebuild after a finished high-usage reply digests that reply and ends the turn without another model call.
- An automatic rebuild after a tool step digests that step (`digestUpTo` is the step), the next request contains only the boundary with the step's calls in `# Recent activity` and no tool output, and the reply to it belongs to the turn's user message and ends the turn.
- A rebuild whose tail ends in an unanswered user message (long text over the verbatim cap, an attached text file) and with a queued undelivered input: `digestUpTo` is the last assistant message; the boundary carries the full text and file content of the unanswered message, `Recent user input (verbatim)` does not quote it, and nothing of the queued input; the next request carries the full text in the boundary and the queued input as its own user message.
- A queued input left out of a rebuild and then cancelled appears in the next request after the boundary, and `recovery` offers it. An input cancelled before the rebuild is part of the tail and does not appear after the boundary. An input still queued across two rebuilds and cancelled after the second appears in the next request.
- After a rebuild of a finished turn `recovery` offers nothing; after a rebuild that carries an unanswered user message, `recovery` offers that message and resuming it answers under it.
- A tail that ends in a finished reply gets the same rebuild context as one that ends in a user message.

## [S3] Out of Scope

- Changing checkpoint thresholds, the overflow trigger ratio, or adding new window-switch triggers.
- Changing summary compaction, the checkpoint writer's prompt, or the format of the `# Recent activity` digest.
- Migrating or restoring outputs that were already cleared before this change.
- History index kinds (`history/extract.ts`).

## Tasks

- [x] T1: Remove turn-end prune, `stripNonEssential`, their interface members and the `prompt.ts` call site — acceptance: a regression test drives a main session whose config carries the legacy `compaction.prune: true` past the former prune conditions, fails on the base commit, and after the change asserts every tool part's stored output and every reasoning part equals what was originally stored and that the session still reaches the existing checkpoint threshold when usage crosses it (covers: S2.1, S2.2, S2.4, S2.5)
- [x] T2: Remove `SessionCompaction.prune`, its wrapper and interface member, and unreferenced prune constants — acceptance: `bun typecheck` passes in `packages/cli` with no remaining reference (covers: S2.2)
- [x] T3: Remove rebuild-time microcompact from `insertRebuildBoundary` — acceptance: a test inserts a rebuild boundary over a session with read/bash outputs after the watermark and asserts those parts are unchanged in the database (covers: S2.1, S2.2, S2.5)
- [x] T4: Remove `pressureLevel`, `contextPressureLevel`, `compaction.prune`, `MIMOCODE_DISABLE_PRUNE` and the flag-to-config code with docs — acceptance: a config containing `compaction.prune` loads with exactly one warning and no error; no reference to the flag or the key remains outside the warning; typecheck passes (covers: S2.2)
- [x] T5: Keep legacy `time.compacted` rows rendering — acceptance: a test with a pre-existing row carrying `time.compacted` still renders `[Old tool result content cleared]`, and `history get` returns the stored text (covers: S2.3, S2.5; depends: T1)
- [x] T6: Capture a golden fixture of the request rendered after a legacy rebuild boundary (boundary time = watermark + 1 ms, collapsed tail) before changing placement — acceptance: a committed test asserts the current rendered model messages for that fixture and passes on the base of this task (covers: S2.6)
- [x] T7: Place the rebuild boundary after the newest message, write `digestUpTo` for every non-empty tail, remove `boundaryCreatedAt`, and apply `collapseCheckpointTail` only to legacy boundaries — acceptance: the S2.5 rebuild test (boundary after every tail message; next request has no tail message, has the tail user text and tool digest; a later message is live) fails before the change and passes after; the T6 fixture still passes; the reminder test passes (covers: S2.4, S2.6; depends: T6)
- [x] T8: Feed the checkpoint writer the boundary's tail from the database — acceptance: a writer started after a T7 rebuild receives, in order, the boundary, every tail message with its full tool output, and the live messages; it fails before the change and passes after; existing writer, fork and threshold tests pass (covers: S2.6; depends: T7)
- [x] T9: Read the tail end from the database at insert time and read turn state through the restored tail — acceptance: the two automatic-rebuild tests of S2.5 (finished reply: three model calls, the reply digested; tool step: `digestUpTo` is the step, the next request is the boundary alone without tool output, the reply's parent is the turn's user message) fail before the change and pass after; the T6 fixture and the T7/T8 tests still pass (covers: S2.5, S2.6; depends: T8)
- [x] T10: Copy unanswered tail users onto the boundary, keep queued inputs out of the tail, treat rebuild boundaries as non-turns in recovery and resume, read turn text and crop anchors through the restored tail, drop the closing reminder after a finished reply — acceptance: the S2.5 tests for unanswered and queued input, for recovery and resume after a rebuild, and for the closing reminder fail before the change and pass after; the T6–T9 tests and the resume tests in `prompt-effect` still pass (covers: S2.5, S2.6; depends: T9)
- [x] T11: Record the queued inputs a rebuild leaves out as `deferredInputs`, place those that ended without delivery after the boundary, and keep interrupted assistants inside a rebuild tail out of `recovery` — acceptance: the S2.5 tests for an input cancelled after one rebuild, after two rebuilds and before the rebuild fail before the change and pass after; the T6–T10 tests still pass (covers: S2.5, S2.6; depends: T10)
