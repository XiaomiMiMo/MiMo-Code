import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ulid } from "ulid"
import { Inbox } from "../../src/inbox"
import { gcInboxRows } from "../../src/inbox/inbox"
import { InboxLaneStateTable, InboxTable } from "../../src/inbox/inbox.sql"
import { Database, eq } from "../../src/storage"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer, CrossSpawnSpawner.defaultLayer))
const boot = () => Effect.scoped(Inbox.Service.use(() => Effect.void).pipe(Effect.provide(Inbox.defaultLayer)))

// inbox (g), (l), (m)
describe("Inbox startup conversion and GC", () => {
  it.live("GC retains pending inputs and uses terminal update time", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const now = Date.now()
    const old = now - 8 * 24 * 60 * 60 * 1000
    const states = ["accepted", "claimed", "settled", "cancelled", "rejected"] as const
    yield* Effect.sync(() => Database.use((db) => {
      for (const state of states) db.insert(InboxTable).values({
        id: state, receiver_session_id: session.id, receiver_actor_id: "main", state,
        content: null, created_at: old, time_updated: old,
      }).run()
      db.insert(InboxTable).values({
        id: "recently-settled", receiver_session_id: session.id, receiver_actor_id: "main", state: "settled",
        content: null, created_at: old, time_updated: now,
      }).run()
    }))
    yield* gcInboxRows(now - 7 * 24 * 60 * 60 * 1000)
    const remaining = () => Database.use((db) => db.select().from(InboxTable)
      .where(eq(InboxTable.receiver_session_id, session.id)).all().map((row) => row.id).sort())
    expect(remaining()).toEqual(["accepted", "claimed", "recently-settled"])
    yield* gcInboxRows(now - 7 * 24 * 60 * 60 * 1000)
    expect(remaining()).toEqual(["accepted", "claimed", "recently-settled"])
  })))

  it.live("startup converts legacy rows across instances once and rejects blank content", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const first = yield* sessions.create()
    const other = yield* tmpdirScoped({ git: true })
    const second = yield* provideInstance(other)(sessions.create())
    const ids = [ulid(), ulid(), ulid()]
    yield* Effect.sync(() => Database.use((db) => {
      for (const [index, session] of [first, second, first].entries()) db.insert(InboxTable).values({
        id: ids[index], receiver_session_id: session.id, receiver_actor_id: "main", type: "actor_notification",
        content: { text: index === 2 ? "  \n" : `legacy-${index}` },
        created_at: Date.now() - 9 * 24 * 60 * 60 * 1000, time_updated: Date.now(),
      }).run()
    }))
    yield* boot()
    const rows = () => Database.use((db) => db.select().from(InboxTable).all().filter((row) => ids.includes(row.id)))
    for (const [index, session] of [first, second].entries()) {
      const row = rows().find((row) => row.id === ids[index])!
      expect(row.state).toBe("accepted")
      expect(row.content).toBeNull()
      expect(row.input_message_id).toBeTruthy()
      const messages = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
      expect(messages).toHaveLength(1)
      expect(messages[0].info.id).toBe(row.input_message_id!)
      expect(messages[0].parts).toEqual([expect.objectContaining({ type: "text", synthetic: true, text: `legacy-${index}` })])
    }
    const rejected = rows().find((row) => row.id === ids[2])!
    expect(rejected.state).toBe("rejected")
    expect(rejected.content).toBeNull()
    expect(rejected.input_message_id).toBeNull()
    const before = rows()
    const revisions = () => Database.use((db) => db.select().from(InboxLaneStateTable).all())
    const beforeRevisions = revisions()
    yield* boot()
    expect(rows()).toEqual(before)
    expect(revisions()).toEqual(beforeRevisions)
  }), { git: true }))
})
