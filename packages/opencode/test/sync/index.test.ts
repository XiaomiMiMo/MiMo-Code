import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import z from "zod"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import { Instance } from "../../src/project/instance"
import { SyncEvent } from "../../src/sync"
import { Database, eq } from "../../src/storage"
import { EventSequenceTable, EventTable } from "../../src/sync/event.sql"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as QueueSync from "../../src/turn-queue/sync"
import { Identifier } from "../../src/id/id"
import { Flag } from "../../src/flag/flag"
import { initProjectors } from "../../src/server/projectors"

const original = Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES

beforeEach(() => {
  Database.close()

  Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = true
})

afterEach(() => {
  Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = original
})

function withInstance(fn: () => void | Promise<void>) {
  return async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await fn()
      },
    })
  }
}

describe("SyncEvent", () => {
  function setup(project = (_db: Database.TxOrDb, _data: { id: string; name: string }) => {}) {
    SyncEvent.reset()

    const Created = SyncEvent.define({
      type: "item.created",
      version: 1,
      aggregate: "id",
      schema: z.object({ id: z.string(), name: z.string() }),
    })
    const Sent = SyncEvent.define({
      type: "item.sent",
      version: 1,
      aggregate: "item_id",
      schema: z.object({ item_id: z.string(), to: z.string() }),
    })

    SyncEvent.init({
      projectors: [SyncEvent.project(Created, project), SyncEvent.project(Sent, () => {})],
    })

    return { Created, Sent }
  }

  afterAll(() => {
    SyncEvent.reset()
    initProjectors()
  })

  describe("run", () => {
    test(
      "inserts event row",
      withInstance(() => {
        const { Created } = setup()
        SyncEvent.run(Created, { id: "evt_1", name: "first" })
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].type).toBe("item.created.1")
        expect(rows[0].aggregate_id).toBe("evt_1")
      }),
    )

    test(
      "increments seq per aggregate",
      withInstance(() => {
        const { Created } = setup()
        SyncEvent.run(Created, { id: "evt_1", name: "first" })
        SyncEvent.run(Created, { id: "evt_1", name: "second" })
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(2)
        expect(rows[1].seq).toBe(rows[0].seq + 1)
      }),
    )

    test(
      "uses custom aggregate field from agg()",
      withInstance(() => {
        const { Sent } = setup()
        SyncEvent.run(Sent, { item_id: "evt_1", to: "james" })
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].aggregate_id).toBe("evt_1")
      }),
    )

    test(
      "emits events",
      withInstance(async () => {
        const { Created } = setup()
        const events: Array<{
          type: string
          properties: { id: string; name: string }
        }> = []
        const received = new Promise<void>((resolve) => {
          Bus.subscribeAll((event) => {
            events.push(event)
            resolve()
          })
        })

        SyncEvent.run(Created, { id: "evt_1", name: "test" })

        await received
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({
          type: "item.created",
          properties: {
            id: "evt_1",
            name: "test",
          },
        })
      }),
    )
  })

  describe("replay", () => {
    test("rejects payload aggregate mismatch for a non-session aggregate before any projector or log writes", withInstance(() => {
      let projected = 0
      const { Sent } = setup()
      SyncEvent.init({ projectors: [SyncEvent.project(Sent, () => { projected++ })] })
      const event = { id: "bad-custom", type: "item.sent.1", seq: 0, aggregateID: "outer", data: { item_id: "inner", to: "receiver" } }
      expect(() => SyncEvent.replay(event)).toThrow(SyncEvent.ReplayValidationError)
      expect(projected).toBe(0)
      expect(Database.use((db) => db.select().from(EventSequenceTable).all())).toEqual([])
      expect(Database.use((db) => db.select().from(EventTable).all())).toEqual([])
      SyncEvent.replay({ ...event, data: { ...event.data, item_id: "outer" } })
      expect(projected).toBe(1)
      expect(Database.use((db) => db.select().from(EventTable).all())).toHaveLength(1)
    }))

    test("rejects queue payload aggregate mismatch without mutating either queue or consuming a sequence", withInstance(async () => {
      SyncEvent.reset()
      initProjectors()
      const session = await AppRuntime.runPromise(Session.Service.use((service) => service.create({ title: "aggregate victim" })))
      const other = SessionID.descending()
      const before = QueueSync.capture(session.id)
      const history = Database.use((db) => db.select().from(EventTable).all())
      const event = {
        id: "bad-queue", type: "session.turn_queue.delta.1", seq: 0, aggregateID: other,
        data: { sessionID: session.id, epoch: { session_id: session.id, epoch: 99, time_updated: 1 } },
      }
      expect(() => SyncEvent.replay(event)).toThrow(SyncEvent.ReplayValidationError)
      expect(QueueSync.capture(session.id)).toEqual(before)
      expect(QueueSync.capture(other).epoch).toBeNull()
      expect(Database.use((db) => db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, other)).get())).toBeUndefined()
      expect(Database.use((db) => db.select().from(EventTable).all())).toEqual(history)
    }))

    test("direct replay fences nested message and part ownership, key collisions, and removals", withInstance(async () => {
      SyncEvent.reset()
      initProjectors()
      const own = await AppRuntime.runPromise(Session.Service.use((service) => service.create({ title: "own" })))
      const victim = await AppRuntime.runPromise(Session.Service.use((service) => service.create({ title: "victim" })))
      const user = (sessionID: SessionID) => ({
        id: MessageID.ascending(), sessionID, role: "user" as const, agent: "build", time: { created: 1 },
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      })
      const ownUser = user(own.id)
      const victimUser = user(victim.id)
      const ownPart = { id: PartID.ascending(), sessionID: own.id, messageID: ownUser.id, type: "text", text: "owned" }
      const victimPart = { ...ownPart, id: PartID.ascending(), sessionID: victim.id, messageID: victimUser.id, text: "victim" }
      const next = (sessionID: SessionID, type: string, data: Record<string, unknown>): SyncEvent.SerializedEvent => ({
        id: MessageID.ascending(), aggregateID: sessionID, type, data,
        seq: (Database.use((db) => db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get())?.seq ?? -1) + 1,
      })
      for (const [info, part] of [[ownUser, ownPart], [victimUser, victimPart]] as const) {
        SyncEvent.replay(next(info.sessionID, "message.updated.1", { sessionID: info.sessionID, info }))
        SyncEvent.replay(next(info.sessionID, "message.part.updated.1", { sessionID: info.sessionID, part, time: 1 }))
      }
      const state = () => Database.use((db) => ({
        messages: db.select().from(MessageTable).all(), parts: db.select().from(PartTable).all(),
        events: db.select().from(EventTable).all(), sequences: db.select().from(EventSequenceTable).all(),
        queue: QueueSync.capture(own.id, db),
      }))
      const before = state()
      const updates = [
        { type: "session.created.1", data: { sessionID: own.id, info: { ...own, id: victim.id } } },
        { type: "session.updated.1", data: { sessionID: own.id, info: { id: victim.id } } },
        { type: "session.updated.2", data: { sessionID: own.id, info: { id: victim.id } } },
        { type: "session.deleted.1", data: { sessionID: own.id, info: victim } },
        { type: "message.updated.1", data: { sessionID: own.id, info: { ...ownUser, id: MessageID.ascending(), sessionID: victim.id } } },
        { type: "message.updated.1", data: { sessionID: own.id, info: { ...ownUser, id: victimUser.id } } },
        { type: "message.part.updated.1", data: { sessionID: own.id, part: { ...ownPart, id: PartID.ascending(), sessionID: victim.id }, time: 2 } },
        { type: "message.part.updated.1", data: { sessionID: own.id, part: { ...ownPart, id: victimPart.id }, time: 2 } },
        { type: "message.part.updated.1", data: { sessionID: own.id, part: { ...ownPart, id: PartID.ascending(), messageID: victimUser.id }, time: 2 } },
        { type: "message.removed.1", data: { sessionID: own.id, messageID: victimUser.id } },
        { type: "message.part.removed.1", data: { sessionID: own.id, messageID: ownUser.id, partID: victimPart.id } },
        { type: "message.part.removed.1", data: { sessionID: own.id, messageID: MessageID.ascending(), partID: ownPart.id } },
      ]
      const published = spyOn(GlobalBus, "emit")
      try {
        for (const update of updates) {
          const first = next(own.id, "session.turn_queue.delta.1", { sessionID: own.id, epoch: { session_id: own.id, epoch: 2, time_updated: 1 } })
          const bad = { ...next(own.id, update.type, update.data), seq: first.seq + 1 }
          expect(() => SyncEvent.replayAll([first, bad], { publish: true })).toThrow(SyncEvent.ReplayValidationError)
          expect(state()).toEqual(before)
        }
        expect(published).not.toHaveBeenCalled()
      } finally {
        published.mockRestore()
      }
      SyncEvent.replay(next(own.id, "message.part.updated.1", { sessionID: own.id, part: { ...ownPart, text: "valid update" }, time: 2 }))
      expect(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, ownPart.id)).get())?.data).toMatchObject({ text: "valid update" })
      SyncEvent.replay(next(own.id, "message.part.removed.1", { sessionID: own.id, messageID: ownUser.id, partID: ownPart.id }))
      SyncEvent.replay(next(own.id, "message.removed.1", { sessionID: own.id, messageID: ownUser.id }))
      expect(Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, ownUser.id)).get())).toBeUndefined()
      expect(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, victimPart.id)).get())).toBeDefined()
    }))

    test("rejects missing and non-string aggregate fields, including mismatched duplicate events", withInstance(() => {
      let projected = 0
      setup(() => { projected++ })
      const event = { id: "valid-first", type: "item.created.1", seq: 0, aggregateID: "owned", data: { id: "owned", name: "first" } }
      SyncEvent.replay(event)
      const before = Database.use((db) => db.select().from(EventTable).all())
      for (const data of [{ name: "missing" }, { id: 7, name: "number" }, { id: "foreign", name: "mismatch" }]) {
        expect(() => SyncEvent.replay({ ...event, data })).toThrow(SyncEvent.ReplayValidationError)
        expect(() => SyncEvent.replay({ ...event, id: "next-invalid", seq: 1, data })).toThrow(SyncEvent.ReplayValidationError)
      }
      expect(projected).toBe(1)
      expect(Database.use((db) => db.select().from(EventTable).all())).toEqual(before)
      expect(Database.use((db) => db.select().from(EventSequenceTable).all())).toEqual([{ aggregate_id: "owned", seq: 0 }])
      SyncEvent.replay(event)
      expect(projected).toBe(1)
    }))

    test("a late aggregate mismatch rolls back its whole batch even inside the caller transaction", withInstance(() => {
      let effects = 0
      setup((db, data) => {
        db.insert(EventSequenceTable).values({ aggregate_id: `projector-${data.name}`, seq: 0 }).run()
        Database.effect(() => { effects++ })
      })
      const initial = { id: "initial", type: "item.created.1", seq: 0, aggregateID: "batch", data: { id: "batch", name: "initial" } }
      SyncEvent.replay(initial)
      const beforeEvents = Database.use((db) => db.select().from(EventTable).all())
      const beforeSequences = Database.use((db) => db.select().from(EventSequenceTable).all())
      effects = 0
      const history = [
        { ...initial, id: "next", seq: 1, data: { id: "batch", name: "next" } },
        { ...initial, id: "foreign", seq: 2, data: { id: "foreign", name: "foreign" } },
      ]
      expect(() => Database.transaction(() => SyncEvent.replayAll(history))).toThrow(SyncEvent.ReplayValidationError)
      expect(Database.use((db) => db.select().from(EventTable).all())).toEqual(beforeEvents)
      expect(Database.use((db) => db.select().from(EventSequenceTable).all())).toEqual(beforeSequences)
      expect(effects).toBe(0)
      SyncEvent.replay({ ...history[0], id: "valid-retry" })
      expect(effects).toBe(1)
    }))

    test("preserves a real SQLite constraint failure and rolls back earlier event log writes", withInstance(() => {
      let effects = 0
      setup(() => { Database.effect(() => { effects++ }) })
      const history = [0, 1].map((seq) => ({
        id: "duplicate-log-id", type: "item.created.1", seq, aggregateID: "batch",
        data: { id: "batch", name: `item-${seq}` },
      }))
      let failure: unknown
      try {
        SyncEvent.replayAll(history)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(SyncEvent.ReplayValidationError)
      expect((failure as Error).message).toContain("UNIQUE constraint failed")
      expect(Database.use((db) => db.select().from(EventTable).all())).toEqual([])
      expect(Database.use((db) => db.select().from(EventSequenceTable).all())).toEqual([])
      expect(effects).toBe(0)
    }))

    test("rolls back earlier replayAll writes and deferred effects when a later projector fails", withInstance(() => {
      const failure = new Error("storage failure")
      let published = 0
      const { Created } = setup((db, data) => {
        db.insert(EventSequenceTable).values({ aggregate_id: `projector-${data.name}`, seq: 0 }).run()
        Database.effect(() => { published++ })
        if (data.name === "second") throw failure
      })
      const history = ["first", "second"].map((name, seq) => ({
        id: `batch-${seq}`, type: SyncEvent.versionedType(Created.type, Created.version), seq,
        aggregateID: "batch", data: { id: "batch", name },
      }))
      expect(() => SyncEvent.replayAll(history)).toThrow(failure)
      expect(Database.use((db) => db.select().from(EventTable).all())).toEqual([])
      expect(Database.use((db) => db.select().from(EventSequenceTable).all())).toEqual([])
      expect(published).toBe(0)
    }))

    test(
      "inserts event from external payload",
      withInstance(() => {
        setup()
        const id = Identifier.descending("message")
        SyncEvent.replay({
          id: "evt_1",
          type: "item.created.1",
          seq: 0,
          aggregateID: id,
          data: { id, name: "replayed" },
        })
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].aggregate_id).toBe(id)
      }),
    )

    test(
      "throws on sequence mismatch",
      withInstance(() => {
        setup()
        const id = Identifier.descending("message")
        SyncEvent.replay({
          id: "evt_1",
          type: "item.created.1",
          seq: 0,
          aggregateID: id,
          data: { id, name: "first" },
        })
        expect(() =>
          SyncEvent.replay({
            id: "evt_1",
            type: "item.created.1",
            seq: 5,
            aggregateID: id,
            data: { id, name: "bad" },
          }),
        ).toThrow(/Sequence mismatch/)
      }),
    )

    test(
      "throws on unknown event type",
      withInstance(() => {
        setup()
        expect(() =>
          SyncEvent.replay({
            id: "evt_1",
            type: "unknown.event.1",
            seq: 0,
            aggregateID: "x",
            data: {},
          }),
        ).toThrow(/Unknown event type/)
      }),
    )

    test(
      "replayAll accepts later chunks after the first batch",
      withInstance(() => {
        const { Created } = setup()
        const id = Identifier.descending("message")

        const one = SyncEvent.replayAll([
          {
            id: "evt_1",
            type: SyncEvent.versionedType(Created.type, Created.version),
            seq: 0,
            aggregateID: id,
            data: { id, name: "first" },
          },
          {
            id: "evt_2",
            type: SyncEvent.versionedType(Created.type, Created.version),
            seq: 1,
            aggregateID: id,
            data: { id, name: "second" },
          },
        ])

        const two = SyncEvent.replayAll([
          {
            id: "evt_3",
            type: SyncEvent.versionedType(Created.type, Created.version),
            seq: 2,
            aggregateID: id,
            data: { id, name: "third" },
          },
          {
            id: "evt_4",
            type: SyncEvent.versionedType(Created.type, Created.version),
            seq: 3,
            aggregateID: id,
            data: { id, name: "fourth" },
          },
        ])

        expect(one).toBe(id)
        expect(two).toBe(id)

        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
      }),
    )
  })
})
