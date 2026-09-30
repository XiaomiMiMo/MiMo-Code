import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { History } from "../../src/history"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const wipe = () => {
  Database.use((db) => {
    db.delete(HistoryFtsTable).run()
    db.delete(PartTable).run()
    db.delete(MessageTable).run()
    db.delete(SessionTable).run()
    db.delete(ProjectTable).run()
  })
}

beforeEach(() => wipe())
afterEach(async () => {
  wipe()
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(History.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("History.search chunked parts", () => {
  it.live("multi-chunk part does not hide other distinct parts under LIMIT", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        const projectID = Instance.project.id
        Database.use((db) => {
          // Simulate legacy multi-chunk rows for one part (pre-budget index residue).
          for (let i = 0; i < 8; i++) {
            db.insert(HistoryFtsTable)
              .values({
                part_id: `prt_big#${i}`,
                session_id: "ses_a",
                message_id: "msg_a",
                project_id: projectID,
                tool_name: "bash",
                body: `sharedtoken chunk ${i}`,
                time_created: now,
              })
              .run()
          }
          for (const id of ["prt_s1", "prt_s2", "prt_s3"]) {
            db.insert(HistoryFtsTable)
              .values({
                part_id: id,
                session_id: "ses_a",
                message_id: "msg_b",
                project_id: projectID,
                tool_name: null,
                body: `sharedtoken in ${id}`,
                time_created: now,
              })
              .run()
          }
        })

        const history = yield* History.Service
        const hits = yield* history.search({ query: "sharedtoken", scope: "project", limit: 3 })
        const ids = hits.map((h) => h.part_id)
        expect(ids.length).toBe(3)
        expect(new Set(ids).size).toBe(3)
        expect(ids).toContain("prt_big")
      }),
    ),
  )
})
