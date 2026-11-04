// packages/cli/test/cli/run-completion.test.ts
import { test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createCompletionTracker } from "../../src/cli/cmd/run-completion"
import { Bus } from "../../src/bus"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { NodeFileSystem } from "@effect/platform-node"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

test("event path: session.status idle event for matching sessionID resolves completion", async () => {
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => ({ type: "busy" }), // poll never returns idle
    intervalMs: 50,
  })
  expect(tracker.done).toBe(false)

  tracker.onEvent({
    type: "session.status",
    properties: { sessionID: "ses_X", status: { type: "idle" } },
  })

  expect(tracker.done).toBe(true)
  await tracker.completion
  tracker.stop()
})

test("poll fallback: query returning idle (absent record) resolves completion when no event arrives", async () => {
  let calls = 0
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => {
      calls++
      return calls >= 2 ? undefined : { type: "busy" } // absent on/after 2nd call = idle
    },
    intervalMs: 30,
  })
  tracker.markStarted() // bypass started latch (covered separately in Task 3)

  await tracker.completion

  expect(tracker.done).toBe(true)
  expect(calls).toBeGreaterThanOrEqual(2)
  tracker.stop()
})

test("started latch: poll-observed idle is ignored before tracker is started", async () => {
  let calls = 0
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => { calls++; return undefined }, // always idle
    intervalMs: 20,
  })

  // Without start, several poll ticks must NOT complete.
  await new Promise((r) => setTimeout(r, 80))
  expect(tracker.done).toBe(false)
  expect(calls).toBeGreaterThan(0)

  // Now start; next poll tick completes.
  tracker.markStarted()
  await tracker.completion
  expect(tracker.done).toBe(true)

  tracker.stop()
})

test("started latch: a running status for matching sessionID auto-starts the tracker", async () => {
  // Any non-idle status means the session is running (no need to call markStarted).
  for (const type of ["busy", "retry", "notice"]) {
    const tracker = createCompletionTracker({
      sessionID: "ses_X",
      query: async () => undefined, // always idle
      intervalMs: 20,
    })

    tracker.onEvent({
      type: "session.status",
      properties: { sessionID: "ses_X", status: { type } },
    })

    // Bounded, so a status that stops starting the tracker fails here rather than by the runner's timeout.
    await Promise.race([tracker.completion, new Promise((r) => setTimeout(r, 1000))])
    expect(tracker.done).toBe(true)
    tracker.stop()
  }
})

test("started latch: other session events before the first busy status do not end the run", async () => {
  // Before its first busy status a session has no status record, which the poll reads as idle. The session's own
  // events (here session.updated and the user message) arrive in that window and must not start the tracker.
  let status: { type: "busy" } | undefined
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => status,
    intervalMs: 20,
  })

  tracker.onEvent({ type: "session.updated", properties: { sessionID: "ses_X" } })
  tracker.onEvent({ type: "message.part.updated", properties: { part: { sessionID: "ses_X" } } })
  // Another session running says nothing about this one.
  tracker.onEvent({ type: "session.status", properties: { sessionID: "ses_Y", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 100))
  expect(tracker.done).toBe(false)

  // The session runs, then finishes: its record is gone again, and the next poll completes.
  status = { type: "busy" }
  tracker.onEvent({ type: "session.status", properties: { sessionID: "ses_X", status } })
  await new Promise((r) => setTimeout(r, 60))
  expect(tracker.done).toBe(false)
  status = undefined
  await tracker.completion
  expect(tracker.done).toBe(true)
  tracker.stop()
})

test("started latch: a poll read before the first busy status but answered after it does not end the run", async () => {
  let status: { type: "busy" } | undefined
  let held = false
  let release = () => {}
  let inFlight = () => {}
  const firstPollHeld = new Promise<void>((r) => {
    inFlight = r
  })
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => {
      const snapshot = status
      if (!held) {
        held = true
        inFlight()
        await new Promise<void>((r) => {
          release = r
        })
      }
      return snapshot
    },
    intervalMs: 20,
  })

  // The first poll has read "no status" and is still in flight when the session turns busy.
  await firstPollHeld
  status = { type: "busy" }
  tracker.onEvent({ type: "session.status", properties: { sessionID: "ses_X", status } })
  release()
  await new Promise((r) => setTimeout(r, 30))
  expect(tracker.done).toBe(false)
  tracker.stop()
})

const integrationLayer = SessionStatus.layer.pipe(
  Layer.provideMerge(Bus.layer),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)),
)
const integrationIt = testEffect(integrationLayer)

integrationIt.live(
  "integration: real SessionStatus.Service drives query; busy→idle resolves tracker",
  () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionStatus.Service
        const sessionID = SessionID.descending()

        // No explicit Effect.provide here: setInterval inherits the ALS context
        // set up by provideTmpdirInstance, so InstanceState.get resolves through
        // Instance.current. svc was captured from the outer scope where the
        // layer IS provided, so its closured state is valid here.
        const query = () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const map = yield* svc.list()
              return map.get(sessionID)
            }),
          )

        const tracker = createCompletionTracker({ sessionID, query, intervalMs: 30 })

        yield* svc.set(sessionID, { type: "busy" })
        tracker.markStarted()

        yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 80)))
        expect(tracker.done).toBe(false)

        yield* svc.set(sessionID, { type: "idle" })
        yield* Effect.promise(() => tracker.completion)

        expect(tracker.done).toBe(true)
        tracker.stop()
      }),
    ),
)
