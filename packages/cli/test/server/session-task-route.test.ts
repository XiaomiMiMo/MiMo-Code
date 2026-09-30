import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { Todo } from "../../src/session/todo"
import { TaskRegistry } from "../../src/task/registry"
import type { Task } from "../../src/task/schema"
import type { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function runSession<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

function runTask<A, E>(fx: Effect.Effect<A, E, TaskRegistry.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(TaskRegistry.defaultLayer)))
}

function runTodo<A, E>(fx: Effect.Effect<A, E, Todo.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Todo.defaultLayer)))
}

const createSession = () => runSession(SessionNs.Service.use((svc) => svc.create({})))

afterEach(async () => {
  await Instance.disposeAll()
})

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

describe("session task route", () => {
  test("GET /:sid/task returns [] for a fresh session, then created tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await createSession()
          const app = Server.Default().app

          const empty = await app.request(`/session/${session.id}/task`)
          expect(empty.status).toBe(200)
          expect(await empty.json()).toEqual([])

          await runTask(TaskRegistry.Service.use((reg) => reg.create({ session_id: session.id, summary: "first" })))
          await runTask(TaskRegistry.Service.use((reg) => reg.create({ session_id: session.id, summary: "second" })))

          const res = await app.request(`/session/${session.id}/task`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as Task[]
          expect(body.map((t) => t.id)).toEqual(["T1", "T2"])
          expect(body.map((t) => t.summary)).toEqual(["first", "second"])
          expect(body.map((t) => t.status)).toEqual(["open", "open"])
        },
      }),
    )
  })

  test("GET /:sid/task 404s for a missing session", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const res = await app.request(`/session/ses_missing/task`)
          expect(res.status).toBe(404)
        },
      }),
    )
  })

  test("GET /:sid/todo projects task data with status mapping when tasks exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await createSession()

          const open = await runTask(
            TaskRegistry.Service.use((reg) => reg.create({ session_id: session.id, summary: "still open" })),
          )
          const running = await runTask(
            TaskRegistry.Service.use((reg) => reg.create({ session_id: session.id, summary: "running" })),
          )
          await runTask(TaskRegistry.Service.use((reg) => reg.start({ session_id: session.id, id: running.id })))
          const finished = await runTask(
            TaskRegistry.Service.use((reg) => reg.create({ session_id: session.id, summary: "finished" })),
          )
          await runTask(TaskRegistry.Service.use((reg) => reg.done({ session_id: session.id, id: finished.id })))
          // open + then blocked -> projects to "pending"
          const blocked = await runTask(
            TaskRegistry.Service.use((reg) => reg.create({ session_id: session.id, summary: "blocked" })),
          )
          await runTask(TaskRegistry.Service.use((reg) => reg.block({ session_id: session.id, id: blocked.id })))
          const abandoned = await runTask(
            TaskRegistry.Service.use((reg) => reg.create({ session_id: session.id, summary: "abandoned" })),
          )
          await runTask(TaskRegistry.Service.use((reg) => reg.abandon({ session_id: session.id, id: abandoned.id })))

          void open

          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/todo`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as { content: string; status: string }[]
          expect(body).toEqual([
            { content: "still open", status: "pending" },
            { content: "running", status: "in_progress" },
            { content: "finished", status: "completed" },
            { content: "blocked", status: "pending" },
            { content: "abandoned", status: "cancelled" },
          ])
        },
      }),
    )
  })

  test("GET /:sid/todo falls back to the todo table when no tasks exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await createSession()
          await runTodo(
            Todo.Service.use((svc) =>
              svc.update({
                sessionID: session.id,
                todos: [
                  { content: "legacy todo a", status: "pending" },
                  { content: "legacy todo b", status: "completed" },
                ],
              }),
            ),
          )

          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/todo`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as { content: string; status: string }[]
          expect(body).toEqual([
            { content: "legacy todo a", status: "pending" },
            { content: "legacy todo b", status: "completed" },
          ])
        },
      }),
    )
  })
})
