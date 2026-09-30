---
feature: memory-prompt-decouple
status: delivered
updated: 2026-09-14
branch: feat/memory-prompt-decouple
commits: e485a2a..9780b2e
---

# Memory Prompt Decouple From Checkpoint

## Report

**What was built** — `# Memory system` is now always injected for main/peer
actors. `MIMOCODE_DISABLE_CHECKPOINT` only filters checkpoint-write subsections
(checkpoint.md / task progress paths, writer-as-curator, Active recall,
Four-vs-Two wording). Project MEMORY.md, global MEMORY.md, notes.md scratchpad,
subagent return format, and search-first rules stay on so embedders that close
checkpoint (e.g. Desktop) still teach the model where memory lives.

**Verification** —
- `bun run typecheck` from `packages/cli` — PASS
- `bun test test/session/llm-system-prompt.test.ts test/tool/checkpoint-tool-description.test.ts test/flag/disable-checkpoint-flag.test.ts test/session/prune.test.ts` — PASS (30 pass / 0 fail; llm-system-prompt 6/6)

**Journey log**
- Desktop sets `MIMOCODE_DISABLE_CHECKPOINT=1` for checkpoint bugs; engine previously dropped the whole memory system prompt with that flag — wrong coupling.
- Existing test `MIMOCODE_DISABLE_CHECKPOINT=true — memory instructions are not appended` encoded the old coupling; inverted to core-on + ckpt-extras-off.
- Flag-on test must not assert absence of the string `checkpoint-writer` — base `agent.prompt` mentions that agent name; assert memory-system-specific copy instead.
- `memory.disable_write` remains a separate write kill-switch; this change does not couple prompts to it.
- After engine-pin bump Desktop gets memory paths while keeping checkpoint off; do not also copy `# Memory system` into `desktop-base`.

## [S1] Problem

`# Memory system` is injected by `buildSystemArray` only when
`servesCheckpoint && !Flag.MIMOCODE_DISABLE_CHECKPOINT`
(`packages/cli/src/session/llm.ts`). Desktop embeds the engine with
`MIMOCODE_DISABLE_CHECKPOINT=1` because checkpoint had production bugs, so the
entire memory write/read contract disappears from the model: no MEMORY.md /
notes.md / global paths, no when-to-write rules, no search-first reflex.

Memory itself is a file system + FTS + `memory` tool. Checkpoint is one
*writer* of those files. Coupling the prompt to the checkpoint flag is wrong:
closing checkpoint for writer/rebuild bugs must not erase memory ownership
paths.

## [S2] Design

**Contract:** for main/peer actors (`servesCheckpoint`), `# Memory system` is
always injected. `MIMOCODE_DISABLE_CHECKPOINT` only toggles the *checkpoint
write* subsections inside that block, not the block itself.

| Content | Always | Gated by `MIMOCODE_DISABLE_CHECKPOINT` |
|---|---|---|
| `# Memory system` heading + file-type list | yes | |
| Project `MEMORY.md` path + when agent may Edit | yes | |
| Global `MEMORY.md` path | yes | |
| Session `notes.md` scratchpad path + format | yes | |
| Subagent return format | yes | |
| What NOT to do: no ad-hoc memory files; search before asking user | yes | |
| Session `checkpoint.md` / `tasks/<id>/progress.md` paths | | yes |
| "writer is sole curator; agent does not maintain mid-task" | | yes |
| MEMORY.md edit is exception vs norm wording | | yes |
| "Don't Edit checkpoint.md" | | yes |
| Active recall protocol (rebuild dumps in context) | | yes |
| File-type count wording "Four" vs "Two" | derived from flag | |

**Implementation choke points:**

1. `session/llm.ts` `buildSystemArray` — injection `if` is `servesCheckpoint`
   only; `buildMemoryInstructions(projectID, memoryRoot)` internal
   `checkpointEnabled` splits ckpt extras.
2. `buildMemoryInstructions` / injection-site comments state always-on for
   main/peer; flag only narrows content.
3. `tool/checkpoint-description.ts` — unchanged. Base `memory.txt` stays;
   only `memory.checkpoint.txt` extra stays gated.
4. Session recall reminder (`session/prompt.ts` `hasMemoryOrTasks`) — already
   independent of the checkpoint flag; no change.
5. `memory.disable_write` remains the write switch (separate axis); this
   feature does not couple prompts to it.

**Tests (engine):** `llm-system-prompt.test.ts` flag-on case asserts core
memory present (`# Memory system`, MEMORY.md paths, Notes scratchpad, Subagent
return format, When to Edit, search-first) and ckpt extras absent (Active
recall, sole curator, Session checkpoint, session checkpoint.md path). Default
on path still expects Active recall + writer ownership. system-spawned actors
still receive no memory block.

## [S3] Out of Scope

- Re-enabling desktop checkpoint / fixing historical checkpoint bugs.
- Changing `memory.disable_write` semantics or memory-path-guard.
- Injecting memory system into system-spawned writers (they must keep using
  checkpoint task paths).
- Desktop prompt assets (`desktop-base`) — engine supplies the block after pin
  bump; desktop should not duplicate it.

## Tasks

- [x] T1: `llm.ts` always inject `# Memory system` when `servesCheckpoint`; flag only filters ckpt extras — acceptance: with `MIMOCODE_DISABLE_CHECKPOINT=true`, main-agent system contains `# Memory system` + project MEMORY.md + notes.md and omits checkpoint-writer ownership / Active recall (covers: S2)
- [x] T2: Update `buildMemoryInstructions` comments to match always-on contract — acceptance: comments no longer claim the whole block is skipped when checkpoint is off (covers: S2; depends: T1)
- [x] T3: Invert/extend `llm-system-prompt.test.ts` for flag-on vs flag-off content split — acceptance: tests cover always-on core + ckpt-gated extras + system-spawned exclusion; suite green (covers: S2; depends: T1)
- [x] T4: `bun typecheck` + `bun test packages/cli/test/session/llm-system-prompt.test.ts` from worktree — acceptance: typecheck clean; target tests pass (covers: S2; depends: T3)
