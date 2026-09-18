import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database, eq } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { InstanceState } from "../../src/effect"
import { Bus } from "../../src/bus"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { GlobalBus } from "../../src/bus/global"
import { History } from "../../src/history"
import * as Writer from "../../src/history/writer"
import { Instance } from "../../src/project/instance"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

afterEach(async () => {
  Database.Client().$client.exec(
    "DROP TRIGGER IF EXISTS writer_probe_insert; DROP TRIGGER IF EXISTS writer_probe_update; DROP TABLE IF EXISTS writer_probe;",
  )
  Database.use((db) => {
    db.delete(HistoryFtsTable).run()
    db.delete(PartTable).run()
    db.delete(MessageTable).run()
    db.delete(SessionTable).run()
    db.delete(ProjectTable).run()
  })
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(History.defaultLayer, Bus.defaultLayer, CrossSpawnSpawner.defaultLayer))
const lifecycle = testEffect(CrossSpawnSpawner.defaultLayer)

function seedSession(label = "t") {
  const sessionID = SessionID.descending()
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: `proj_${label}` as any,
        worktree: "/tmp",
        sandboxes: [] as any,
        time_created: now,
        time_updated: now,
      } as any)
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID as any,
        project_id: `proj_${label}` as any,
        slug: "x",
        directory: "/tmp",
        title: "t",
        version: "1",
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(MessageTable)
      .values({
        id: `msg_${label}` as any,
        session_id: sessionID as any,
        agent_id: "main",
        data: { role: "user" } as any,
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return sessionID
}

function textEvent(sessionID: SessionID, label: string) {
  return {
    sessionID,
    part: {
      id: PartID.make(`prt_${label}`),
      sessionID,
      messageID: MessageID.make(`msg_${label}`),
      type: "text" as const,
      text: `text ${label}`,
    },
    time: Date.now(),
  }
}

function rowFor(partID: string) {
  return Database.use((db) => db.select().from(HistoryFtsTable).where(eq(HistoryFtsTable.part_id, partID)).get())
}

function waitForRow(partID: string) {
  return Effect.gen(function* () {
    for (;;) {
      const row = rowFor(partID)
      if (row) return row
      yield* Effect.sleep("10 millis")
    }
  }).pipe(Effect.timeout("2 seconds"))
}

describe("History.Writer", () => {
  // [TP-R12-06]
  it.live("initializes once without an Instance and indexes sessions from different directories", () =>
    Effect.gen(function* () {
      const writer = yield* Writer.Service
      const bus = yield* Bus.Service
      yield* writer.init()
      yield* writer.init()
      const first = yield* tmpdirScoped()
      const second = yield* tmpdirScoped()
      const a = seedSession("alpha")
      const b = seedSession("bravo")
      yield* bus.publish(MessageV2.Event.PartUpdated, textEvent(a, "alpha")).pipe(provideInstance(first))
      yield* writer.init().pipe(provideInstance(second))
      yield* bus.publish(MessageV2.Event.PartUpdated, textEvent(b, "bravo")).pipe(provideInstance(second))
      expect(yield* waitForRow("prt_alpha")).toMatchObject({
        session_id: a,
        project_id: "proj_alpha",
        body: "text alpha",
      })
      expect(yield* waitForRow("prt_bravo")).toMatchObject({
        session_id: b,
        project_id: "proj_bravo",
        body: "text bravo",
      })
      yield* Effect.promise(() => Instance.disposeDirectory(first))
      yield* bus
        .publish(MessageV2.Event.PartRemoved, {
          sessionID: b,
          messageID: MessageID.make("msg_bravo"),
          partID: PartID.make("prt_bravo"),
        })
        .pipe(provideInstance(second))
      yield* bus.publish(MessageV2.Event.PartUpdated, textEvent(b, "after_dispose")).pipe(provideInstance(second))
      expect(yield* waitForRow("prt_after_dispose")).toMatchObject({ session_id: b, project_id: "proj_bravo" })
      expect(rowFor("prt_bravo")).toBeUndefined()
      expect(rowFor("prt_alpha")?.session_id).toBe(a)
    }),
  )

  // [TP-R12-06]
  it.live("project ownership changes across reload are reflected in subsequent history", () =>
    Effect.gen(function* () {
      const writer = yield* Writer.Service
      const bus = yield* Bus.Service
      yield* writer.init()
      const dir = yield* tmpdirScoped()
      const sessionID = seedSession("ownership")
      seedSession("changed")
      const original = yield* InstanceState.context.pipe(provideInstance(dir))
      yield* bus.publish(MessageV2.Event.PartUpdated, textEvent(sessionID, "ownership")).pipe(provideInstance(dir))
      expect((yield* waitForRow("prt_ownership")).project_id).toBe("proj_ownership")
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ project_id: ProjectID.make("proj_changed") })
          .where(eq(SessionTable.id, sessionID))
          .run(),
      )
      yield* Effect.promise(() =>
        Instance.reload({
          directory: dir,
          worktree: dir,
          project: { ...original.project, id: ProjectID.make("proj_changed") },
        }),
      )
      yield* bus
        .publish(MessageV2.Event.PartUpdated, textEvent(sessionID, "ownership_changed"))
        .pipe(provideInstance(dir))
      expect((yield* waitForRow("prt_ownership_changed")).project_id).toBe("proj_changed")
      const history = yield* History.Service
      const hits = yield* history
        .search({ query: "ownership_changed", session_id: sessionID })
        .pipe(provideInstance(dir))
      expect(hits.map((hit) => hit.part_id)).toContain("prt_ownership_changed")
    }),
  )

  // [TP-R12-06]
  lifecycle.live("queued events cannot recreate history after their session is removed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sessionID = seedSession("removed")
      const event = textEvent(sessionID, "removed")
      Database.use((db) =>
        db
          .insert(PartTable)
          .values({
            id: event.part.id,
            message_id: event.part.messageID,
            session_id: sessionID,
            data: event.part,
            time_created: event.time,
            time_updated: event.time,
          })
          .run(),
      )
      yield* Effect.gen(function* () {
        const writer = yield* Writer.Service
        const bus = yield* Bus.Service
        yield* writer.init()
        yield* bus.publish(MessageV2.Event.PartUpdated, event)
        Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run())
      }).pipe(provideInstance(dir), Effect.provide(Writer.layer.pipe(Layer.provideMerge(Bus.defaultLayer))))
      expect(rowFor(event.part.id)).toBeUndefined()
    }),
  )

  // [TP-R12-06]
  it.live("repeated init consumes each local event once", () =>
    Effect.gen(function* () {
      const writer = yield* Writer.Service
      const bus = yield* Bus.Service
      const dir = yield* tmpdirScoped()
      const sessionID = seedSession("once")
      Database.Client().$client.exec(`
        CREATE TEMP TABLE writer_probe(n INTEGER NOT NULL);
        INSERT INTO writer_probe VALUES (0);
        CREATE TEMP TRIGGER writer_probe_insert AFTER INSERT ON history_fts BEGIN UPDATE writer_probe SET n = n + 1; END;
        CREATE TEMP TRIGGER writer_probe_update AFTER UPDATE ON history_fts BEGIN UPDATE writer_probe SET n = n + 1; END;
      `)
      yield* writer.init()
      yield* writer.init()
      yield* writer.init().pipe(provideInstance(dir))
      yield* bus.publish(MessageV2.Event.PartUpdated, textEvent(sessionID, "once")).pipe(provideInstance(dir))
      yield* waitForRow("prt_once")
      expect(Database.Client().$client.prepare("SELECT n FROM writer_probe").get()).toEqual({ n: 1 })
    }),
  )

  // [TP-R12-06]
  it.live("raw remote GlobalBus events cannot overwrite the local index", () =>
    Effect.gen(function* () {
      const writer = yield* Writer.Service
      const bus = yield* Bus.Service
      yield* writer.init()
      const dir = yield* tmpdirScoped()
      const sessionID = seedSession("remote")
      GlobalBus.emit("event", {
        workspace: "remote-workspace",
        payload: { type: MessageV2.Event.PartUpdated.type, properties: textEvent(sessionID, "remote_only") },
      })
      yield* bus
        .publish(MessageV2.Event.PartUpdated, textEvent(sessionID, "local_after_remote"))
        .pipe(provideInstance(dir))
      yield* waitForRow("prt_local_after_remote")
      expect(rowFor("prt_remote_only")).toBeUndefined()
      GlobalBus.emit("event", {
        workspace: "remote-workspace",
        payload: {
          type: MessageV2.Event.PartRemoved.type,
          properties: {
            sessionID,
            messageID: MessageID.make("msg_remote"),
            partID: PartID.make("prt_local_after_remote"),
          },
        },
      })
      yield* bus.publish(MessageV2.Event.PartUpdated, textEvent(sessionID, "local_barrier")).pipe(provideInstance(dir))
      yield* waitForRow("prt_local_barrier")
      expect(rowFor("prt_local_after_remote")?.session_id).toBe(sessionID)
    }),
  )

  // [TP-R12-06]
  it.live("keeps same-session actor messages attached to their own history records", () =>
    Effect.gen(function* () {
      const writer = yield* Writer.Service
      const bus = yield* Bus.Service
      yield* writer.init()
      const dir = yield* tmpdirScoped()
      const sessionID = seedSession("actors")
      const original = Database.use((db) =>
        db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.id, MessageID.make("msg_actors")))
          .get(),
      )
      if (!original) throw new Error("missing message fixture")
      Database.use((db) =>
        db
          .insert(MessageTable)
          .values({ ...original, id: MessageID.make("msg_worker"), agent_id: "worker" })
          .run(),
      )
      yield* bus.publish(MessageV2.Event.PartUpdated, textEvent(sessionID, "actors")).pipe(provideInstance(dir))
      yield* bus.publish(MessageV2.Event.PartUpdated, textEvent(sessionID, "worker")).pipe(provideInstance(dir))
      expect(yield* waitForRow("prt_actors")).toMatchObject({ session_id: sessionID, message_id: "msg_actors" })
      expect(yield* waitForRow("prt_worker")).toMatchObject({ session_id: sessionID, message_id: "msg_worker" })
      expect(
        Database.use((db) =>
          db
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.id, MessageID.make("msg_worker")))
            .get(),
        )?.agent_id,
      ).toBe("worker")
    }),
  )

  // [TP-R12-06]
  lifecycle.live("Runtime scope drains accepted local events before closing its consumer", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sessionID = seedSession("shutdown")
      yield* Effect.gen(function* () {
        const bus = yield* Bus.Service
        yield* Effect.gen(function* () {
          const writer = yield* Writer.Service
          yield* writer.init()
          for (let index = 0; index < 16; index++) {
            yield* bus
              .publish(MessageV2.Event.PartUpdated, textEvent(sessionID, `shutdown_${index}`))
              .pipe(provideInstance(dir))
          }
        }).pipe(Effect.provide(Writer.layer))
        for (let index = 0; index < 16; index++) {
          expect(rowFor(`prt_shutdown_${index}`)).toMatchObject({
            session_id: sessionID,
            body: `text shutdown_${index}`,
          })
        }
        yield* bus
          .publish(MessageV2.Event.PartUpdated, textEvent(sessionID, "after_shutdown"))
          .pipe(provideInstance(dir))
      }).pipe(Effect.provide(Bus.defaultLayer))
      expect(rowFor("prt_after_shutdown")).toBeUndefined()
    }),
  )

  it.live("PartUpdated for text part → writes one history_fts row", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = seedSession()
        const writer = yield* Writer.Service
        yield* writer.init()
        const bus = yield* Bus.Service
        yield* bus.publish(MessageV2.Event.PartUpdated, {
          sessionID: sessionID as any,
          part: {
            id: "prt_w1",
            sessionID: sessionID,
            messageID: "msg_t",
            type: "text",
            text: "hello data:image/png;base64,YWJj world",
          } as any,
          time: Date.now(),
        })

        yield* Effect.sleep("200 millis")

        const row = Database.use((db) =>
          db.select().from(HistoryFtsTable).where(eq(HistoryFtsTable.part_id, "prt_w1")).get(),
        )
        expect(row).toBeTruthy()
        expect(row?.body).toBe("hello [media image/png] world")
        expect(row?.body).not.toContain("YWJj")
        expect(row?.session_id).toBe(sessionID)
        expect(row?.project_id).toBe("proj_t")
      }),
    ),
  )

  it.live("PartRemoved deletes the row", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = seedSession()
        const writer = yield* Writer.Service
        yield* writer.init()
        const bus = yield* Bus.Service
        yield* bus.publish(MessageV2.Event.PartUpdated, {
          sessionID: sessionID as any,
          part: {
            id: "prt_w2",
            sessionID: sessionID,
            messageID: "msg_t",
            type: "text",
            text: "will be removed",
          } as any,
          time: Date.now(),
        })
        yield* Effect.sleep("200 millis")

        yield* bus.publish(MessageV2.Event.PartRemoved, {
          sessionID: sessionID as any,
          messageID: "msg_t" as any,
          partID: "prt_w2" as any,
        })
        yield* Effect.sleep("200 millis")

        const row = Database.use((db) =>
          db.select().from(HistoryFtsTable).where(eq(HistoryFtsTable.part_id, "prt_w2")).get(),
        )
        expect(row).toBeUndefined()
      }),
    ),
  )

  it.live("tool pending/running parts are NOT written", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = seedSession()
        const writer = yield* Writer.Service
        yield* writer.init()
        const bus = yield* Bus.Service
        yield* bus.publish(MessageV2.Event.PartUpdated, {
          sessionID: sessionID as any,
          part: {
            id: "prt_w3",
            sessionID: sessionID,
            messageID: "msg_t",
            type: "tool",
            tool: "Bash",
            state: { status: "running", input: { command: "ls" } },
          } as any,
          time: Date.now(),
        })
        yield* Effect.sleep("200 millis")

        const row = Database.use((db) =>
          db.select().from(HistoryFtsTable).where(eq(HistoryFtsTable.part_id, "prt_w3")).get(),
        )
        expect(row).toBeUndefined()
      }),
    ),
  )
})
