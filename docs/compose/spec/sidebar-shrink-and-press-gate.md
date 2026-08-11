---
feature: sidebar-shrink-and-press-gate
status: delivered
updated: 2026-08-03
branch: fix/sidebar-shrink-and-press-gate
commits: 6853935c..6dff0b1a
---

# Sidebar state model & press-gated mouse controls

## Report

**What was built** — The right sidebar's two overlapping state variables collapse into one
persisted tri-state `SidebarPreference`, normalised on every toggle so that a result the
terminal width would have chosen anyway is stored as `auto`. The sticky state that kept a
manually-expanded sidebar visible in terminals too narrow to dock it is now
unrepresentable, rather than cleared by a resize handler. An expanded sidebar always offers
a collapse control — the narrow-terminal overlay used to paint over the only one — while a
collapsed sidebar offers an expand control only where it can dock, and a subagent view
offers neither and cannot write the preference. `contentWidth` stops reserving the
sidebar's columns in overlay mode, where the sidebar takes no layout space.

Mouse activation for the sidebar toggle and the voice control moves behind
`ui/press.ts`'s `createPress`, which takes a **stable click** only: press and release on
the element with no `out` in between. This replaces `onMouseUp`-only handling, which
opentui fires on whatever sits under the cursor when a drag captured elsewhere ends there —
the scrollbar-drag mis-fire that prompted the work. The gate is a narrow opt-in, not a
migration target: plain `onMouseUp` remains correct for the other ~127 call sites, and its
entry criterion is a control where an accidental activation is itself the defect.

**Verification** — `bun typecheck` in `packages/opencode` passes. `bun test
test/cli/tui/press-gate.test.tsx test/cli/tui/sidebar-state.test.ts` — 16 pass. `bun test
test/cli/tui test/cli/cmd/tui` — 261 pass, 1 fail, 1 error; the same command on base `main`
gives 245 pass, 1 fail, 1 error, so that failure is `PRE-EXISTING` (`thread.test.ts`,
independently root-caused: the workflow builtin `.js` files are function bodies with a
top-level `return`, imported as raw text via `with { type: "text" }`, and Bun sometimes
loads one through the ESM parser instead; minimal repro `bun test
test/cli/tui/plugin-toggle.test.ts test/cli/tui/thread.test.ts`, each file green alone).
Each fix was reproduced as a failing assertion before being made to pass, including the
baseline mis-fire against a plain `onMouseUp` button, the dropped intra-element click, and
the toggle's position parity between docked and overlay modes, all proven with throwaway
`testRender` probes.

**Journey log**

- Three review rounds each found a real CRITICAL, and the third one found a defect the
  second round's own fix had introduced. When a fix keeps reopening its own area, the
  problem is usually the model, not the patch: this gate was accumulating disarm hooks to
  approximate browser click semantics against a dispatcher that does not supply the events
  for it.
- The product owner cut that knot by naming the contract instead of the mechanism — stable
  click, leaving discards, don't care about the rest. That reverted a fix (`d0bb626b` →
  `50fee2d1`) and turned a reviewer's CRITICAL into an asserted contract. The asymmetry is
  the whole point: a dropped click is a non-event the user repeats, an unintended one is the
  bug. Encode such a rule as a test, or the next contributor "fixes" it.
- The contract then had to be read precisely, because "no `out`" and "never left" are not
  the same predicate here. Reverting wholesale also discarded clicks that merely drifted
  inside the control, which the contract never asked for. Restoring the geometric check
  turned out to cost nothing: the mis-fire it had been reverted for only reproduces when a
  press arrives with no preceding pointer motion, which no real pointer does. The lesson is
  that the earlier revert leaned on a reviewer's synthetic repro without asking whether the
  input sequence was reachable — measure the cost of a guard before paying for it.
- Two hypotheses died to cheap experiments. Unrestored `spyOn`s looked like the obvious
  cause of the pre-existing failure until reading the file showed `mockRestore()` in a
  `finally`; a static-plus-dynamic double import of a text-loaded module looked like the
  Bun bug until a 4-file standalone repro refused to reproduce. Both cost minutes and
  saved a wrong fix.
- `rg -rn` is `--replace`, not recursive — it silently rewrote match output mid-investigation
  and briefly made `builtin.ts` look like it imported `./builtin/n.js`.
- The upstream-facing half of that failure (a Bun text-import/ESM loader collision) is
  parked with a worktree and no commits; CI is green because it shards test files across
  four processes, so the two files that collide rarely share one.

## [S1] Problem

Two independent mouse/layout defects in the session TUI.

**S1.1 — sidebar survives a shrink it cannot fit into, with no way to close it.**
`routes/session/index.tsx` carried two overlapping pieces of sidebar state: a persisted
`sidebar: "auto" | "hide"` (index.tsx:199) and an in-memory `sidebarOpen` signal
(index.tsx:200). Visibility was

```
sidebarVisible = agent === "main" && (sidebarOpen || (sidebar === "auto" && wide))
```

`sidebarOpen` short-circuited ahead of the `wide` term and nothing ever cleared it.
Collapsing then re-expanding on a wide terminal left `sidebarOpen === true` for the rest
of the session, so shrinking below the `width > 120` threshold no longer auto-hid the
sidebar: it flipped to the narrow full-area overlay branch (index.tsx:1497-1509), which
paints over the 3-column toggle button (index.tsx:1480-1491) because the overlay is the
later sibling with no `zIndex`. The user saw a sidebar that pops out with no visible
control. Reproducible every time after one collapse/expand cycle; a fresh session reset
`sidebarOpen` and looked fine, which is why it read as intermittent.

The overlay buried the toggle in *every* narrow case, not just the sticky one — opening
via `Ctrl+X B` on a narrow terminal produced the same unclosable-by-mouse sidebar. A
throwaway `testRender` probe confirmed the layering: without `zIndex` the button's glyph
is absent from the captured frame entirely.

`contentWidth` (index.tsx:239) also subtracted the sidebar's hardcoded 42 columns even in
overlay mode, where the sidebar takes no layout space. Below 46 columns that drove it
non-positive.

**S1.2 — scrollbar drags mis-trigger neighbouring buttons.** The sidebar toggle
(index.tsx:155) and the voice control (component/prompt/index.tsx:1834-1851) fired on
`onMouseUp` alone, with no record of where the press began. `@opentui/core`'s renderer
dispatches a bare `up` to the renderable under the cursor *in addition to* delivering
`drag-end`/`up` to the captured renderable, because the captured-`up` branch has no
`return` before the generic dispatch at the end of `handleMouseEvent`. Dragging the
transcript scrollbar — which becomes the captured renderable via `SliderRenderable`'s
`onMouseDown`/`onMouseDrag` — and releasing with the cursor drifted onto an adjacent
button therefore activated that button. The button also receives `over` during the drag,
so its hover highlight lights up and the mis-fire looks intentional. Confirmed with a
baseline `testRender` + `mockMouse` probe: an `onMouseUp`-only button fires when a drag
captured on a neighbour is released over it.

Two dispatch details constrain any fix:

- Releasing inside a captured renderable delivers `up` **twice** (once from the captured
  branch, once from the generic dispatch), so a press gate must consume its armed state
  exactly once.
- A captured renderable never receives `out` (the dispatcher guards with
  `lastOverRenderable !== capturedRenderable`), so "press the button, drag away, release
  outside" cannot be detected by hover tracking alone and needs a geometric bounds check
  at release time.

## [S2] Design

### [S2.1] One tri-state preference, normalised on toggle

`sidebarOpen` is deleted. The persisted preference widens to
`SidebarPreference = "auto" | "show" | "hide"` and all logic moves into two pure
functions in `routes/session/sidebar-state.ts`:

```ts
export function sidebarVisibleFor(preference: SidebarPreference, wide: boolean) {
  if (preference === "auto") return wide
  return preference === "show"
}

export function sidebarToggle(preference: SidebarPreference, wide: boolean): SidebarPreference {
  const next = !sidebarVisibleFor(preference, wide)
  if (next === wide) return "auto"
  return next ? "show" : "hide"
}
```

The normalisation is the fix for S1.1: a toggle whose resulting visibility matches what
the width would have picked anyway stores `auto` rather than an override. A
collapse/expand round-trip on a wide terminal therefore ends at `auto`, and a later
shrink hides the sidebar again. No resize effect is needed — the sticky state cannot be
represented.

An explicit expand on a narrow terminal still yields `show`, which deliberately survives
further shrinking: the user asked for it, so it stays until they collapse it. Collapsing
it lands back on `auto` by the same rule. Existing `"auto"` / `"hide"` values on disk
remain valid, so no kv migration is required.

Both toggle call sites (`sidebar_toggle` command and the button) collapse to
`setSidebar(() => sidebarToggle(sidebar(), wide()))`, removing the duplicated two-signal
update and the `batch` it needed.

### [S2.2] Toggle affordance rules

- Expanded → a collapse control at **any** width.
- Collapsed → an expand control only when wide enough to dock.
- Subagent views → no control at all, and the `sidebar_toggle` command disabled.

The render condition `sidebarVisible() || wide()` already expressed the first two; what was
missing is that the narrow overlay painted over the button. Rather than raise the button
above the overlay, it now rides *inside* it as a right-aligned row sibling placed before the
panel. That keeps one invariant across both modes — the control sits immediately to the left
of the sidebar — instead of the control appearing left of the panel when docked and on the
panel's right edge when overlaid. It also removes the `zIndex` the raised version needed, and
simplifies the in-flow gate to `sidebarAllowed() && wide()` since the overlay now owns its
own control. Verified by comparing captured frames: the glyph occupies the same column and
the sidebar starts at the same column in both modes, with exactly one control rendered.

The third rule is new. `sidebarVisible()` was already gated on `currentAgentID() === "main"`
while `sidebarToggle` is width-only, so on a subagent view the control offered "expand"
and a click wrote `"hide"` — persisting a hidden sidebar for the main view. That gate is
now a named `sidebarAllowed()` memo used by the panel, the button's `Show`, and the
command's `enabled`. `main` rendered a dead button there (it mutated state but the agent
gate suppressed any visible effect); the control is removed rather than made to work,
since the sidebar itself cannot appear on a subagent view.

`contentWidth` now subtracts the sidebar only when docked (`sidebarVisible() && wide()`),
using a shared `SIDEBAR_WIDTH` constant exported from `sidebar.tsx` instead of a second
hardcoded `42`. This removes the overlay-mode reflow and lifts the non-positive-width
threshold from "below 46 columns" to "4 columns or fewer" — not a floor, just narrow
enough to be unreachable; no clamp was added for a terminal that small. The sidebar itself
clamps to `Math.min(SIDEBAR_WIDTH, dimensions().width)` so it cannot overflow a terminal
narrower than itself.

### [S2.3] Stable-click gate

New `ui/press.ts` exporting `createPress(onPress: () => void)`, returning a `hover`
accessor plus a spreadable prop bag. The contract is a **stable click**: the press and the
release both land on the element and the pointer never leaves its bounds in between, once
per press. Movement within the element is fine.

That asymmetry is the design. A dropped click is a non-event the user repeats; an
unintended activation is the defect this exists to prevent, so every ambiguity resolves
toward not firing. Browser semantics — where the pointer may leave the element and return
and still produce a click — are explicitly not the goal.

"Left the element" has to be decided geometrically rather than from the event name, because
opentui raises `out` and `over` on intra-element hit-target changes as well: a child glyph
and the box's own cells are separate hit targets, and both events bubble to the parent, so
the parent sees `out` while the pointer is still inside it. `MouseEvent.target` does not
settle it either, since an `out` is dispatched to the element being left — which is that
same child both when the pointer merely crosses an internal boundary and when it exits the
control entirely. The coordinates do settle it: `out` carries the pointer's new position.

- `onMouseDown` arms only if the press coordinates fall inside the element's rect.
- `onMouseOut` and `onMouseOver` disarm only when the event's new position is outside the
  rect; `onMouseDrag` disarms when the drag lands outside; `onMouseDrop` disarms because a
  `drop` means a drag captured elsewhere ended here.
- `onMouseUp` returns early when unarmed, disarms before anything else (the duplicate `up`
  delivered inside a captured renderable is then inert), rejects releases carrying
  `isDragging` (opentui sets that only on its two selection dispatches, so it identifies a
  release closing a text selection — which never gets a preceding `drop`), and re-checks
  the release coordinates against the rect.
- `onMouseOver`/`onMouseOut` also drive the returned `hover` accessor, because the gate
  must own `onMouseOut` and callers cannot register a second handler for it.

One limitation is accepted and documented rather than worked around: a press that arrives
with no preceding pointer movement onto the element cannot be disarmed when it drags away,
because opentui then delivers the element no event at all for that press — it is too narrow
to become the capture target, and `lastOverRenderable` was never pointed at it. This was
measured rather than assumed: with a realistic hover-then-press sequence the drag-off does
deliver an `out` and disarms, and only a synthetic press with no prior motion reproduces the
stale arm. Real pointers always generate that movement first.

Consumers must render unselectable content (`selectable={false}` on any `<text>`).
Otherwise the element's own press starts a text selection, every release arrives with
`isDragging`, and the control is silently dead. Stated in the exported doc comment.

Bounds come from the renderable captured through `ref`; `Renderable` exposes absolute
`x`/`y`/`width`/`height` in the same coordinate space as `MouseEvent`'s `x`/`y`.

### [S2.4] Adoption, and where this must NOT spread

`SidebarToggleButton` and the voice control consume `createPress`. The voice control's
five `Match` branches share one gate instance created outside the `Switch`; the
non-interactive `finishing` branch keeps no handlers. Both render unselectable glyphs.

The gate is deliberately **not** a general replacement for `onMouseUp`, and the remaining
~127 `onMouseUp` sites are not queued for migration. Handling only `up` is correct for the
great majority of controls; routing one of them through the gate buys nothing and costs it
dropped clicks. The entry criterion is a control where an accidental activation is itself
the defect — in practice, one adjacent to a drag surface (a scrollbar, selectable
transcript text) whose action the user cannot casually undo.

## [S3] Out of Scope

- Migrating the other ~127 `onMouseUp` handlers to the press gate. Not a backlog item: see
  [S2.4] — most controls should keep plain `onMouseUp`.
- Subtracting the toggle button's 3 columns from `contentWidth` — a pre-existing
  discrepancy; changing it would reflow every transcript.
- Patching the upstream `@opentui/core` dispatch bug.
- The pre-existing `test/cli/tui/thread.test.ts` failure and the workflow-builtin `.js`
  load error it surfaces when the suite runs as a batch.

## Tasks
- [x] T1: Replace the two-signal sidebar state with `sidebarVisibleFor`/`sidebarToggle` in `routes/session/sidebar-state.ts` and wire both toggle sites — acceptance: a wide collapse/expand round-trip normalises to `auto` so a later shrink hides the sidebar; an explicit narrow expand persists (covers: S2.1)
- [x] T2: Add `createPress` in `ui/press.ts` — acceptance: press outside + release inside does not fire; press inside + release inside fires exactly once; press inside + release outside does not fire (covers: S2.3)
- [x] T3: Raise the toggle above the overlay, share `SIDEBAR_WIDTH`, clamp the sidebar, and adopt `createPress` in the toggle and the voice control — acceptance: the collapse glyph renders and is clickable with the overlay up; `contentWidth` stays positive at every reachable width (covers: S2.2; S2.4; depends: T2)
- [x] T4: Regression tests plus typecheck — acceptance: `testRender` + `mockMouse` proves the captured-drag mis-fire is gated out, the state model is covered by pure tests, and `bun typecheck` passes (covers: S2.1; S2.3; depends: T1, T3)
- [x] T5: Gate the control and the `sidebar_toggle` command on `sidebarAllowed()` — acceptance: a subagent view offers no sidebar affordance and cannot write the preference (covers: S2.2)
- [x] T6: Fix the arm leak and the selection-drag release path, then settle the stable-click contract and record its entry criterion — acceptance: a foreign drag or selection released over a control never fires it; a drifted press is dropped and asserted as contract (covers: S2.3; S2.4; depends: T2)
