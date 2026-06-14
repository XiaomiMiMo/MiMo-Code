import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database, eq } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { Bus } from "../../src/bus"
import { MessageV2 } from "../../src/session/message-v2"
import { History } from "../../src/history"
import * as Writer from "../../src/history/writer"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

afterEach(async () => {
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

function seedSession() {
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: "proj_t" as any,
        worktree: "/tmp",
        sandboxes: [] as any,
        time_created: now,
        time_updated: now,
      } as any)
      .run()
    db.insert(SessionTable)
      .values({
        id: "ses_t" as any,
        project_id: "proj_t" as any,
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
        id: "msg_t" as any,
        session_id: "ses_t" as any,
        agent_id: "main",
        data: { role: "user" } as any,
        time_created: now,
        time_updated: now,
      })
      .run()
  })
}

describe("History.Writer", () => {
  it.live("PartUpdated for text part → writes one history_fts row", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedSession()
        const writer = yield* Writer.Service
        yield* writer.init()
        const bus = yield* Bus.Service
        yield* bus.publish(MessageV2.Event.PartUpdated, {
          sessionID: "ses_t" as any,
          part: {
            id: "prt_w1",
            sessionID: "ses_t",
            messageID: "msg_t",
            type: "text",
            text: "hello world",
          } as any,
          time: Date.now(),
        })

        yield* Effect.sleep("200 millis")

        const row = Database.use((db) =>
          db.select().from(HistoryFtsTable).where(eq(HistoryFtsTable.part_id, "prt_w1")).get(),
        )
        expect(row).toBeTruthy()
        expect(row?.body).toBe("hello world")
        expect(row?.kind).toBe("user_text")
        expect(row?.session_id).toBe("ses_t")
        expect(row?.project_id).toBe("proj_t")
      }),
    ),
  )

  it.live("PartRemoved deletes the row", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedSession()
        const writer = yield* Writer.Service
        yield* writer.init()
        const bus = yield* Bus.Service
        yield* bus.publish(MessageV2.Event.PartUpdated, {
          sessionID: "ses_t" as any,
          part: {
            id: "prt_w2",
            sessionID: "ses_t",
            messageID: "msg_t",
            type: "text",
            text: "will be removed",
          } as any,
          time: Date.now(),
        })
        yield* Effect.sleep("200 millis")

        yield* bus.publish(MessageV2.Event.PartRemoved, {
          sessionID: "ses_t" as any,
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
        seedSession()
        const writer = yield* Writer.Service
        yield* writer.init()
        const bus = yield* Bus.Service
        yield* bus.publish(MessageV2.Event.PartUpdated, {
          sessionID: "ses_t" as any,
          part: {
            id: "prt_w3",
            sessionID: "ses_t",
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
