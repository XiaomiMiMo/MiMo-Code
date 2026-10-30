// packages/cli/test/cli/run-completion.test.ts
import { test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createCompletionTracker, type StatusInfo } from "../../src/cli/cmd/run-completion"
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

test("poll fallback: a live status then an absent record resolves completion", async () => {
  let calls = 0
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => {
      calls++
      return calls >= 2 ? undefined : { type: "busy" } // idle deletes the record, so it goes absent
    },
    intervalMs: 30,
  })
  tracker.markStarted()

  await tracker.completion

  expect(tracker.done).toBe(true)
  expect(calls).toBeGreaterThanOrEqual(2)
  tracker.stop()
})

test("started latch: poll-observed absent status is ignored before tracker is started", async () => {
  let status: StatusInfo | undefined
  let calls = 0
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => { calls++; return status }, // never a record while unstarted
    intervalMs: 20,
  })

  // Without a start, several poll ticks must NOT complete the tracker.
  await new Promise((r) => setTimeout(r, 80))
  expect(tracker.done).toBe(false)
  expect(calls).toBeGreaterThan(0)

  // Starting alone is not a completion signal either: the session has not been
  // observed live yet.
  tracker.markStarted()
  await new Promise((r) => setTimeout(r, 60))
  expect(tracker.done).toBe(false)

  status = { type: "busy" }
  await new Promise((r) => setTimeout(r, 60))
  expect(tracker.done).toBe(false)

  status = undefined
  await tracker.completion
  expect(tracker.done).toBe(true)

  tracker.stop()
})

test("an event that is not a status does not let an absent record end the run", async () => {
  let status: StatusInfo | undefined
  let calls = 0
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => { calls++; return status }, // no record until the session turns busy
    intervalMs: 20,
  })

  // The run was submitted and the session announced itself, but it has not
  // turned busy yet. Ending here would drop the output and never answer a
  // permission request.
  tracker.markStarted()
  tracker.onEvent({ type: "session.updated", properties: { sessionID: "ses_X" } })
  await new Promise((r) => setTimeout(r, 80))
  expect(tracker.done).toBe(false)
  expect(calls).toBeGreaterThan(0)

  // A live status event arms the absent record, without any poll having seen it.
  tracker.onEvent({
    type: "session.status",
    properties: { sessionID: "ses_X", status: { type: "busy" } },
  })
  await tracker.completion
  expect(tracker.done).toBe(true)

  tracker.stop()
})

test("a status for another session does not arm the absent record", async () => {
  let calls = 0
  const tracker = createCompletionTracker({
    sessionID: "ses_X",
    query: async () => { calls++; return undefined },
    intervalMs: 20,
  })

  tracker.markStarted()
  tracker.onEvent({ type: "session.updated", properties: { sessionID: "ses_other" } })
  tracker.onEvent({
    type: "session.status",
    properties: { sessionID: "ses_other", status: { type: "busy" } },
  })

  await new Promise((r) => setTimeout(r, 80))
  expect(tracker.done).toBe(false)
  expect(calls).toBeGreaterThan(0)
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
