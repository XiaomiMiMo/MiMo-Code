import { describe, expect, afterEach } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { WorkflowAgentFailed } from "../../src/workflow/events"
import { Bus } from "../../src/bus"
import { makeLayer, ref, providerCfg } from "./lib"

afterEach(async () => {
  delete process.env.MIMOCODE_TEST_SPAWN_FAIL_ONCE
  await Instance.disposeAll()
})

const it = testEffect(makeLayer())

// The legacy retry option remains parse-compatible but must not issue another
// model request. One forced spawn rejection therefore produces one failure event
// and a null result regardless of the requested attempt count.
describe("WorkflowRuntime agent() single-attempt behavior", () => {
  it.live("ignores a retry option after a spawn rejection", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        process.env.MIMOCODE_TEST_SPAWN_FAIL_ONCE = "1" // first spawn attempt throws
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const bus = yield* Bus.Service
        const failed: string[] = []
        yield* bus.subscribeCallback(WorkflowAgentFailed, (e) => failed.push(e.properties.reason))
        const parent = yield* session.create({
          title: "wf retry",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("go", { retry: { attempts: 2, baseMs: 1, maxMs: 2 } })`,
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("completed")
        expect((outcome as { result: unknown }).result ?? null).toBeNull()
        yield* Effect.sleep("100 millis") // bus is async
        expect(failed).toEqual(["spawn-reject"])
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("no retry option => a spawn-reject is not retried (one failed attempt, run returns null)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        process.env.MIMOCODE_TEST_SPAWN_FAIL_ONCE = "1"
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const bus = yield* Bus.Service
        const failed: string[] = []
        yield* bus.subscribeCallback(WorkflowAgentFailed, (e) => failed.push(e.properties.reason))
        const parent = yield* session.create({
          title: "wf no-retry",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("go")`, // no retry opt
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("completed")
        const v = (outcome as { result: unknown }).result
        expect(v === null || v === undefined).toBe(true) // agent() returned null
        yield* Effect.sleep("100 millis")
        expect(failed).toEqual(["spawn-reject"]) // exactly one attempt, no retry
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("a large retry count still makes only one attempt", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        process.env.MIMOCODE_TEST_SPAWN_FAIL_ONCE = "5" // more than attempts -> all fail
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const bus = yield* Bus.Service
        const failed: string[] = []
        yield* bus.subscribeCallback(WorkflowAgentFailed, (e) => failed.push(e.properties.reason))
        const parent = yield* session.create({
          title: "wf exhausted",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("go", { retry: { attempts: 3, baseMs: 1, maxMs: 2 } })`,
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("completed")
        const v = (outcome as { result: unknown }).result
        expect(v === null || v === undefined).toBe(true)
        yield* Effect.sleep("100 millis")
        expect(failed).toEqual(["spawn-reject"])
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live(
    "isolated worktree agents also ignore retry options",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir }) {
          process.env.MIMOCODE_TEST_SPAWN_FAIL_ONCE = "1"
          const runtime = yield* WorkflowRuntime.Service
          const session = yield* Session.Service
          const bus = yield* Bus.Service
          const failed: string[] = []
          yield* bus.subscribeCallback(WorkflowAgentFailed, (e) => failed.push(e.properties.reason))
          const parent = yield* session.create({
            title: "wf retry isolated",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* Effect.promise(() => $`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())
          const script = [
            `export const meta = { name: "t", description: "d" }`,
            `return await agent("go", { isolation: "worktree", retry: { attempts: 2, baseMs: 1, maxMs: 2 } })`,
          ].join("\n")
          const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
          const outcome = yield* runtime.wait({ runID })
          expect(outcome.status).toBe("completed")
          expect((outcome as { result: unknown }).result ?? null).toBeNull()
          yield* Effect.sleep("100 millis")
          expect(failed).toEqual(["spawn-reject"])
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )
})
