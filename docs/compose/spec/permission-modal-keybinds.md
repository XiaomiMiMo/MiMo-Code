---
feature: permission-modal-keybinds
status: delivered
updated: 2026-02-27
branch: fix/permission-modal-keybinds
commits: df9f3c9d..da9b6641
---

# Permission Modal Keybinds

## Report

**What was built** — A pending permission or question prompt is now a true
modal for keyboard purposes. While one is pending, the Session route suspends
global command keybinds (`command.keybinds(false)`, resumed on cleanup) — the
same mechanism the Prompt component already uses for ghost suggestions. This
stops ←/→ (default `session_child_cycle` / `session_child_cycle_reverse`)
from navigating into subagent views mid-prompt, and incidentally gives
`escape` → `session.interrupt` proper modal semantics (it was previously
protected only by an `input.focused` accident). The prompt components
(PermissionPrompt, RejectPrompt, QuestionPrompt) additionally ignore
`defaultPrevented` events so no handler double-processes a claimed key.
The SubagentFooter hides its Main/Prev/Next keybind hint labels while the
modal state is active (the keys are suspended); the click targets remain and
mouse navigation still works (`command.trigger` intentionally bypasses
suspension).

Known intentional behavior change worth QA awareness: ctrl+p (command palette)
and other command-layer shortcuts no longer fire while a permission/question
prompt is on screen — that is the modal semantics, matching how dialogs
already block commands via the dialog stack.

**Verification** —
- `bun test test/cli/tui/command-modal-suspension.test.tsx test/cli/tui/permission-bash-delete.test.tsx test/cli/tui/press-gate.test.tsx test/cli/tui/use-event.test.tsx` (from `packages/opencode`): 20 pass, 0 fail.
- `bun run typecheck` (packages/opencode): exit 0.
- Independent review (fresh subagent) over df9f3c9d..da9b6641: no critical findings; spec compliance, correctness, consistency all pass. Follow-up commit 5fc0fde7 (review minor: per-run unique test home) re-verified with the same test file (2 pass) and typecheck (exit 0).

**Journey log** —
- Root cause was not any single bug but an interaction: inline (non-dialog-stack) prompt + unmounted input leaving renderer focus `null` + subscription-order dispatch favoring the command layer + opentui not stopping later global listeners on `defaultPrevented`. The session has subagent actors only in some sessions, which is why the symptom looked probabilistic.
- First test attempt dispatched keys before Solid `onMount` subscriptions flushed (they register after the first render pass); the deterministic fix is awaiting an innermost-`onMount` ready promise before the harness dispatches any key.
- `mockInput.pressArrow` keys flow synchronously through opentui's stdin parser to `keyInput` — no render-loop coupling, but subscribers must exist first.
- Mechanism-level test deliberately mirrors the Session effect instead of mounting the full Session route (SDK-heavy); if the Session effect is ever restructured, the test still guards the suspension mechanism itself.

## [S1] Problem

When a permission prompt or question prompt is visible, pressing ←/→ sometimes
switches the subagent (child-session) view instead of moving the prompt's
selection. Root cause chain:

1. `Session.visible()` (routes/session/index.tsx) is false while a
   permission/question is pending, so `<Show>` unmounts the input `Prompt`;
   the focused textarea is destroyed and opentui clears
   `renderer.currentFocusedRenderable` to `null`.
2. The global command dispatcher (component/dialog-command.tsx `init` →
   `useKeyboard`) guards on `dialog.stack.length > 0` and on
   `isEditBufferRenderable(renderer.currentFocusedRenderable)`. Permission and
   question prompts render inline (never pushed onto the DialogProvider stack)
   and focus is `null`, so both guards fail.
3. opentui's `InternalKeyHandler` dispatches to global listeners in subscription
   order. `CommandProvider` subscribes at app start; the prompt components
   subscribe when they mount — the command layer therefore handles ←/→ first,
   matches the default `session_child_cycle` (`right`) /
   `session_child_cycle_reverse` (`left`) bindings and calls `moveChild(±1)`,
   navigating into/cycling subagent views.
4. It is intermittent because `moveChild` silently no-ops when the session has
   no subagent actors, and because the question prompt's custom-answer editing
   state focuses an inner textarea which re-enables the text-editing-key guard.

Related defect: opentui does not stop later global listeners on
`defaultPrevented`, and the prompt components do not check `evt.defaultPrevented`,
so the prompt's own selection/tab handler also fires after the command layer —
a double response. `escape` → `session.interrupt` is currently protected only by
accident (`prompt/index.tsx` checks `input.focused` inside `onSelect`).

## [S2] Design

Treat a pending permission/question as a modal state in which global command
keybinds are suspended, using the existing suspension mechanism
(`command.keybinds(false)` / `suspended()` counter, same pattern as the
ghost-suggestion suspension in component/prompt/index.tsx).

1. **Session-level suspension** — in `Session` (routes/session/index.tsx), add:

   ```ts
   createEffect(() => {
     if (!disabled()) return // permissions().length > 0 || questions().length > 0
     command.keybinds(false)
     onCleanup(() => command.keybinds(true))
   })
   ```

   Single ownership point covering both prompt types, main and subagent views.
   The `suspendCount` counter correctly handles overlap with the existing
   ghost-suggestion suspension. Suspension gates only the two command-layer
   handlers; component-level `useKeyboard` handlers (permission options,
   question tabs, textarea keybindings, ctrl+f fullscreen toggle, escape
   reject) are unaffected.

2. **Defensive `defaultPrevented` guards** — at the top of the key handling in
   `PermissionPrompt.Prompt` (routes/session/permission.tsx), `RejectPrompt`
   (same file) and `QuestionPrompt` (routes/session/question.tsx)
   `useKeyboard` callbacks, add `if (evt.defaultPrevented) return` so no
   handler reacts to an event already claimed by an earlier listener.

3. **Subagent footer hints** — `SubagentFooter` (routes/session/subagent-footer.tsx)
   hides its keybind hint labels (Main/Workflow `up`, Prev `left`, Next
   `right`) while a permission/question is pending for the session, since
   those keys are suspended in the modal state. Pending state is read from
   sync data (`permission`/`question` buckets for the session). Footer
   navigation via mouse click (`command.trigger`) remains available —
   `trigger()` intentionally bypasses suspension.

Error behavior: none of the changes alter reply/reject/request flows; they only
gate which component consumes keyboard events.

Testing boundary: a component-level regression test mounts
Keybind/Dialog/Command providers via the `testRender` harness
(test/cli/tui/*.test.tsx pattern), registers a probe command bound to
`right`, and asserts: probe not triggered while suspension is active; probe
triggered after resumption. The `Session`-level wiring is a one-line effect on
an existing memo and is covered by typecheck + manual QA, not a full-route test.

## [S3] Out of Scope

- Moving permission/question prompts onto the DialogProvider stack (architectural change to layout and escape semantics).
- Fixing the generic "global handlers ignore `defaultPrevented`" behavior in opentui itself.
- Gating other inline overlays (e.g. home-route tips) or reworking `session.interrupt`'s `input.focused` guard beyond what suspension already covers.
- Any change to permission/question reply, reject, or request lifecycle logic.

## Tasks

- [x] T1: Suspend global command keybinds while a permission/question is pending (Session-level effect) — acceptance: with a probe command bound to `right`, a dispatched right-arrow keypress does not invoke the probe while the modal state is active, and does invoke it after resumption (covers: S2.1)
- [x] T2: Add `evt.defaultPrevented` guards to PermissionPrompt.Prompt, RejectPrompt and QuestionPrompt key handlers — acceptance: an event already preventDefault'ed by an earlier listener does not move the prompt selection or trigger submit/reject (covers: S2.2)
- [x] T3: Hide SubagentFooter keybind hint labels while a permission/question is pending — acceptance: hint labels are absent from the rendered footer during the modal state and present otherwise (covers: S2.3)
