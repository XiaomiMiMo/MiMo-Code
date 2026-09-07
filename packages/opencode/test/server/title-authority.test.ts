import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"

test("machine titles can revise generated titles but never overwrite manual or stale revisions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: async () => {
    const run = AppRuntime.runPromise
    const s = await run(Session.Service.use(svc => svc.create()))
    expect(await run(Session.Service.use(svc => svc.setGeneratedTitle({ sessionID: s.id, title: "First", expectedRevision: 0 })))).toMatchObject({ titleSource: "generated", titleRevision: 1 })
    expect(await run(Session.Service.use(svc => svc.setTitleIfDefault({ sessionID: s.id, title: "Duplicate initial", expectedRevision: 1 })))).toBe(false)
    expect(await run(Session.Service.use(svc => svc.setGeneratedTitle({ sessionID: s.id, title: "Second", expectedRevision: 1 })))).toMatchObject({ title: "Second", titleRevision: 2 })
    expect(await run(Session.Service.use(svc => svc.setGeneratedTitle({ sessionID: s.id, title: "Stale", expectedRevision: 1 })))).toBe(false)
    await run(Session.Service.use(svc => svc.setTitle({ sessionID: s.id, title: "User", expectedRevision: 2 })))
    expect(await run(Session.Service.use(svc => svc.setGeneratedTitle({ sessionID: s.id, title: "Machine", expectedRevision: 3 })))).toBe(false)
    expect(await run(Session.Service.use(svc => svc.get(s.id)))).toMatchObject({ title: "User", titleSource: "user", titleRevision: 3 })
  } })
})

test("fork persists an explicit protected title at creation",  async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const original = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "Original" })))
      const response = await Server.Default().app.request(`/session/${original.id}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "  Custom branch  " }),
      })
      expect(response.status).toBe(200)
      const fork = await response.json()
      expect(fork).toMatchObject({ title: "Custom branch", titleSource: "user", titleRevision: 0 })
      const saved = await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(fork.id)))
      expect(saved).toMatchObject({ title: "Custom branch", titleSource: "user", titleRevision: 0 })
    },
  })
})

// [TP-ST-R2-05, TP-ST-R2-06, TP-ST-R2-08] Real HTTP validator and SQLite command.
test("PATCH requires revision, rejects provenance/future revisions and returns a complete 409 snapshot", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create()))
      const app = Server.Default().app
      const patch = (body: unknown) =>
        app.request(`/session/${s.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      for (const body of [
        { title: "Missing revision" },
        { title: "Future", expectedRevision: 1 },
        { title: "Fake", expectedRevision: 0, titleSource: "generated" },
        { title: "Fraction", expectedRevision: 0.5 },
      ])
        expect((await patch(body)).status).toBe(400)
      const success = await patch({ title: " Mine ", expectedRevision: 0 })
      expect(success.status).toBe(200)
      expect(await success.json()).toMatchObject({ id: s.id, title: "Mine", titleSource: "user", titleRevision: 1 })
      const conflict = await patch({ title: "Mine", expectedRevision: 0 })
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toEqual({
        name: "TitleConflictError",
        data: { current: { sessionID: s.id, title: "Mine", titleSource: "user", titleRevision: 1 } },
      })
      await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(s.id)))
      expect((await patch({ title: "Late", expectedRevision: 1 })).status).toBe(404)
    },
  })
})
