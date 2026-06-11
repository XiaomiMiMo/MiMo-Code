import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { HistoryTool } from "../../src/tool/history"
import { History } from "../../src/history"
import { Truncate } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"

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

const it = testEffect(
  Layer.mergeAll(History.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("HistoryTool", () => {
  it.live("operation=search returns markdown with hits", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        Database.use((db) => {
          db.insert(HistoryFtsTable)
            .values({
              part_id: "p1",
              session_id: "ses_a",
              message_id: "msg_a",
              project_id: "proj_a",
              kind: "user_text",
              tool_name: null,
              body: "JWT signing test",
              time_created: 1000,
            })
            .run()
        })
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "search", query: "JWT", scope: "global" },
          ctx as any,
        )
        expect(result.output).toContain("msg_a")
        expect(result.output).toContain("JWT")
        expect(result.metadata.count).toBe(1)
      }),
    ),
  )

  it.live("operation=search with no hits returns empty message", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "search", query: "nothing", scope: "global" },
          ctx as any,
        )
        expect(result.metadata.count).toBe(0)
        expect(result.output).toContain("0 matches")
      }),
    ),
  )

  it.live("operation=around returns marked anchor message", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({ id: "p" as any, worktree: "/tmp", sandboxes: [] as any, time_created: now, time_updated: now } as any)
            .run()
          db.insert(SessionTable)
            .values({
              id: "ses_z" as any,
              project_id: "p" as any,
              slug: "x",
              directory: "/tmp",
              title: "t",
              version: "1",
              time_created: now,
              time_updated: now,
            })
            .run()
          for (let i = 0; i < 3; i++) {
            db.insert(MessageTable)
              .values({
                id: `m${i}` as any,
                session_id: "ses_z" as any,
                agent_id: "main",
                data: { role: "user" } as any,
                time_created: now + i,
                time_updated: now + i,
              })
              .run()
            db.insert(PartTable)
              .values({
                id: `pt${i}` as any,
                message_id: `m${i}` as any,
                session_id: "ses_z" as any,
                data: { type: "text", text: `body ${i}` } as any,
                time_created: now + i,
                time_updated: now + i,
              })
              .run()
          }
        })
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "around", message_id: "m1", before: 1, after: 1 },
          ctx as any,
        )
        expect(result.output).toContain(">>> m1")
        expect(result.output).toContain("m0")
        expect(result.output).toContain("m2")
      }),
    ),
  )
})
