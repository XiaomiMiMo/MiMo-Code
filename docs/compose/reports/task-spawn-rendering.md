---
feature: task-spawn-rendering
status: delivered
specs: []
plans:
  - docs/compose/plans/2025-07-01-fix-task-component-spawn-rendering.md
branch: fix/task-spawn-rendering
commits: 7ea754e..781abf0
---

# Task Component Async Actor Rendering — Final Report

## What Was Built

The `Task` component in the TUI now correctly renders actor tool calls across all operation types (`run`, `spawn`, `wait`, `cancel`, `status`). Previously, spawned background actors immediately showed as "completed · 0ms" while still running, and `wait`/`cancel` operations rendered as bare spinners with no context. The fix checks the actor's actual runtime status from the sync store registry, displays appropriate state (spinner while running, completed format when done), and labels each operation type clearly.

## Architecture

All changes are in a single file: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`, within the `Task` function (lines 2721–2848).

**New memos added:**

| Memo | Purpose |
|------|---------|
| `inputActorId` | Extracts `actor_id` from input for wait/cancel/status operations |
| `inputAction` | Extracts `action` field (run/spawn/wait/cancel/status) |
| `actorEntry` | Looks up the actor in `sync.data.actor[sessionID]` registry by ID |
| `actorStatus` | Derives the actor's actual runtime status from the registry entry |
| `resolvedDescription` | Falls back to actor registry description when input has none |

**Modified memos:**

| Memo | Change |
|------|--------|
| `targetSession` | Added fallback to `actorEntry().session_id` for ops without metadata |
| `targetBucket` | Added fallback to `inputActorId()` for ops without metadata |
| `isRunning` | Now returns `true` when tool part is "completed" but actor is still running/pending |
| `content` | Renders action-specific headers and respects actual actor status |

### Design Decisions

- **Actor registry as source of truth** — Rather than trying to infer running state from message timing or tool part status alone, the component reads the actor's actual status from `sync.data.actor`. This is reliable because the sync store receives `actor.status` events in real-time.

- **Unified Task component for all actor operations** — All actor tool calls (`run`, `spawn`, `wait`, `cancel`, `status`) render through the same `Task` component with differentiated labels, rather than splitting into separate components. This keeps navigation (click-to-view-subagent) working consistently.

- **Labels per action type** — Each operation gets a distinct header format so the user can immediately understand what's happening without reading tool output.

## Usage

No configuration needed. The rendering is automatic based on the actor tool call's action:

| Action | Running State | Completed State |
|--------|--------------|-----------------|
| `run` | `⠋ General Task — <desc>` + live activity | `│ General Task — <desc>` + `└ N toolcalls · Xs` |
| `spawn` | `⠋ Background Explore Task — <desc>` + live activity | `│ Background Explore Task — <desc>` + `└ N toolcalls · Xs` |
| `wait` | `⠋ Waiting for — <desc>` + live activity | `│ Waiting for — <desc>` + `└ N toolcalls · Xs` |
| `cancel` | `⠋ Cancelling — <desc>` | `│ Cancelled — <desc>` + `└ N toolcalls · Xs` |

When an actor is cancelled, non-cancel operations append `(cancelled)` to their header.

## Verification

- Typecheck: `bun typecheck` passes with zero errors
- Manual testing: spawn + wait + cancel flow verified in live TUI session
  - Background tasks correctly show spinner with live tool activity (not "0ms completed")
  - Wait operations show "Waiting for — " with live activity from the actor
  - Cancel shows "Cancelling" → "Cancelled" transition
  - Normal synchronous `run` operations render unchanged

## Journey Log

> Brief notes on what informed the final design.

- [lesson] Tool part "completed" status doesn't mean the actor finished — for `spawn`, the tool part completes immediately while the actor runs in background. Always cross-check `sync.data.actor` registry.
- [pivot] Initially rendered `wait` as a minimal one-liner, then expanded to full info with live activity after user feedback — both spawn and wait benefit from showing the same real-time tool activity.
- [lesson] "Cancelling" vs "Cancelled" distinction matters — the cancel tool part has a brief "running" phase before completing, so showing the transition gives correct feedback.

## Source Materials

| File | Role | Notes |
|------|------|-------|
| `docs/compose/plans/2025-07-01-fix-task-component-spawn-rendering.md` | Implementation plan | Covered Task 1 and Task 2 |
