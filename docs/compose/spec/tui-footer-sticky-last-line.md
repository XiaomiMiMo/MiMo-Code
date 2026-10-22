---
feature: tui-footer-sticky-last-line
status: delivered
updated: 2026-07-11
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2679
---

# TUI footer last-line flicker

## Report

**What was built** — The session transcript's completion footer (`▣ Mode · model · duration`) is the scroll area's last row and now stays mounted whenever the message is last, including mid-loop `finish="tool-calls"` steps. Previously `showFooter` hid that row as soon as `finish` became `"tool-calls"`, so the last line vanished for the whole tool window and flickered at the process→complete transition. The Orchestrator-era trailing-row suppression is gone with the mode; duration still only renders when `finish` is set and ≠ `"tool-calls"`.

**Verification** — `bun run typecheck` (packages/cli): PASS. `bun test ./test/cli/tui/ ./test/cli/cmd/tui/` (packages/cli): PASS, 362 tests / 0 fail (includes 7 footer-predicate cases). Independent review of the first cut flagged that a prior-final scan was global by `id`; that scan is gone in the final shape because the trailing-row rule no longer exists. Sticky-follow re-snap was prototyped and then deliberately dropped from this PR per review direction — net diff touches only the footer gate.

**Journey log** —
1. Symptom looked like sticky off-by-one *or* footer unmount; the unmount is the one to fix here — `showFooter` literally unmounts the row via `<Match when={showFooter()}>`.
2. The unmount gate `props.last && finish !== "tool-calls"` existed only to suppress a trailing Orchestrator tool-calls row after a stop row. Orchestrator is deleted (`orchestrator-removal-tui.test.tsx`), so the gate has no remaining purpose.
3. User direction: don't touch sticky in this PR; `finish=tool-calls` should never make the line disappear. Final predicate is `recovering || aborted || isFinal || isLast`.
4. Keep sticky re-snap in the back pocket if the hole ever reproduces after this lands — it is a separate, layout-timing concern.

## [S1] Problem

In the session TUI, the completion footer (`▣ Mode · model`, the orange agent glyph + mode + model) is the last line of the scrollable transcript. Scroll tracks the bottom (`stickyScroll` + `stickyStart="bottom"`), so that line should stay visible as a stable last row while content grows.

During a step's toolcall transition from process rendering to completed state, that line disappears for about one frame. Root cause is footer unmount, not scroll: `showFooter` was `props.last && props.message.finish !== "tool-calls"` once `final()` is false. Mid-loop assistant messages write `finish = "tool-calls"` at `finish-step` (and actor tools write it before the tool part flips to `completed`). On that write the last message stops drawing the footer until the next assistant message mounts, so the last row vanishes.

## [S2] Design

**Footer stability.** The last assistant row is the live turn status line. Keep it mounted for every last message, including `finish === "tool-calls"` mid-loop steps. Orchestrator (the only reason to suppress a trailing tool-calls row) is gone, so no trailing-row exception remains.

Pure predicate (testable without the view):

```ts
shouldShowAssistantFooter({
  recovering,
  aborted,
  finish,   // message.finish
  isLast,
})
```

| recovering / aborted | `isFinal` | `isLast` | show |
| --- | --- | --- | --- |
| true | * | * | yes |
| false | true | * | yes |
| false | false | true | yes (live last row, incl. `finish="tool-calls"`) |
| false | false | false | no |

`isFinal` = `finish` set and ≠ `"tool-calls"`. Duration still only renders when `isFinal`.

**Out of scope.** Sticky scroll / follow-bottom re-snap (separate concern; not in this PR). Prompt-embedded mode/model row, sidebar status, pinning a footer overlay outside the scroll content.

## [S3] Out of Scope

- Sticky-scroll timing / follow-bottom re-snap
- Changing footer copy, glyphs, or duration math
- Non-session scrollboxes (workflow page, dialogs)

## Tasks

- [x] T1: Extract `shouldShowAssistantFooter` and wire `AssistantMessage.showFooter` — acceptance: mid-loop last message with `finish=tool-calls` shows the footer; non-last mid-loop rows do not (covers: S2)
- [x] T2: Regression tests for the footer predicate — acceptance: `bun test` packages/cli footer cases pass (covers: S2; depends: T1)
