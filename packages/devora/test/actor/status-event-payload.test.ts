import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import z from "zod"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { ActorStatusChanged } from "../../src/actor/events"
import { tmpdir } from "../fixture/fixture"

const testLayer = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

async function withRegistry(
  directory: string,
  fn: (
    rt: ManagedRuntime.ManagedRuntime<
      Session.Service | ActorRegistry.Service | Bus.Service,
      never
    >,
  ) => Promise<void>,
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

describe("actor.status event payload", () => {
  test("payload carries lastOutcome, turnCount, lastTurnTime", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((s) => s.create()))
      const sid = parent.id

      const events: Array<z.infer<typeof ActorStatusChanged.properties>> = []
      const unsubscribe = await rt.runPromise(
        Bus.Service.use((bus) =>
          bus.subscribeCallback(ActorStatusChanged, (evt) => {
            events.push(evt.properties)
          }),
        ),
      )
      try {
        await rt.runPromise(
          ActorRegistry.Service.use((reg) =>
            reg.register({
              sessionID: sid,
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

        await rt.runPromise(
          ActorRegistry.Service.use((reg) => reg.updateStatus(sid, "explore-1", { status: "running" })),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((reg) => reg.updateTurn(sid, "explore-1")),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((reg) =>
            reg.updateStatus(sid, "explore-1", { status: "idle", lastOutcome: "success" }),
          ),
        )

        await new Promise((r) => setTimeout(r, 50))

        expect(events.length).toBe(2)

        const [running, idle] = events
        expect(running.status).toBe("running")
        expect(running.lastOutcome).toBeUndefined()
        expect(running.turnCount).toBe(0)
        expect(typeof running.lastTurnTime).toBe("number")

        expect(idle.status).toBe("idle")
        expect(idle.lastOutcome).toBe("success")
        expect(idle.turnCount).toBe(1)
        expect(idle.lastTurnTime).toBeGreaterThanOrEqual(running.lastTurnTime)
      } finally {
        unsubscribe()
      }
    })
  })

  test("updateStatus against non-existent actor publishes no event", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((s) => s.create()))
      const sid = parent.id

      const events: unknown[] = []
      const unsubscribe = await rt.runPromise(
        Bus.Service.use((bus) =>
          bus.subscribeCallback(ActorStatusChanged, (evt) => {
            events.push(evt.properties)
          }),
        ),
      )
      try {
        await rt.runPromise(
          ActorRegistry.Service.use((reg) =>
            reg.updateStatus(sid, "ghost-1", { status: "running" }),
          ),
        )

        await new Promise((r) => setTimeout(r, 50))
        expect(events.length).toBe(0)
      } finally {
        unsubscribe()
      }
    })
  })
})
