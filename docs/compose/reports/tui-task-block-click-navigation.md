---
feature: tui-task-block-click-navigation
status: delivered
specs: []
plans: []
branch: fix/task-block-click
commits: 6af864e
---

# TUI Task Block Click Navigation — Final Report

## What Was Built

Fixed a bug where clicking a running Task Block (subagent) in the TUI did nothing. The root cause was that `ctx.metadata()` — which writes `sessionId`/`actorId` to the tool part state — was only called AFTER `actor.spawn()` returned. For `action:"run"`, spawn blocks on `Fiber.join` until the subagent completes, so metadata was never available during the running phase. The TUI's click handler read `targetSession()` as `undefined` and early-returned.

The fix introduces an `onReady` callback on `SpawnInput` that fires before `Fiber.join`, allowing the actor tool to emit metadata while the tool is still "running". A secondary fix in the TUI ensures the `onClick` handler reads from reactive memos (SolidJS-idiomatic) rather than raw getter chains.

## Architecture

### Data Flow (Before Fix)

```
actor.spawn() → Fiber.join(fiber) [BLOCKS] → return
ctx.metadata({ sessionId, actorId }) ← never reached while running
```

### Data Flow (After Fix)

```
actor.spawn() → onReady fires → ctx.metadata() writes to DB → Fiber.join(fiber) [BLOCKS]
                 ↑ metadata available to TUI immediately
```

### Key Files

| File | Change |
|------|--------|
| `src/actor/spawn.ts` | Added `onReady` to `SpawnInput`; invoked before `Fiber.join` |
| `src/tool/actor.ts` | Passes `onReady` that calls `ctx.metadata()` |
| `src/cli/cmd/tui/routes/session/index.tsx` | Task onClick uses `targetSession()` / `targetBucket()` memos |

### Design Decisions

- **`onReady` callback over removing `Fiber.join`**: `Fiber.join` provides interrupt propagation (parent abort → child interrupt). Removing it would break cancellation semantics and existing tests. The callback approach preserves blocking-run semantics while allowing metadata emission at the right time.
- **Effect-returning callback (`onReady`) vs sync callback (`onActorID`)**: `ctx.metadata()` calls `processor.updateToolCall()` which involves DB writes via `SyncEvent.run`. This requires yielding an Effect, not just a sync function.

## Verification

- Manual TUI testing: spawned a `run`-mode subagent (sleep 20s), confirmed spinner visible during execution, click navigates into subagent view, can exit and re-enter after completion.
- Typecheck: passes.
- Unit test: `test/actor/spawn.test.ts` — "onReady fires before Fiber.join blocks" verifies the callback fires during spawn and receives correct actorID/sessionID.

## Testing Strategy

The `onReady` behavior is tested at the **spawn layer** (`test/actor/spawn.test.ts`) rather than via end-to-end prompt-loop integration tests. Two prior integration tests (`prompt-effect.test.ts`) were removed because:

1. Their integration path (prompt loop → AI SDK v6 `fullStream` → tool execution → DB poll) is fundamentally broken in the test environment — AI SDK v6's `fullStream` stalls after `start-step` due to microtask scheduling conflicts between Web Streams and Effect's fiber runtime.
2. Adding `Actor.layer` to `prompt-effect.test.ts`'s layer composition creates a circular dependency with `SessionPrompt.layer`.
3. The behavior they intended to verify is already covered by:
   - **Spawn-level unit test**: `onReady` fires at the correct time (before `Fiber.join`)
   - **Existing tool tests**: `ctx.metadata()` → `updateToolCall` → `SyncEvent.run` → DB write (used by bash/edit/glob tools)
   - **Manual TUI verification**: running subagent shows spinner, click navigates correctly

## Journey Log

> Brief notes on what informed the final design.

- [dead end] Removing `Fiber.join` entirely — broke interrupt propagation and existing "failed subtask" test expectations
- [dead end] Adding `Actor.layer` to test layer composition — circular dependency with SessionPrompt.layer
- [lesson] AI SDK v6's `fullStream` may not yield tool-call events to an Effect Stream consumer in test environments due to microtask scheduling conflicts between Web Streams and Effect fibers
- [lesson] SolidJS store proxy access in event handlers: using reactive memos is safer than raw getter chains through store proxies, especially when properties are added dynamically via `reconcile`
