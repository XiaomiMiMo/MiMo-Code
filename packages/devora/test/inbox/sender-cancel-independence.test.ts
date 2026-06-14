import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Inbox } from "../../src/inbox"
import { ActorRegistry } from "../../src/actor/registry"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Database, eq, and } from "../../src/storage"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const base = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)
const testLayer = Inbox.layer.pipe(Layer.provide(base), Layer.provideMerge(base))

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Inbox sender cancel independence (Plan 2 / Task 7)", () => {
  // Proves send is INSERT-then-fork: the DB row exists immediately after send returns,
  // independent of whether any downstream wake fiber is alive.
  test("inbox row persists after send regardless of wake fiber state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = ManagedRuntime.make(testLayer)
        try {
          const session = await rt.runPromise(Session.Service.use((s) => s.create()))
          await rt.runPromise(
            ActorRegistry.Service.use((reg) =>
              reg.register({
                sessionID: session.id,
                actorID: "recv-1",
                mode: "subagent",
                parentActorID: undefined,
                agent: "general",
                description: "cancel test",
                contextMode: "none",
                contextWatermark: undefined,
                background: false,
                lifecycle: "ephemeral",
              }),
            ),
          )

          // Send a message — send is synchronous INSERT + async wake fork.
          // The row must be durable before send returns.
          const { inboxID } = await rt.runPromise(
            Inbox.Service.use((inbox) =>
              inbox.send({
                receiverSessionID: session.id,
                receiverActorID: "recv-1",
                content: "persistent message",
              }),
            ),
          )

          // Immediately query the DB — row must exist at this point.
          const rows = await rt.runPromise(
            Effect.sync(() =>
              Database.use((db) =>
                db
                  .select()
                  .from(InboxTable)
                  .where(
                    and(
                      eq(InboxTable.receiver_session_id, session.id),
                      eq(InboxTable.receiver_actor_id, "recv-1"),
                    ),
                  )
                  .all(),
              ),
            ),
          )

          expect(rows.length).toBe(1)
          expect(rows[0]!.id).toBe(inboxID)
          expect((rows[0]!.content as { text: string }).text).toBe("persistent message")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("two concurrent sends produce two independent rows", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = ManagedRuntime.make(testLayer)
        try {
          const session = await rt.runPromise(Session.Service.use((s) => s.create()))
          await rt.runPromise(
            ActorRegistry.Service.use((reg) =>
              reg.register({
                sessionID: session.id,
                actorID: "recv-2",
                mode: "subagent",
                parentActorID: undefined,
                agent: "general",
                description: "concurrent test",
                contextMode: "none",
                contextWatermark: undefined,
                background: false,
                lifecycle: "ephemeral",
              }),
            ),
          )

          // Two sends — each independently inserts a row
          const [r1, r2] = await rt.runPromise(
            Inbox.Service.use((inbox) =>
              Effect.all(
                [
                  inbox.send({
                    receiverSessionID: session.id,
                    receiverActorID: "recv-2",
                    content: "first",
                  }),
                  inbox.send({
                    receiverSessionID: session.id,
                    receiverActorID: "recv-2",
                    content: "second",
                  }),
                ],
                { concurrency: "unbounded" },
              ),
            ),
          )

          // Both IDs must be unique
          expect(r1.inboxID).not.toBe(r2.inboxID)

          const rows = await rt.runPromise(
            Effect.sync(() =>
              Database.use((db) =>
                db
                  .select()
                  .from(InboxTable)
                  .where(
                    and(
                      eq(InboxTable.receiver_session_id, session.id),
                      eq(InboxTable.receiver_actor_id, "recv-2"),
                    ),
                  )
                  .all(),
              ),
            ),
          )

          expect(rows.length).toBe(2)
        } finally {
          await rt.dispose()
        }
      },
    })
  })
})
