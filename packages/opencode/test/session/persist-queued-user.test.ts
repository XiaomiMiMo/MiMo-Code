import { afterEach, describe, expect, spyOn } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { TurnReceiptTable, TurnSessionEpochTable } from "../../src/turn-queue/turn-queue.sql"
import { Database, eq } from "../../src/storage"
import { SyncEvent } from "../../src/sync"
import { EventSequenceTable, EventTable } from "../../src/sync/event.sql"
import { Flag } from "../../src/flag/flag"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await Instance.disposeAll()
})

function input(sessionID: SessionID) {
  const message: MessageV2.User = {
    id: MessageID.ascending(), sessionID, agentID: "main", role: "user", time: { created: Date.now() },
    agent: "build", model: { providerID: ProviderID.zod.parse("test"), modelID: ModelID.zod.parse("test") },
    queueAdmission: { epoch: 999, ready: true, dispatch: false },
  }
  const parts: MessageV2.Part[] = [
    { id: PartID.ascending(), sessionID, messageID: message.id, type: "text", text: "external queued input" },
    { id: PartID.ascending(), sessionID, messageID: message.id, type: "file", mime: "image/png", url: "data:image/png;base64,AA==" },
  ]
  return { message, parts }
}

function snapshot(sessionID: SessionID) {
  return Database.use((db) => ({
    messages: db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all(),
    parts: db.select().from(PartTable).where(eq(PartTable.session_id, sessionID)).all(),
    events: db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all(),
    sequence: db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get(),
    actors: db.select().from(ActorRegistryTable).where(eq(ActorRegistryTable.session_id, sessionID)).all(),
  }))
}

describe("Session.persistQueuedUser", () => {
  for (const dispatch of [false, true]) {
    it.live(
      `commits the complete input before sync and bus events with dispatch=${dispatch}`,
      provideTmpdirInstance(() => Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "atomic queued input" })
        const data = input(session.id)
        yield* Effect.sync(() => Database.use((db) => db.insert(TurnSessionEpochTable)
          .values({ session_id: session.id, epoch: 4, time_updated: Date.now() }).run()))
        const syncEvents: string[] = []
        const busEvents: string[] = []
        const seen: MessageV2.WithParts[] = []
        const published = yield* Deferred.make<void>()
        const listener = (event: GlobalEvent) => {
          const payload = event.payload
          const sync = payload.type === "sync" && payload.syncEvent.aggregateID === session.id
          const bus = payload.properties?.sessionID === session.id &&
            [MessageV2.Event.Updated.type, MessageV2.Event.PartUpdated.type].includes(payload.type)
          if (!sync && !bus) return
          seen.push(MessageV2.get({ sessionID: session.id, messageID: data.message.id }))
          if (sync) syncEvents.push(payload.syncEvent.type)
          if (bus) busEvents.push(payload.type)
          if (busEvents.length === 3) Deferred.doneUnsafe(published, Effect.void)
        }
        const workspaces = Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES
        Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = true
        GlobalBus.on("event", listener)
        try {
          const saved = yield* sessions.persistQueuedUser({ ...data, dispatch })
          yield* Deferred.await(published).pipe(Effect.timeout("2 seconds"))
          expect(saved.queueAdmission).toEqual({ epoch: 4, ready: true, dispatch })
          expect(data.message.queueAdmission).toEqual({ epoch: 999, ready: true, dispatch: false })
          expect(saved).not.toBe(data.message)
          expect(syncEvents).toEqual(["message.updated.1", "message.part.updated.1", "message.part.updated.1"])
          expect(busEvents).toEqual(["message.updated", "message.part.updated", "message.part.updated"])
          expect(seen).toHaveLength(6)
          for (const visible of seen) {
            expect(visible.info).toEqual(saved)
            expect(visible.parts).toEqual(data.parts)
          }
          const committed = yield* Effect.sync(() => snapshot(session.id))
          expect(committed.events.map((event) => event.seq)).toEqual([0, 1, 2])
          expect(committed.sequence?.seq).toBe(2)
          expect(committed.actors.find((actor) => actor.actor_id === "main")?.last_activity_time).toBeGreaterThan(0)
          expect(yield* Effect.sync(() => Database.use((db) => db.select().from(TurnReceiptTable)
            .where(eq(TurnReceiptTable.session_id, session.id)).all()))).toEqual([])
        } finally {
          GlobalBus.off("event", listener)
          Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = workspaces
        }
      })),
    )
  }

  it.live(
    "rolls back message, all parts, sync sequence and activity without publishing on a late part failure",
    provideTmpdirInstance(() => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "queued input rollback" })
      const data = input(session.id)
      const before = yield* Effect.sync(() => snapshot(session.id))
      const emitted: string[] = []
      const listener = (event: GlobalEvent) => {
        if (event.payload.syncEvent?.aggregateID === session.id || event.payload.properties?.sessionID === session.id)
          emitted.push(event.payload.type)
      }
      const run = SyncEvent.run
      const failure = new Error("injected failure after the last part projector")
      let wroteLastPart = false
      const cut = spyOn(SyncEvent, "run").mockImplementation((definition, event, options) => {
        const result = run(definition, event, options)
        const part = "part" in event ? event.part as MessageV2.Part : undefined
        if (definition.type === MessageV2.Event.PartUpdated.type && part?.id === data.parts[1].id) {
          wroteLastPart = true
          throw failure
        }
        return result
      })
      const workspaces = Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES
      Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = true
      GlobalBus.on("event", listener)
      try {
        const result = yield* sessions.persistQueuedUser({ ...data, dispatch: true }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(wroteLastPart).toBe(true)
        expect(yield* Effect.sync(() => snapshot(session.id))).toEqual(before)
        yield* Effect.yieldNow
        expect(emitted).toEqual([])
      } finally {
        cut.mockRestore()
        GlobalBus.off("event", listener)
        Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = workspaces
      }
      const saved = yield* sessions.persistQueuedUser({ ...data, dispatch: false })
      expect(saved.queueAdmission).toEqual({ epoch: 0, ready: true, dispatch: false })
      expect(MessageV2.get({ sessionID: session.id, messageID: saved.id }).parts).toEqual(data.parts)
    })),
  )

  it.live(
    "uses the transaction epoch and participates in an enclosing rollback",
    provideTmpdirInstance(() => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "queued epoch boundary" })
      const data = input(session.id)
      yield* Effect.sync(() => Database.use((db) => db.insert(TurnSessionEpochTable)
        .values({ session_id: session.id, epoch: 2, time_updated: Date.now() }).run()))
      const before = yield* Effect.sync(() => snapshot(session.id))
      let saved: MessageV2.User | undefined
      const result = yield* Effect.sync(() => Database.transaction((db) => {
        db.update(TurnSessionEpochTable).set({ epoch: 3 }).where(eq(TurnSessionEpochTable.session_id, session.id)).run()
        saved = Effect.runSync(sessions.persistQueuedUser({ ...data, dispatch: true }))
        throw new Error("outer rollback")
      })).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(saved?.queueAdmission).toEqual({ epoch: 3, ready: true, dispatch: true })
      expect(yield* Effect.sync(() => snapshot(session.id))).toEqual(before)
      expect(yield* Effect.sync(() => Database.use((db) => db.select().from(TurnSessionEpochTable)
        .where(eq(TurnSessionEpochTable.session_id, session.id)).get()?.epoch))).toBe(2)
    })),
  )
})
