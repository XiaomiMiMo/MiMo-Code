import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Inbox } from "../../src/inbox"
import { ActorRegistry } from "../../src/actor/registry"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const base = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)
const testLayer = Inbox.layer.pipe(Layer.provide(base), Layer.provideMerge(base))

afterEach(async () => {
  await Instance.disposeAll()
})

async function withInbox(
  directory: string,
  fn: (rt: ManagedRuntime.ManagedRuntime<Inbox.Service | Session.Service | ActorRegistry.Service | Bus.Service, never>) => Promise<void>,
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

describe("Inbox.send no-block (Plan 2 / Task 7)", () => {
  test("send wall-clock < 50ms even when receiver actor exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "explore-1",
            mode: "subagent",
            parentActorID: undefined,
            agent: "explore",
            description: "explore",
            contextMode: "none",
            contextWatermark: undefined,
            background: true,
            lifecycle: "ephemeral",
          }),
        ),
      )

      const t0 = Date.now()
      const result = await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "explore-1",
            content: "test message",
          }),
        ),
      )
      const elapsed = Date.now() - t0

      // ulid-like: 26 chars of [0-9A-Za-z]
      expect(result.inboxID).toMatch(/^[0-9A-Za-z]{26}$/)
      expect(elapsed).toBeLessThan(50)
    })
  })

  test("two consecutive sends produce monotonically increasing ULIDs", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "explore-2",
            mode: "subagent",
            parentActorID: undefined,
            agent: "explore",
            description: "explore",
            contextMode: "none",
            contextWatermark: undefined,
            background: true,
            lifecycle: "ephemeral",
          }),
        ),
      )

      const r1 = await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "explore-2",
            content: "first",
          }),
        ),
      )
      // 2ms gap ensures the ULID timestamps differ, making lexicographic order == insertion order
      await Bun.sleep(2)
      const r2 = await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "explore-2",
            content: "second",
          }),
        ),
      )

      // drain orders by id — later ULID must sort after earlier one (FIFO contract)
      expect(r1.inboxID < r2.inboxID).toBe(true)
    })
  })
})
