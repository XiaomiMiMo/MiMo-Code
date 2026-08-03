---
feature: sidebar-shrink-and-press-gate
status: in-progress
updated: 2026-08-03
branch: fix/sidebar-shrink-and-press-gate
commits: <base-sha>..<head-sha>
---

# Sidebar state model & press-gated mouse controls

## Report

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

The render condition `sidebarVisible() || wide()` already expresses this; what was
missing is that the narrow overlay painted over it. The button gets `zIndex={1}` so it
floats above the overlay, landing on the sidebar's right padding column. Verified both
visually (`captureCharFrame`) and for hit-testing (`mockMouse` click at the raised
button's cell).

`contentWidth` now subtracts the sidebar only when docked (`sidebarVisible() && wide()`),
using a shared `SIDEBAR_WIDTH` constant exported from `sidebar.tsx` instead of a second
hardcoded `42`. This removes the overlay-mode reflow and, because nothing is subtracted
on narrow terminals, removes the non-positive-width case without needing a floor. The
sidebar itself clamps to `Math.min(SIDEBAR_WIDTH, dimensions().width)` so it cannot
overflow a terminal narrower than itself.

### [S2.3] Stable-click gate

New `ui/press.ts` exporting `createPress(onPress: () => void)`, returning a `hover`
accessor plus a spreadable prop bag. The contract is a **stable click**: press and release
on the element with no `out` in between, once per press. Anything less is dropped.

That asymmetry is the design. A dropped click is a non-event the user repeats; an
unintended activation is the defect this exists to prevent, so every ambiguity resolves
toward not firing. Browser semantics — where the pointer may leave the element and return
and still produce a click — are explicitly not the goal. `out` also arrives on
intra-element hit changes, because a child glyph and the box's own cells are separate hit
targets, so a press that drifts one cell is discarded too. Asserted as such in the tests.

- `onMouseDown` arms only if the press coordinates fall inside the element's rect.
- `onMouseOut` disarms unconditionally; `onMouseDrag` disarms when the drag lands outside;
  `onMouseDrop` disarms because a `drop` means a drag captured elsewhere ended here.
- `onMouseUp` returns early when unarmed, disarms before anything else (the duplicate `up`
  delivered inside a captured renderable is then inert), rejects releases carrying
  `isDragging` (opentui sets that only on its two selection dispatches, so it identifies a
  release closing a text selection — which never gets a preceding `drop`), and re-checks
  the release coordinates against the rect.
- `onMouseOver`/`onMouseOut` also drive the returned `hover` accessor, because the gate
  must own `onMouseOut` and callers cannot register a second handler for it.

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
- [x] T3: Raise the toggle above the overlay, share `SIDEBAR_WIDTH`, clamp the sidebar, and adopt `createPress` in the toggle and the voice control — acceptance: the collapse glyph renders and is clickable with the overlay up; `contentWidth` stays positive at any width (covers: S2.2; S2.4; depends: T2)
- [x] T4: Regression tests plus typecheck — acceptance: `testRender` + `mockMouse` proves the captured-drag mis-fire is gated out, the state model is covered by pure tests, and `bun typecheck` passes (covers: S2.1; S2.3; depends: T1, T3)
