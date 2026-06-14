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

describe("Inbox.send wake matrix (Plan 2 / Task 7)", () => {
  // Case 1: Missing receiver row → InboxReceiverNotFound (ESRCH)
  test("send to unregistered actor fails with InboxReceiverNotFound", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))

      const result = await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox
            .send({
              receiverSessionID: session.id,
              receiverActorID: "nonexistent-actor",
              content: "should fail",
            })
            .pipe(
              Effect.map(() => ({ caught: false as const, tag: null as string | null })),
              Effect.catchTag("InboxReceiverNotFound", (e) =>
                Effect.succeed({ caught: true as const, tag: e._tag as string | null }),
              ),
            ),
        ),
      )

      expect(result.caught).toBe(true)
      expect(result.tag).toBe("InboxReceiverNotFound")
    })
  })

  // Case 2: send to idle receiver with lastOutcome: "cancelled" still wakes (B3 axiom)
  test("idle receiver with lastOutcome=cancelled still receives message", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "cancelled-actor",
            mode: "subagent",
            parentActorID: undefined,
            agent: "general",
            description: "test",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )

      // Set actor to idle + cancelled
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.updateStatus(session.id, "cancelled-actor", {
            status: "idle",
            lastOutcome: "cancelled",
          }),
        ),
      )

      // send should still succeed — B3 axiom: no ESRCH for idle/cancelled
      const result = await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "cancelled-actor",
            content: "wake after cancel",
          }),
        ),
      )

      expect(result.inboxID).toBeDefined()
      expect(typeof result.inboxID).toBe("string")
      expect(result.inboxID.length).toBe(26)
    })
  })

  // Case 3: error fields are passed through in InboxReceiverNotFound
  test("InboxReceiverNotFound carries receiverActorID and receiverSessionID", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))

      const result = (await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox
            .send({
              receiverSessionID: session.id,
              receiverActorID: "ghost",
              content: "lost",
            })
            .pipe(
              Effect.catchTag("InboxReceiverNotFound", (e) =>
                Effect.succeed({
                  actorID: e.receiverActorID,
                  sessionID: e.receiverSessionID,
                }),
              ),
            ),
        ),
      )) as { actorID: string; sessionID: string }

      expect(result.actorID).toBe("ghost")
      expect(result.sessionID).toBe(session.id)
    })
  })
})
