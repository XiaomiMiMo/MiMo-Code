---
feature: exec-tool-view
status: delivered
updated: 2026-07-27
branch: feat/exec-tool-view
commits: 47c8425f..6479a56b
---

# exec Tool View (bash-style collapse)

## Report

**What was built** — `exec` (the parallel tool-call script tool) now renders like `bash`. Once `input.code` has streamed in, the part lives in a `BlockTool` for the rest of its life; collapsing caps the script and its output at a 10-row budget with a `…` marker instead of compressing everything into a one-line summary. Expanding shows both in full. The click handler and the expand/collapse hint appear only when something actually overflows, so a short script with short output is a static block — the same rule `bash` uses.

The budget counts *rendered* rows, not source lines. The first cut of this change counted source lines and bounded nothing: `exec` returns JSON, one line of it wraps to dozens of terminal rows, and the collapsed block still filled the screen. Estimation and clipping now live in `packages/opencode/src/cli/cmd/tui/util/collapse.ts` and are shared with `Bash`, which had the same latent defect for long single-line output. Height is measured in display cells (`Bun.stringWidth`, plus one cell per tab), so CJK and emoji count double; a line straddling the budget is sliced on the cell budget without splitting a wide character, so a single 4000-char line still shows its head.

The pre-execution state keeps the single `InlineTool` pending line (`~ Writing script...`). Because that branch is only reachable while `code` is still empty, its failure color, spinner and summary children were unreachable and were removed; `InlineTool`'s `iconColor` prop lost its last user and was deleted. `exec` output now passes through `stripAnsi` like bash's, since nested `bash` calls put raw escape sequences into `<return_value>` / `<logs>`.

On the backend, `exec` re-publishes the per-tool `counts` map in its terminal metadata. `SessionProcessor.completeToolCall` (`packages/opencode/src/session/processor.ts:359`) *replaces* part metadata rather than merging it, so the live breakdown streamed through `ctx.metadata` used to vanish the moment a run finished and the summary degraded to `12 calls`.

**Verification**

- `cd packages/opencode && bun typecheck` — PASS (clean), re-run after the display-cell rework.
- `cd packages/opencode && bun test test/cli/tui/collapse.test.ts` — PASS, 16 pass / 0 fail (row estimation, clipping, CJK/emoji/tab widths, a budget invariant across grapheme classes, and the over-wide-cluster guard — verified to go red when the guard is removed).
- `cd packages/opencode && bun test test/tool/tool-script.test.ts` — PASS, 42 pass / 0 fail.
- `cd packages/opencode && bun test test/tool test/cli/tui` — PASS, 874 pass / 10 skip / 0 fail.
- Independent subagent review of `47c8425f..b5dbe888`: both acceptance criteria met, no critical findings. Two of its three minor findings were fixed in `1e463724` (dead pending-branch props, missing `stripAnsi`); the third (`clip()` being a plain function rather than a memo) was rejected — reads of `expanded()` inside JSX children are tracked by the render effect. A second review covered the row-budget and display-cell work and found one CRITICAL — a per-code-point width walk under-charged variation-selector emoji and clipped ~2x the budget — fixed by segmenting graphemes (`36372846`), plus a scrollbox-chrome under-reservation. Its re-review passed after fuzzing the budget invariant over regional indicators, skin tones, combining marks and Hangul jamo; two residual nits were fixed in `6e23a566`. A third review covered that residual fix and found the new guard test was not exercising the guard (its budget equalled the cluster width) — tightened in `6479a56b`.
- Not covered: there is no render harness for the components in `routes/session/index.tsx`, so wiring (which memo feeds which `<text>`) was reviewed by reading, not asserted. The row math itself is unit-tested. `exec` is gated to GPT-toolset models (`registry.ts:379-381`), so no live TUI run was performed; both display defects were reported from user screenshots, not caught by a test.

**Journey log**

- A source-line collapse budget is meaningless for tools whose output can be one enormous line. `exec` returns JSON via `JSON.stringify(parsed, null, 2)`, but each *string value* inside it (a nested `bash` stdout, a `grep` result set) keeps its `\n` escaped, so 40 rows of text arrive as one source line. Budget rendered rows for anything block-shaped.
- `Bun.stringWidth` returns **0** for a tab (and for a newline) — found via `component/prompt/offset.ts`, which special-cases both to stay aligned with `@opentui`'s editor offsets. Any width math over raw tool output has to handle tabs explicitly.
- `Bun.stringWidth` is also **not additive over code points**: `"❤️"` is 2 as a unit but 1 + 0 when summed per code point. The second review caught this as a real overshoot of the row budget; per-character width walks must segment by grapheme cluster.
- `ctx.width` (`contentWidth`, `routes/session/index.tsx:244`) subtracts the conversation box padding but not the transcript scrollbox's viewport padding or its always-visible scrollbar, so it over-states usable text columns by ~3 cells for any exact-width math.

- The spec's original §S2 rule — leave the two pre-execution error returns without `counts` — did not survive contact with the type system: `Tool.define` infers metadata as the union of `execute`'s return literals, and `bun typecheck` covers `test/`, so a non-uniform union makes `result.metadata.counts` inaccessible in tests. All five terminal returns now carry `counts` (empty map for the pre-execution pair, behaviorally identical). §S2 records the delivered rule.
- Hoisting `trace` above the code-size guard so `tally()` could be shared briefly left a duplicated `const trace` declaration; caught by grepping declarations, not by the first typecheck pass.
- Anything streamed via `ctx.metadata` must be re-emitted in every terminal return or it is lost on completion — a general trap for future live-progress tools.

## [S1] Problem

The `exec` tool (parallel tool-call script, `packages/opencode/src/tool/tool-script.ts`, tool id `exec`) renders in the TUI through `ToolScript` (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2292-2345`) as a binary toggle:

- Collapsed (default): a single `InlineTool` line — `» exec 12 calls · read×7 grep×4`. Neither the script nor its output is visible.
- Expanded: a `BlockTool` dumping the full `input.code` and the full `props.output` with no truncation at all.

Every other block-shaped tool — `bash` above all (`index.tsx:2922-2987`) — treats collapse as *overflow protection*, not as compression to one line: the command is always visible, and the first 10 output lines leak through with a `…` marker. `exec` is the odd one out, so a batch of parallel tool calls is either invisible or floods the transcript.

A second, smaller defect: per-tool counts are streamed live through `ctx.metadata` (`tool-script.ts:411-419`) but the terminal metadata returned by `execute` is only `{ status, toolCalls }` (`tool-script.ts:549,568,575`). `SessionProcessor.completeToolCall` **replaces** part metadata rather than merging it (`packages/opencode/src/session/processor.ts:359`), so the moment a run finishes the breakdown disappears and the summary degrades to `12 calls`.

## [S2] Design

### Collapsed/expanded behavior (TUI)

Restructure `ToolScript` to mirror `Bash`:

- Shape selection is a `<Switch>` on whether script source has arrived. With no `input.code` yet, keep the existing single `InlineTool` pending line (`~ Writing script...`). Once `input.code` is a non-empty string, render `BlockTool` for the rest of the part's life, with `spinner={isRunning()}` on the title.
- `BlockTool` title stays `# exec · <summary>`, where `summary` keeps its current composition (`N calls · read×7 grep×4(1!)`, prefixed with the failure status when the run did not complete).
- Body, in order:
  1. script source — clipped to a 10-**rendered-row** budget when collapsed with a `…` marker; full source when expanded;
  2. output — the `props.output` string with ANSI stripped (nested `bash` calls embed escape sequences), clipped to the same 10-row budget when collapsed, full when expanded. The XML envelope (`<exec status=…>`, `<return_value>`, `<logs>`, `<trace>`) is displayed verbatim, exactly as `bash` shows raw stdout. Coloured `theme.error` when the run failed.
  3. hint line `Click to expand` / `Click to collapse`, rendered only when at least one of the two blocks overflows.
- `onClick` is wired only when something overflows, so a short script with short output is a static, non-hoverable block (bash parity, `index.tsx:2967`).
- The budget counts **rendered rows, not source lines**: `exec` returns JSON, and one line of it wraps to dozens of terminal rows, so a source-line budget does not bound the collapsed height at all. Per-line height is `ceil(width(line) / columns)` where `width` is `Bun.stringWidth` plus one cell per tab (`Bun.stringWidth` reports 0 for tabs, and the real tab stop in a static `<text>` is unverified) — so CJK and emoji count as two cells. `columns` comes from `ctx.width` minus the transcript scrollbox chrome and the block's border and padding. A line straddling the budget is sliced on the cell budget, dropping whole grapheme clusters, so a single huge line still shows its head instead of collapsing to a bare `…`.
- Slicing walks **grapheme clusters** (`Intl.Segmenter`), not code points: `Bun.stringWidth` is not additive over code points — `"❤️"` (U+2764 U+FE0F) measures 2 as a unit but 1 + 0 summed — so a per-code-point walk under-charges emoji-presentation sequences and overshoots the budget.
- The prompt editor has its own width translation at `component/prompt/offset.ts` (tab = 2, newline = 1) because it must match `@opentui`'s *editor* offsets. That is a different coordinate system and is deliberately not shared with `Collapse`.
- **Known limitation (accepted, follow-up):** the height estimate assumes character wrapping, but `<text>` renders through `@opentui` `TextBufferRenderable` whose `wrapMode` defaults to `"word"`. A row therefore breaks early at a space and the leftover spills into an extra row, so the collapsed block can exceed the 10-row budget and the final sliced row looks ragged rather than full. The budget is an approximate ceiling, not a hard bound. Two fixes exist and both were declined for now: simulating greedy word wrap in `Collapse` (duplicates renderer internals) and forcing `wrapMode="char"` on these bodies (loses word-boundary readability elsewhere). The collapsed view is readable as-is.
- The row-budget helpers live in `packages/opencode/src/cli/cmd/tui/util/collapse.ts` (`lines`, `columns`, `rows`, `clip`) and are shared by `Bash` and `ToolScript` — bash has the same long-single-line defect. `hasLongDisplayLine` / `Write`'s line count reuse `Collapse.lines`.
- The pending branch is only reachable while `code` is empty, so it carries no failure color, spinner, or summary. `InlineTool`'s `iconColor` prop has no other user and is removed.

Not in this change: syntax highlighting for the script body, envelope parsing, live output streaming.

### Terminal metadata (backend)

`exec` keeps the per-tool breakdown after completion: the aggregation previously inlined in `publishProgress` is extracted into one host-side `tally()` helper (hoisted above the code-size guard together with `trace`), and the resulting `counts` map is included in **all five** terminal returns — code-too-large, transpile-error, failure, result-too-large, success. The two pre-execution returns emit an empty map, which is behaviorally identical to omitting the field (the TUI renders an empty `counts` as no breakdown) but keeps the inferred metadata union uniform so `metadata.counts` stays accessible to typed consumers, including tests.

`running: true` is not part of terminal metadata; the TUI derives running state from `part.state.status`.

## [S3] Out of Scope

- Streaming logs / per-call trace lines into metadata for a live-scrolling collapsed view.
- A dedicated `exec` panel with per-call expansion (WorkflowPanel-style).
- Parsing the `<exec>` envelope to render `return_value` / `trace` as distinct sections.
- TypeScript syntax highlighting of the script body.
- Any change to the `exec` enablement gate (`registry.ts:379-381`, GPT-toolset only).
- Making the row budget a hard bound (see the word-wrap follow-up in S2): neither simulating greedy word wrap nor switching these bodies to `wrapMode="char"` is done here.

## Tasks

- [x] T1: Retain per-tool `counts` in `exec` terminal metadata — acceptance: `bun test test/tool/tool-script.test.ts` passes with a new assertion that a completed run's metadata carries `counts` with per-tool `n`/`errors`, and that a failed inner call is reflected in `errors` (covers: S2)
- [x] T2: Render `exec` as a bash-style collapsible block — acceptance: `ToolScript` renders `BlockTool` whenever `input.code` is non-empty, showing a clipped script + clipped output + `…` markers while collapsed and full content when expanded, with the hint/click wiring gated on overflow; `bun typecheck` clean (covers: S2)
- [x] T3: Budget the collapsed height in rendered rows — acceptance: `bun test test/cli/tui/collapse.test.ts` passes, covering wrapped-height counting, whole-line drops, mid-line slicing at the budget, and the column floor; `Bash` and `ToolScript` both consume the shared helper (covers: S2)
- [x] T4: Measure height in display cells — acceptance: `bun test test/cli/tui/collapse.test.ts` covers CJK and emoji counting as two cells, a tab charged at least one cell, and a slice that stops before splitting a wide character (covers: S2)
