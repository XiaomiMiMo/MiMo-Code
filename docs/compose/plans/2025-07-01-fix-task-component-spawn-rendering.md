# Fix Task Component Rendering for Spawned Actors

> [!NOTE]
> This document may not reflect the current implementation.
> See the final report for up-to-date state:
> [Final Report](../reports/task-spawn-rendering.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `Task` TUI component so that spawned (background) actors are displayed with running/spinner state until the actor actually completes, rather than showing a misleading "completed" state with 0ms duration.

**Architecture:** The `Task` component currently determines its visual state solely from `props.part.state.status` (the tool part's completion status). For `spawn` operations, this becomes "completed" immediately (spawn itself returned successfully), even though the spawned actor is still running. The fix adds a secondary check against the actor's actual runtime status from `sync.data.actor[sessionID]`. Additionally, `wait` tool calls (which have no `description`) should display context about what they're waiting for.

**Tech Stack:** SolidJS (TUI rendering), TypeScript

## Global Constraints

- Run typecheck from `packages/opencode` via `bun typecheck`
- Tests cannot run from repo root; run from `packages/opencode`
- Avoid `any` types; rely on type inference where possible
- Follow the existing code style (no destructuring, const-over-let, no else statements)

---

## Problem Summary

When the LLM uses `actor spawn` + `actor wait` pattern:

1. **spawn tool part** → status "completed" immediately (spawn returned actor_id)
2. **Task component** sees `props.part.state.status === "completed"` → renders `└ N toolcalls · 0ms`
3. The 0ms happens because `duration()` reads the subagent's last assistant message `time.completed`, which is still `undefined` (subagent still running)
4. **wait tool part** → status "running", but `input().description` is `undefined` → renders as a bare spinner with no context

The user sees: completed-looking tasks (clickable, with metadata) at top, mysterious spinners at bottom. The "completed" tasks are actually still running.

### Root Cause Location

`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2721-2811` — the `Task` function.

### Data Available for Fix

- `sync.data.actor[sessionID]` contains `ActorEntry[]` with each actor's real-time `status` field (updated via `actor.status` events)
- `props.metadata.actorId` identifies which actor this tool call is associated with
- `props.metadata.sessionId` identifies the session

---

### Task 1: Make Task component check actual actor status for visual state

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2721-2811`

**Interfaces:**
- Consumes: `sync.data.actor[sessionID]: ActorEntry[]` from the sync store (already available via `useSync()`)
- Produces: Corrected visual state — shows spinner/running UI when actor is still running, regardless of tool part status

- [ ] **Step 1: Add actor status lookup to Task component**

After line 2734 (`const targetBucket = ...`), add a memo that looks up the actual actor status:

```ts
const actorStatus = createMemo(() => {
  const session = targetSession()
  const actorId = targetBucket()
  if (!session || actorId === "main") return undefined
  const actors = sync.data.actor[session]
  if (!actors) return undefined
  return actors.find((a) => a.actor_id === actorId)?.status
})
```

- [ ] **Step 2: Update `isRunning` memo to consider actor status**

Replace the current `isRunning` (line 2757):

```ts
const isRunning = createMemo(() => props.part.state.status === "running")
```

With:

```ts
const isRunning = createMemo(() => {
  if (props.part.state.status === "running") return true
  if (props.part.state.status === "completed") {
    const status = actorStatus()
    return status === "running" || status === "pending"
  }
  return false
})
```

- [ ] **Step 3: Update content memo to not show completed format when actor is still running**

Replace the completed check in the content memo (line 2779):

```ts
if (props.part.state.status === "completed") {
  content.push(`└ ${tools().length} toolcalls · ${Locale.duration(duration())}`)
}
```

With:

```ts
if (props.part.state.status === "completed" && !isRunning()) {
  content.push(`└ ${tools().length} toolcalls · ${Locale.duration(duration())}`)
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun typecheck` from `packages/opencode`
Expected: PASS with no new errors

---

### Task 2: Add context to `wait` tool call rendering

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2721-2811`

**Interfaces:**
- Consumes: `props.input` which for `wait` operations contains `{ operation: { action: "wait", actor_id: "..." } }`
- Consumes: `sync.data.actor[sessionID]` to find the actor's description
- Produces: Meaningful display text for wait operations instead of empty spinners

- [ ] **Step 1: Update input parsing to handle wait/status/cancel operations**

After the existing `input` memo, add a fallback description lookup:

```ts
const resolvedDescription = createMemo(() => {
  if (input().description) return input().description
  const raw = props.input as Partial<{ operation: { action: string; actor_id: string } }>
  const op = raw?.operation
  if (!op?.actor_id) return undefined
  const session = targetSession() ?? props.part.sessionID
  const actors = sync.data.actor[session]
  if (!actors) return undefined
  return actors.find((a) => a.actor_id === op.actor_id)?.description
})
```

- [ ] **Step 2: Update content memo and InlineTool to use resolvedDescription**

Replace `if (!input().description) return ""` with:
```ts
const desc = resolvedDescription()
if (!desc) return ""
```

Update the content line and InlineTool's `complete` prop accordingly.

- [ ] **Step 3: Update targetSession/targetBucket for wait operations**

Add fallback logic to read `actor_id` from input when metadata isn't available.

- [ ] **Step 4: Run typecheck**

Run: `bun typecheck` from `packages/opencode`
Expected: PASS with no new errors
