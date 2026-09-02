import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function runSession<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

function runRegistry<A, E>(fx: Effect.Effect<A, E, ActorRegistry.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(ActorRegistry.defaultLayer)))
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

describe("POST /:sessionID/inbox/send", () => {
  test("returns 200 with inboxID for a registered actor", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await createSession()
          await runRegistry(
            ActorRegistry.Service.use((reg) =>
              reg.register({
                sessionID: session.id,
                actorID: "test-actor",
                mode: "subagent",
                agent: "general",
                description: "test",
                contextMode: "none",
                background: true,
                lifecycle: "ephemeral",
              }),
            ),
          )

          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/inbox/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actorID: "test-actor", content: "hello from user" }),
          })
          expect(res.status).toBe(200)
          const body = (await res.json()) as { inboxID: string }
          expect(body.inboxID).toBeTruthy()
          expect(typeof body.inboxID).toBe("string")
        },
      }),
    )
  })

  test("defaults type to 'text' when omitted", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await createSession()
          await runRegistry(
            ActorRegistry.Service.use((reg) =>
              reg.register({
                sessionID: session.id,
                actorID: "test-actor",
                mode: "subagent",
                agent: "general",
                description: "test",
                contextMode: "none",
                background: true,
                lifecycle: "ephemeral",
              }),
            ),
          )

          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/inbox/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actorID: "test-actor", content: "hello" }),
          })
          expect(res.status).toBe(200)
        },
      }),
    )
  })

  test("returns 400 on empty content", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await createSession()
          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/inbox/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actorID: "test-actor", content: "" }),
          })
          expect(res.status).toBe(400)
        },
      }),
    )
  })

  test("returns 400 on missing actorID", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await createSession()
          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/inbox/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "hello" }),
          })
          expect(res.status).toBe(400)
        },
      }),
    )
  })

  test("returns 404 for nonexistent actor", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await createSession()
          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/inbox/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actorID: "nonexistent", content: "hello" }),
          })
          expect(res.status).toBe(404)
        },
      }),
    )
  })

  test("returns 400 on invalid sessionID format", async () => {
    await withoutWatcher(async () => {
      const app = Server.Default().app
      const res = await app.request(`/session/not-valid/inbox/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorID: "test-actor", content: "hello" }),
      })
      expect(res.status).toBe(400)
    })
  })
})
