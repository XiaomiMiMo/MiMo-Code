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
import { tmpdir, withServerAuth } from "../fixture/fixture"

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
  test("returns 409 when session main runner is already busy", () =>
    withServerAuth(async (auth) => {
      await using tmp = await tmpdir({})

      const status = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const sess = yield* sessions.create({ title: "busy-runner test" })
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
              const res = yield* Effect.promise(async () =>
                app.request(`/session/${sess.id}/message?directory=${encodeURIComponent(tmp.path)}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "authorization": auth },
                  body: JSON.stringify({
                    parts: [{ type: "text", text: "should be rejected" }],
                  }),
                }),
              )

              yield* state.cancel(sess.id)

              return res.status
            }),
          ),
      })

      expect(status).toBe(409)
    }))

  test("POST /:sessionID/abort frees runner; subsequent POST is no longer rejected with 409", () =>
    withServerAuth(async (auth) => {
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

              const first = yield* Effect.promise(async () =>
                app.request(`/session/${sess.id}/message${dirQuery}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "authorization": auth },
                  body: JSON.stringify({ parts: [{ type: "text", text: "first" }] }),
                }),
              )

              const abort = yield* Effect.promise(async () =>
                app.request(`/session/${sess.id}/abort${dirQuery}`, {
                  method: "POST",
                  headers: { "authorization": auth },
                }),
              )

              yield* Effect.sleep("100 millis")

              const second = yield* Effect.promise(async () =>
                app.request(`/session/${sess.id}/message${dirQuery}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "authorization": auth },
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
    }))
})
