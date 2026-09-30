import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Hono } from "hono"
import { ErrorMiddleware } from "../../src/server/middleware"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionRunState } from "../../src/session/run-state"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("ErrorMiddleware → BusyError mapping", () => {
  test("BusyError maps to HTTP 409 Conflict", async () => {
    const app = new Hono()
    app.get("/throw-busy", () => {
      throw new Session.BusyError("ses_test_busy")
    })
    app.onError(ErrorMiddleware)

    const res = await app.request("/throw-busy")
    expect(res.status).toBe(409)
    const body = (await res.json()) as { name: string; data: { message: string } }
    expect(body.data.message).toContain("ses_test_busy")
  })
})

describe("POST /session/:sessionID/message busy-runner behavior", () => {
  test("returns 409 when session main runner is already busy", async () => {
    await using tmp = await tmpdir({})

    const status = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const sess = yield* sessions.create({ title: "busy-runner test" })
            const state = yield* SessionRunState.Service

            // Occupy the main runner with an Effect that never resolves.
            // Forked so we can continue and issue the conflicting POST.
            yield* state
              .startShell(
                sess.id,
                Effect.succeed({ info: {}, parts: [] } as never),
                Effect.never as never,
              )
              .pipe(Effect.forkChild)

            // Give the scheduler a tick so the occupant marks the runner busy.
            yield* Effect.sleep("50 millis")

            // Pass ?directory= so InstanceMiddleware resolves to the same instance
            // the test created. Without this, the route handler would land in a
            // different Instance (process.cwd()) whose SessionRunState has no busy
            // runner, defeating the test.
            const app = Server.Default().app
            const res = yield* Effect.promise(async () =>
              app.request(`/session/${sess.id}/message?directory=${encodeURIComponent(tmp.path)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  parts: [{ type: "text", text: "should be rejected" }],
                }),
              }),
            )

            // Best-effort: stop the occupant so afterEach disposal is clean.
            yield* state.cancel(sess.id)

            return res.status
          }),
        ),
    })

    expect(status).toBe(409)
  })

  test("POST /:sessionID/abort frees runner; subsequent POST is no longer rejected with 409", async () => {
    await using tmp = await tmpdir({})

    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const sess = yield* sessions.create({ title: "busy-recover test" })
            const state = yield* SessionRunState.Service

            yield* state
              .startShell(
                sess.id,
                Effect.succeed({ info: {}, parts: [] } as never),
                Effect.never as never,
              )
              .pipe(Effect.forkChild)
            yield* Effect.sleep("50 millis")

            const app = Server.Default().app
            const dirQuery = `?directory=${encodeURIComponent(tmp.path)}`

            // 1. confirm busy → 409
            const first = yield* Effect.promise(async () =>
              app.request(`/session/${sess.id}/message${dirQuery}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parts: [{ type: "text", text: "first" }] }),
              }),
            )

            // 2. abort frees the runner
            const abort = yield* Effect.promise(async () =>
              app.request(`/session/${sess.id}/abort${dirQuery}`, { method: "POST" }),
            )

            // Wait for runner.cancel to take effect.
            yield* Effect.sleep("100 millis")

            // 3. subsequent POST is no longer 409 — assert just status != 409.
            //    (full success requires a real LLM; we only verify the contention
            //    is gone, not the prompt outcome.)
            const second = yield* Effect.promise(async () =>
              app.request(`/session/${sess.id}/message${dirQuery}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parts: [{ type: "text", text: "second" }] }),
              }),
            )
            return { firstStatus: first.status, abortStatus: abort.status, secondStatus: second.status }
          }),
        ),
    })

    expect(result.firstStatus).toBe(409)
    expect(result.abortStatus).toBe(200)
    expect(result.secondStatus).not.toBe(409)
  })
})
