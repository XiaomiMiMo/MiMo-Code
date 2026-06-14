import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const testLayer = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

async function withRegistry(
  directory: string,
  fn: (rt: ManagedRuntime.ManagedRuntime<Session.Service | ActorRegistry.Service | Bus.Service, never>) => Promise<void>,
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
      }
    },
  })
}

describe("ActorRegistry shape (Plan 1 / Task 4)", () => {
  test("register requires lifecycle, defaults status=pending, lastOutcome unset", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((s) => s.create()))
      const entry = await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: parent.id,
            actorID: "explore-1",
            mode: "subagent",
            parentActorID: undefined,
            agent: "explore",
            description: "explore",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )
      expect(entry.status).toBe("pending")
      expect(entry.lastOutcome).toBeUndefined()
      expect(entry.lifecycle).toBe("ephemeral")
      expect(entry.lastError).toBeUndefined()
    })
  })

  test("updateStatus({status:idle, lastOutcome:success}) clears last_error", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((s) => s.create()))
      const sid = parent.id
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: sid,
            actorID: "explore-2",
            mode: "subagent",
            parentActorID: undefined,
            agent: "explore",
            description: "explore",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.updateStatus(sid, "explore-2", {
            status: "idle",
            lastOutcome: "failure",
            lastError: "first try",
          }),
        ),
      )
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.updateStatus(sid, "explore-2", { status: "running" }),
        ),
      )
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.updateStatus(sid, "explore-2", {
            status: "idle",
            lastOutcome: "success",
          }),
        ),
      )
      const entry = await rt.runPromise(
        ActorRegistry.Service.use((reg) => reg.get(sid, "explore-2")),
      )
      expect(entry?.status).toBe("idle")
      expect(entry?.lastOutcome).toBe("success")
      expect(entry?.lastError).toBeUndefined()
    })
  })
})
