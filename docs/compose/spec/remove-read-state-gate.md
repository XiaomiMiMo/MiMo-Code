---
feature: remove-read-state-gate
status: delivered
updated: 2026-09-14
branch: feat/remove-read-state-gate
commits: e485a2a5e096a077e381e6df56c332d8150629ae..HEAD
---

# Remove Read-before-Edit Hard Gate

## Report

**What was built** — Removed the session-wide `assertFileRead` hard gate from `edit` and `notebook-edit`. `read-state.ts` is deleted; tool descriptions no longer claim a recoverable failure when a path was not opened via the `read` tool. `edit`, `write`, and `notebook-edit` descriptions now advise reading first so content matches disk, which the tools still load at apply time. Permission and path guards (`assertWriteAllowed`, `askEditUnlessMemory`, memory path guard) are unchanged. Compaction guidance to re-read after context loss remains.

**Verification** — From `packages/cli` in the worktree:
- `bun typecheck` — PASS (`tsgo --noEmit` clean)
- `bun test test/tool/edit.test.ts` — PASS, including no-prior-read, write-then-edit, and edit-create-then-edit cases
- `bun test test/tool/notebook-edit.test.ts` — PASS, notebook_edit replace without prior read
- `bun test test/tool/write.test.ts` / `memory-edit-ask-skip.test.ts` — PASS
- Production grep for `assertFileRead` / `tool/read-state` under `packages/cli/src` — clean
- Fresh reviewer subagent (impl): PASS, no CRITICAL
- Second reviewer (self-write / notebook coverage): PASS; four post-gate behaviors locked by real tool tests; gate-return would re-fail them

**Journey log** —
1. The gate was introduced in `cb633947` (PR #1243) to turn edit.txt usage notes into RecoverableError enforcement for existing-file edits.
2. Enforcement never covered `write`/`apply_patch`; `write.txt` still claimed hard failure that the tool never implemented — docs were ahead of code.
3. Real agent friction (bash-as-read, main-worktree read + linked-worktree edit absolute-path mismatch, self-written files not counting as read) made the gate a turn tax without protecting integrity: `edit` still exact-matches current disk contents.
4. Impact surface was small: two call sites, one 44-line module, three tool .txt lines, one prompt phrase, and no dedicated unit tests for the gate itself.
5. This session's own Edit tool still enforced the desktop read-before-edit rule when patching worktree `.txt` files after only reading main-worktree copies — the path-mismatch problem reproduced live during implementation.
6. Confirmed on base `e485a2a5`: `read-state.ts` only matches `part.tool === "read"`; `write.ts` and the create branch of `edit` never record a read. Self-write → later edit is a guaranteed false negative.

## [S1] Problem

`assertFileRead` forces `edit` / `notebook-edit` to fail unless the exact file path was previously opened with the `read` tool in the same conversation. Real agent workflows no longer match that contract:

1. Models increasingly inspect files via bash (`cat` / `sed` / `python`), which never records a `read` tool part, so the subsequent `edit` fails with a recoverable error and burns a turn.
2. Agents that read a path in the main worktree and then edit the same logical file inside their own worktree hit a path mismatch — `canon()` compares absolute paths, so the gate rejects a legitimate edit.
3. Compaction / history loss can drop the original `read` parts, re-triggering the gate on a file the model has already seen.
4. Self-authored files never count as read. `assertFileRead` only accepts completed `tool === "read"` parts; neither `write` nor `edit` (including `old_string=""` create) synthesizes a read-state entry. So `write` then `edit`, or multiedit's create-then-patch sequence on the same path, still trips the gate on the second step — even though the model just produced that content.

The gate does not protect file integrity: `edit` still loads current disk contents and exact-matches `old_string` before writing. `write` documents the same rule but never enforces it; `apply_patch` has no gate. The hard check is inconsistent, easy to bypass via bash, and hostile to worktree workflows.

## [S2] Design

Remove the hard gate entirely.

- Delete `packages/cli/src/tool/read-state.ts`.
- Drop `assertFileRead` from `edit` (including the create-file exemption comment) and `notebook-edit`.
- Soften tool descriptions (`edit`, `write`, `notebook-edit`) to advisory language: prefer reading the file first so edits match current contents; no claim of hard failure. Softening `write.txt` is required because that text promised enforcement the tool never had.
- Leave compaction guidance ("re-read any file you need before editing") — that is about context loss, not tool enforcement.
- Drop the "read-state tracking" claim from `default.txt` tool-layer benefits.

Permission / path guards (`assertWriteAllowed`, `askEditUnlessMemory`, memory path guard) stay unchanged.

## [S3] Out of Scope

- Expanding bash outputs into a synthetic read-state.
- Making `write` enforce a read gate.
- Changing exact-string match, fuzzy-edit flag, or apply_patch behavior.
- Compaction message rewording beyond what is needed for accuracy.

## Tasks
- [x] T1: Remove assertFileRead call sites from edit and notebook-edit — acceptance: both tools edit existing files without a prior `read` tool call in the session (covers: S2)
- [x] T2: Delete read-state module and fix leftover references — acceptance: no production import of `assertFileRead` / `read-state` remains; tool .txt files no longer promise a hard failure (covers: S2)
- [x] T3: Verify with typecheck + focused tool tests — acceptance: `bun typecheck` passes from `packages/cli`; edit tests still pass (covers: S2; depends: T1, T2)
