---
feature: edit-diff-untrimmed
status: delivered
updated: 2026-11-03
source: fix/edit-diff-untrimmed
---

# Edit Tool Diffs Are Applyable Patches

## Report

**What was built** — `edit`, `write`, `apply_patch` and `notebook-edit` now publish untrimmed `createTwoFilesPatch` output in `metadata.diff`, `filediff.patch`, `files[].patch` and permission-request metadata, so every published diff applies to the file's previous content and yields the bytes on disk. `trimDiff` moved to `src/util/trim-diff.ts` as a display-only helper that trims each `Index:` section independently; the TUI edit block, apply_patch block and its collapse check, the edit permission prompt and the `run` edit block call it at render time, so terminal output is unchanged. `write` recomputes its diff from the file after formatting (the permission prompt still previews the requested content). `edit` with an empty `old_string` diffs against the existing file's content using raw line endings, recomputes after formatting, and rejects directories with the replace branch's error. Side effect: ACP's permission handling, which applies `metadata.diff` to the file, now succeeds on edits inside indented blocks.

**Verification** — `bun run typecheck` (repo root) PASS, 0 errors. `cd packages/cli && bun test --timeout 30000 test/tool test/util test/permission test/cli test/acp test/patch` PASS: 1661 pass / 9 skip / 0 fail across 157 files. Regression proof is RED→GREEN: `test/tool/applyable-diff.test.ts` failed 8 of 9 cases on the original implementation (`applyPatch` returned `false` on trimmed hunks; write's diff missed the formatter's rewrite; empty-`old_string` overwrite published a `@@ -0,0` new-file patch), and the CRLF overwrite case added in review failed before its fix; all 11 cases pass now. `oxlint` on the new files: 0 warnings. Independent review: one IMPORTANT finding (CRLF overwrite) and minor items were fixed and re-reviewed with no remaining critical or important findings.

## [S1] Problem

File-editing tools publish a unified diff in their result metadata (`metadata.diff`, plus `filediff.patch` / `files[].patch` where present). Downstreams treat that diff as data: Mimo Desktop reverses it with `git apply --reverse` to undo a turn, and reverse-applies the per-step stack against the file on disk to rebuild a turn's review diff and its `+a −b` counts. Three defects make the published diff disagree with what actually happened to the file:

1. **Indentation is stripped.** Every tool runs the patch through `trimDiff`, which removes the common leading whitespace of all hunk lines so the TUI renders compactly. Whenever the changed lines and their context window all sit inside an indented block (a function body, a nested JSON/YAML key — the common case), the hunk lines no longer match the file and the patch cannot be applied in either direction. Desktop undo currently compensates with an indentation-restoring heuristic; Desktop review has no compensation, so any turn that edits one file twice inside an indented block falls back to `git diff HEAD` and shows other turns' and the user's uncommitted changes as if they belonged to this turn.
2. **`write` computes its diff before formatting.** The diff is built from the model-supplied content, then the formatter rewrites the file. When a formatter changes anything, the diff's new side is not the file on disk.
3. **`edit` with an empty `old_string` ignores existing content.** The branch overwrites the whole file but diffs against `""`, so an overwrite of an existing file is published as a new-file patch (`@@ -0,0 +1,N @@`), and the diff is computed before formatting. Desktop classifies new-file-shaped patches as "created this turn" and undoes them by deleting the file, so this shape is a data-loss hazard.

Upstream opencode v1 has the same `trimDiff` defect, reported several times (#31625 "expose an applyable patch", #37266/#37265 ACP preview losing the diff); none of those were merged. Upstream v2 resolved it by publishing untrimmed `createTwoFilesPatch(before, after)` computed from the formatted file (`packages/core/src/tool/plugin/file-diff.ts`).

## [S2] Design

### S2.1 Data contract: published diffs are applyable

For `edit`, `write`, `apply_patch` and `notebook-edit`, every diff string written to tool metadata or to permission-request metadata is the untrimmed output of `createTwoFilesPatch(path, path, before, after)`. Applying it to `before` with jsdiff `applyPatch` (default `fuzzFactor: 0`) yields `after`. This covers `metadata.diff`, `metadata.filediff.patch` and `metadata.files[].patch`. The metadata field names and shapes do not change.

### S2.2 Display-time trimming

`trimDiff` becomes a presentation helper in `src/util/trim-diff.ts` and is no longer called by any tool. It trims each file section of a patch independently (sections start at an `Index: ` line, the header `createTwoFilesPatch` emits), so a multi-file permission diff renders exactly as the per-file trimmed diffs did before. A single-file patch trims exactly as before.

Renderers apply it where they show a diff to a person, keeping terminal output unchanged:

- TUI edit tool block (`metadata.diff`).
- TUI apply_patch per-file block (`files[].patch`), including the long-line collapse check, which measures the trimmed text as it did before.
- TUI edit permission prompt (`metadata.diff`).
- `run` command edit block.

### S2.3 `write` diff reflects the file on disk

`write` keeps computing a preview diff from the requested content for the permission prompt. After writing and formatting, it re-reads the file and recomputes `metadata.diff` from `contentOld` to the re-read content, matching what `edit` already does.

### S2.4 `edit` with an empty `old_string`

When the target exists, `contentOld` is its current content; a directory is rejected with the same `Path is a directory` error as the replace branch. The branch writes `new_string` verbatim, so its diffs use the raw strings without line-ending normalization, keeping a CRLF→LF overwrite visible and applyable. After writing and formatting, the file is re-read and `metadata.diff` and `filediff` are computed from `contentOld` to the re-read content. When the target does not exist, `contentOld` stays `""` and the diff remains a new-file patch.

### S2.5 Testing boundary

Tool tests assert the contract through public tool execution: for each tool, an edit inside a deeply indented block publishes a diff that `applyPatch(before, diff)` turns into the file's final content. `write` and `edit` are additionally exercised with a configured formatter that rewrites the file, and `edit` with an empty `old_string` on an existing file. The display helper is unit-tested for single-file parity and per-section trimming.

## [S3] Out of Scope

- `apply_patch` also computes its diff before formatting. It is not changed here: its diff is built before the permission prompt and before any file is written, and fixing it means restructuring the multi-file commit path. Applyability against the pre-format result is still guaranteed.
- `write` takes no per-file lock, unlike `edit`; a concurrent change landing between its format step and the re-read would appear in its diff. Pre-existing and unchanged here.
- Mimo Desktop changes (dropping its indentation-restore heuristic, review falling back to Git when every step diff has no hunks, tolerating trimmed diffs in already-recorded sessions). Sessions recorded before this change keep their trimmed diffs.
- Changing the metadata schema or adding a second patch field.

## Tasks
- [x] T1: Regression tests for the data contract — acceptance: new tests for edit, write, apply_patch and notebook-edit editing inside an indented block assert `applyPatch(before, metadata diff) === final content`, plus write/edit with a rewriting formatter and edit with an empty `old_string` on an existing file; they fail on the current implementation for the intended reason (covers: S2.1, S2.3, S2.4, S2.5)
- [x] T2: Move `trimDiff` to a display helper with per-section trimming — acceptance: unit tests show single-file output identical to the old function and multi-file sections trimmed independently (covers: S2.2)
- [x] T3: Tools publish untrimmed diffs; write and empty-`old_string` edit compute from the formatted file — acceptance: T1 is green and existing tool tests stay green (covers: S2.1, S2.3, S2.4; depends: T1, T2)
- [x] T4: Renderers trim at display time — acceptance: TUI edit block, apply_patch block and collapse check, edit permission prompt, and `run` edit block pass their diff through `trimDiff`; typecheck passes (covers: S2.2; depends: T2)
- [x] T5: Verify — acceptance: repo typecheck and the tool, permission and CLI test suites pass, with each command's result recorded (depends: T3, T4)

## Journey log

1. The defect surfaced in Mimo Desktop: its per-turn review rebuilds a file's turn diff by reverse-applying each step's `metadata.diff` against disk. A two-edit reproduction inside a function body showed the rebuild succeeding with untrimmed patches and failing with `trimDiff` output, after which review silently fell back to `git diff HEAD`. Desktop undo had already hit the same wall and grown an indentation-restoring heuristic, which pointed at the engine data contract rather than another consumer-side patch.
2. Upstream opencode v1 carries the same `trimDiff` and the same class of breakage: #31625 asked for an applyable patch beside the display diff, #37266 traced lost ACP permission previews to `applyPatch` failing on trimmed hunks, and #37265 / #31783 proposed consumer-side workarounds. None merged; all were closed by the stale bot. Upstream v2 (`packages/core/src/tool/plugin/file-diff.ts`) drops trimming and computes the patch from the formatted file, which is the contract adopted here. Adding a second `patch` field (the #31625 shape) was rejected because it stores the same change twice and leaves consumers choosing between two sources.
3. Review caught a regression introduced by this change: the empty-`old_string` branch had been made to normalize line endings like the replace branch, but it writes `new_string` verbatim, so a CRLF→LF overwrite vanished from the diff. jsdiff `applyPatch` auto-converts line endings, so normalized diffs stay applyable only when the tool preserves the file's original endings; this branch now diffs raw strings.
