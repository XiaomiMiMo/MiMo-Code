import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { HistoryTool } from "../../src/tool/history"
import { History } from "../../src/history"
import { Truncate } from "../../src/tool"
import { Provider } from "../../src/provider"
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
  Layer.mergeAll(
    History.defaultLayer,
    Provider.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
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
        const result = yield* tool.execute({ operation: "search", query: "JWT", scope: "global" }, ctx as any)
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
        const result = yield* tool.execute({ operation: "search", query: "nothing", scope: "global" }, ctx as any)
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
            .values({
              id: "p" as any,
              worktree: "/tmp",
              sandboxes: [] as any,
              time_created: now,
              time_updated: now,
            } as any)
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
        const result = yield* tool.execute({ operation: "around", message_id: "m1", before: 1, after: 1 }, ctx as any)
        expect(result.output).toContain(">>> message_id=m1")
        expect(result.output).toContain("m0")
        expect(result.output).toContain("m2")
      }),
    ),
  )

  it.live("operation=around keeps a huge anchor partially instead of dropping it", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: "p" as any,
              worktree: "/tmp",
              sandboxes: [] as any,
              time_created: now,
              time_updated: now,
            } as any)
            .run()
          db.insert(SessionTable)
            .values({
              id: "ses_huge" as any,
              project_id: "p" as any,
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
              id: "m_huge" as any,
              session_id: "ses_huge" as any,
              agent_id: "main",
              data: { role: "user" } as any,
              time_created: now,
              time_updated: now,
            })
            .run()
          // Each part summary is capped ~1KB by history.summary(); 25 parts
          // exceed the 19500 around budget so the full anchor block cannot fit.
          for (let i = 0; i < 25; i++) {
            db.insert(PartTable)
              .values({
                id: `pt_huge_${i}` as any,
                message_id: "m_huge" as any,
                session_id: "ses_huge" as any,
                data: { type: "text", text: `PART-${i} ` + "x".repeat(2000) } as any,
                time_created: now + i,
                time_updated: now + i,
              })
              .run()
          }
          db.insert(MessageTable)
            .values({
              id: "m_small" as any,
              session_id: "ses_huge" as any,
              agent_id: "main",
              data: { role: "user" } as any,
              time_created: now + 100,
              time_updated: now + 100,
            })
            .run()
          db.insert(PartTable)
            .values({
              id: "pt_small" as any,
              message_id: "m_small" as any,
              session_id: "ses_huge" as any,
              data: { type: "text", text: "small neighbor" } as any,
              time_created: now + 100,
              time_updated: now + 100,
            })
            .run()
        })
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "around", message_id: "m_huge", before: 1, after: 1 },
          ctx as any,
        )
        // Anchor header must survive even when the full block cannot fit.
        // Part ids sort as strings (pt_huge_0, pt_huge_1, pt_huge_10, …), so
        // later numeric parts are the ones dropped by the partial accept.
        expect(result.output).toContain(">>> message_id=m_huge")
        expect(result.output).toContain("part_id=pt_huge_0")
        expect(result.output).toContain("Anchor truncated")
        expect(result.output).not.toContain("part_id=pt_huge_9 ")
        expect(result.metadata.truncated).toBe(true)
      }),
    ),
  )
})
