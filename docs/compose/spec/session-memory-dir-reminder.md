---
feature: session-memory-dir-reminder
status: delivered
updated: 2026-09-28
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2689
---

# Memory Paths Reminder

## Report

**What was built** — The per-user-message recall reminder and `SessionCheckpoint.hasMemoryOrTasks` are gone. The `# Memory system` block names the project memory file as `<memoryRoot>/projects/<project_id>/MEMORY.md` and the session directory as `<memoryRoot>/sessions/<session_id>`, and says the real paths are given in a system reminder. The system prompt contains no project or session id and no nonexistent path, so it is byte-identical across projects and sessions.

The runLoop persists one memory paths reminder per context window, for main/peer actors only (`servesCheckpoint`), carrying the real project MEMORY.md path and session directory. It lands on the session's first user message, or on the boundary message after a checkpoint rebuild or compaction. Fork copies and sessions that predate the change get it on their next new user message. Messages already sent to the model are never rewritten.

**Verification** — `bun typecheck` (packages/cli): PASS. CI shard commands from `.github/workflows/test.yml` run locally: shards 1–3 PASS (1476, 1517, 1529 pass; 0 fail); shard 4 first run had one 30 s timeout in `turn-queue-admission.test.ts` ("late-admitted user format replace …") that passed 3/3 when its file ran alone, and a full shard 4 rerun PASSED (1561 pass, 0 fail). Dev run (`bun dev run` against a local capture server, two separate git projects): both main requests carried byte-identical system prompts, and each project's first user message carried its own project MEMORY.md path and session directory. Independent review: two rounds on the session directory reminder; all findings fixed, none open.

**Journey log**

1. Putting the real session id into `buildMemoryInstructions` was rejected: the literal placeholder dates from #2258 (c9c4ff4330, 576b5c12fd), which keeps the system prompt identical across sessions for cross-session prefix caching. The project id was moved out for the same reason across projects.
2. Matching any synthetic part containing the directory is wrong: the checkpoint rebuild boundary text contains `File: <dir>/checkpoint.md`. Only this session's own marker counts.
3. "Has a reply with this parentID" does not mean "already sent": batched and mid-turn inputs never become a `parentID`. Any later non-summary assistant message is the test.
4. `Session.fork` rewrites copied messages' `sessionID`, so copied history looks like the session's own; it is detected as already sent instead.
5. Codex keeps thread ids out of prompt text entirely (environment context is a user-role item appended on change; ids reach only `prompt_cache_key` and shell env vars); per-value state that differs between sessions belongs after the shared prefix, never inside it.

## [S1] Problem

Every runLoop turn persisted a recall reminder ("This session has memory at <dir>/. Recall content not in your context with: …") on the latest user message. Its tool hints and closing "Don't ask the user…" line duplicate the `# Memory system` block that `buildMemoryInstructions` already puts in the system prompt, and since the persist-once change every user message keeps its own permanent copy, so long sessions accumulate one copy per message.

The only fact the reminder carried that the system prompt lacks is the real session memory directory. The system prompt writes the session segment as the literal `current_session_id`, which no code resolves, so `<data>/memory/sessions/current_session_id/notes.md` is a nonexistent path.

The system prompt must not carry per-session or per-project values (PR #2258): it stays byte-identical so the provider prefix cache is shared across sessions, and a project id in the memory block makes the prefix diverge between projects at the memory block's first line.

## [S2] Design

### Recall reminder removed

`recallHintLines`, `RECALL_REMINDER_MARKER`, `buildRecallReminderText`, the runLoop injection block and `SessionCheckpoint.hasMemoryOrTasks` (its only caller) are deleted. `hasSyntheticReminder`, `ensurePersistedUserSynthetic`, the loop-streak reminder and the compose reminder are unchanged. Recall reminder parts already persisted in old sessions stay as they are; no data migration.

### System prompt carries no project or session id

`buildMemoryInstructions(memoryRoot)` writes the project memory file as `<memoryRoot>/projects/<project_id>/MEMORY.md` and the session directory as `<memoryRoot>/sessions/<session_id>` (notes.md, checkpoint.md, tasks/<id>/progress.md), and adds one sentence: `<project_id>` and `<session_id>` stand for the current project and session, their real paths are given in a system reminder in the conversation history, and tool calls use those real paths. The block is byte-identical across projects and sessions. `buildSystemArray` still resolves the project id for the `migrateProjectMemory` bootstrap.

### Memory paths reminder: once per context window

Exported from `session/prompt.ts`:

- `SESSION_MEMORY_DIR_MARKER = "Current session memory directory:"`
- `buildMemoryPathsReminderText({ projectMemoryFile, sessionDir })` →

  ```
  <system-reminder>
  Memory paths for this conversation — the real values of `<project_id>` and `<session_id>` in the Memory system instructions:
  - Project memory: <projectMemoryFile>
  - Current session memory directory: <sessionDir>/
  </system-reminder>
  ```

- `memoryPathsReminderTarget({ msgs, sessionID, dir })` → the user message to receive the reminder, or `undefined`:
  1. If any visible user message has a non-ignored synthetic text part containing `` `${SESSION_MEMORY_DIR_MARKER} ${dir}/` ``, return `undefined`. Only this session's own reminder counts; the rebuild boundary's `File: <dir>/checkpoint.md` line, legacy recall parts and a parent's reminder in copied fork history do not. The project of a session never changes, so the session directory line alone identifies the reminder.
  2. A user message is *sent* when any assistant message other than a compaction summary (`summary: true`) follows it in `msgs`. Position is the test because batched or mid-turn delivered inputs reach the model but never become a reply's `parentID`. A sent message went out without the reminder, and rewriting sent history would invalidate the cached prefix.
  3. Among visible user messages with `info.sessionID === sessionID` (so `contextFrom` parent messages are never written), return the first if it is unsent; otherwise the last if it is unsent; otherwise `undefined`.

`msgs` is the runLoop history from `MessageV2.filterCompactedEffect`, which starts at the latest checkpoint/compaction boundary. The first own user message is the session's first message before any rebuild and the boundary user message after each rebuild (unsent until the first request after the boundary), so normally the reminder sits at the head of each context window. Fork copies and sessions that predate the reminder have a sent first message; they receive it on the next new user message. One copy per context window, attached before the first request that contains the target message.

runLoop calls it each step where the recall block used to be, only when `actorRegistry.servesCheckpoint(sessionID, lastUser.agentID)` is true (the same actors that receive the `# Memory system` block), with `dir = metaDir(sessionID)` and `projectMemoryFile = memoryPath((yield* InstanceState.context).project.id)` — the same helpers checkpoint restore and the writer use — and persists via `ensurePersistedUserSynthetic` using marker `` `${SESSION_MEMORY_DIR_MARKER} ${dir}/` ``.

### Spec update

`docs/compose/spec/synthetic-parts-persistence-cache.md` and `docs/compose/spec/memory-prompt-decouple.md` describe the recall reminder as removed and the memory paths reminder as the persisted synthetic.

## [S3] Out of Scope

- Rewriting or deleting recall reminder parts already stored in old sessions.
- Translating `<project_id>` / `<session_id>` inside tools.
- The duplicated "Don't ask the user about something memory may already record." sentences inside `buildMemoryInstructions`.

## Tasks

- [x] T1: Delete the recall reminder code, `hasMemoryOrTasks`, and the recall-only tests; move retained marker/helper tests to `test/session/synthetic-reminder.test.ts` — acceptance: no references to the removed symbols remain under `packages/cli`; retained helper tests pass (covers: S2)
- [x] T2: `buildMemoryInstructions` uses `<project_id>` and `<session_id>` with the explanatory sentence — acceptance: llm-system-prompt test asserts the placeholder paths are present and none of `current_session_id`, the real session id or the real project id appears in the system prompt (covers: S2)
- [x] T3: Add the memory paths reminder helpers and runLoop injection — acceptance: unit tests cover rules 1–3 (checkpoint rebuild boundary naming the directory, compaction boundary with summary reply, fork copy with the parent's reminder, sent first message, batched input that is never a parentID, contextFrom history); integration test shows a multi-step turn persists exactly one reminder carrying the real project memory file and session directory on the first user message, a second user turn adds none, and every request carries it; existing tests that pin exact user parts tolerate the reminder (covers: S2; depends: T1)
- [x] T4: Update `synthetic-parts-persistence-cache.md` and `memory-prompt-decouple.md` to the current state — acceptance: no claim that a recall reminder is injected; helper names match the code (covers: S2)
