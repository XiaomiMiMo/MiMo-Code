import { describe, expect, afterEach } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { WorkflowAgentFailed } from "../../src/workflow/events"
import { Worktree } from "../../src/worktree"
import { Bus } from "../../src/bus"
import { makeLayer, ref, providerCfg } from "./lib"

afterEach(async () => {
  delete process.env.MIMOCODE_TEST_SPAWN_FAIL_ONCE
  await Instance.disposeAll()
})

const it = testEffect(makeLayer())

// The reliable signal that the ENGINE retried is a WorkflowAgentFailed event:
// the engine publishes exactly one per FAILED spawn attempt. A transient failure
// that then succeeds on the engine's retry emits exactly one failed event and a
// completed run. The MIMOCODE_TEST_SPAWN_FAIL_ONCE seam forces the first N shared
// spawn attempts to throw a spawn-reject (retryable) deterministically, without
// depending on LLM/actor failure modes (HTTP errors become terminal
// no-deliverable, stream errors are retried inside the model layer, hangs don't
// release for a retry — none of which cleanly drive the engine retry path).
describe("WorkflowRuntime agent() retry", () => {
  it.live("retries a spawn-reject and succeeds on the second attempt", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
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
        yield* llm.text("ok") // consumed by the successful retry (attempt 2)
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("go", { retry: { attempts: 2, baseMs: 1, maxMs: 2 } })`,
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("completed")
        expect((outcome as { result: string }).result).toBe("ok")
        yield* Effect.sleep("100 millis") // bus is async
        expect(failed).toEqual(["spawn-reject"]) // exactly one attempt failed, retry succeeded
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("no retry option => a spawn-reject is not retried (one failed attempt, run returns null)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
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
        yield* llm.text("ok") // queued but never consumed — no retry
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

  it.live("retry exhausted => still null; every attempt emits a failed event", () =>
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
        // 3 attempts, all spawn-reject -> 3 failed events.
        expect(failed).toEqual(["spawn-reject", "spawn-reject", "spawn-reject"])
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live(
    "isolated (worktree) agent retries a spawn-reject and succeeds",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
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
          yield* llm.text("done") // consumed by the successful retry
          yield* Effect.promise(() => $`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())
          const script = [
            `export const meta = { name: "t", description: "d" }`,
            `return await agent("go", { isolation: "worktree", retry: { attempts: 2, baseMs: 1, maxMs: 2 } })`,
          ].join("\n")
          const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
          const outcome = yield* runtime.wait({ runID })
          expect(outcome.status).toBe("completed")
          expect((outcome as { result: unknown }).result).not.toBeNull()
          yield* Effect.sleep("100 millis")
          expect(failed).toEqual(["spawn-reject"]) // one failed attempt, retry succeeded
          const result = (outcome as { result: { _worktree?: { directory?: string } } }).result
          const wtDir = result?._worktree?.directory
          if (wtDir) yield* (yield* Worktree.Service).remove({ directory: wtDir }).pipe(Effect.ignore)
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )
})
