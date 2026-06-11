import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { gcInboxRows } from "../../src/inbox/inbox"
import { Database, eq } from "../../src/storage"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { ulid } from "ulid"

// GC unit tests only need Session (for foreign key), Registry, and Bus.
// No need for Inbox.layer itself — we test gcInboxRows directly.
const testLayer = Layer.mergeAll(
  Session.defaultLayer,
  ActorRegistry.defaultLayer,
  Bus.defaultLayer,
)

afterEach(async () => {
  await Instance.disposeAll()
})

describe("gcInboxRows unit tests (Plan 2 / Task 7)", () => {
  test("deletes rows older than cutoff, keeps recent rows", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = ManagedRuntime.make(testLayer)
        try {
          const session = await rt.runPromise(Session.Service.use((s) => s.create()))

          const now = Date.now()
          const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000
          const oneHourAgo = now - 60 * 60 * 1000

          const oldID = ulid()
          const freshID = ulid()

          // Insert 2 rows directly: one 8-day-old, one 1-hour-old
          await rt.runPromise(
            Effect.sync(() =>
              Database.use((db) => {
                db.insert(InboxTable)
                  .values({
                    id: oldID,
                    receiver_session_id: session.id,
                    receiver_actor_id: "gc-actor",
                    sender_session_id: null,
                    sender_actor_id: null,
                    type: "text",
                    content: { text: "old message" },
                    created_at: eightDaysAgo,
                  })
                  .run()
                db.insert(InboxTable)
                  .values({
                    id: freshID,
                    receiver_session_id: session.id,
                    receiver_actor_id: "gc-actor",
                    sender_session_id: null,
                    sender_actor_id: null,
                    type: "text",
                    content: { text: "fresh message" },
                    created_at: oneHourAgo,
                  })
                  .run()
              }),
            ),
          )

          // Verify both rows exist before GC
          const beforeGC = await rt.runPromise(
            Effect.sync(() =>
              Database.use((db) =>
                db.select().from(InboxTable).where(eq(InboxTable.receiver_actor_id, "gc-actor")).all(),
              ),
            ),
          )
          expect(beforeGC.length).toBe(2)

          // Run GC with 7-day cutoff
          const cutoff = now - 7 * 24 * 60 * 60 * 1000
          await rt.runPromise(gcInboxRows(cutoff))

          // Verify only the fresh row remains
          const afterGC = await rt.runPromise(
            Effect.sync(() =>
              Database.use((db) =>
                db.select().from(InboxTable).where(eq(InboxTable.receiver_actor_id, "gc-actor")).all(),
              ),
            ),
          )
          expect(afterGC.length).toBe(1)
          expect(afterGC[0]!.id).toBe(freshID)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("gcInboxRows is idempotent — second call does nothing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = ManagedRuntime.make(testLayer)
        try {
          const session = await rt.runPromise(Session.Service.use((s) => s.create()))

          const now = Date.now()
          const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000
          const staleID = ulid()

          await rt.runPromise(
            Effect.sync(() =>
              Database.use((db) =>
                db
                  .insert(InboxTable)
                  .values({
                    id: staleID,
                    receiver_session_id: session.id,
                    receiver_actor_id: "gc-actor-2",
                    sender_session_id: null,
                    sender_actor_id: null,
                    type: "text",
                    content: { text: "stale" },
                    created_at: twoWeeksAgo,
                  })
                  .run(),
              ),
            ),
          )

          const cutoff = now - 7 * 24 * 60 * 60 * 1000

          // First pass removes the row
          await rt.runPromise(gcInboxRows(cutoff))
          const afterFirst = await rt.runPromise(
            Effect.sync(() =>
              Database.use((db) =>
                db.select().from(InboxTable).where(eq(InboxTable.receiver_actor_id, "gc-actor-2")).all(),
              ),
            ),
          )
          expect(afterFirst.length).toBe(0)

          // Second pass is a no-op — no error, still 0 rows
          await rt.runPromise(gcInboxRows(cutoff))
          const afterSecond = await rt.runPromise(
            Effect.sync(() =>
              Database.use((db) =>
                db.select().from(InboxTable).where(eq(InboxTable.receiver_actor_id, "gc-actor-2")).all(),
              ),
            ),
          )
          expect(afterSecond.length).toBe(0)
        } finally {
          await rt.dispose()
        }
      },
    })
  })
})
