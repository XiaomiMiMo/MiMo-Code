import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import type { SQLQueryBindings } from "bun:sqlite"
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
  it.live("legacy chunk residue never yields duplicate hits", () =>
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
      kind: "assistant_text",
                tool_name: "bash",
                body: `sharedtoken chunk ${i}`,
                body_idx: `sharedtoken chunk ${i}`,
                time_created: now,
              })
              .run()
          }
        })

        const history = yield* History.Service
        const hits = yield* history.search({ query: "sharedtoken", scope: "project", limit: 3 })
        expect(hits.map((h) => h.part_id)).toEqual(["prt_big"])
      }),
    ),
  )

  it.live("reads at most limit index rows", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        const projectID = Instance.project.id
        Database.use((db) => {
          for (let i = 0; i < 60; i++) {
            db.insert(HistoryFtsTable)
              .values({
                part_id: `prt_${i}`,
                session_id: "ses_a",
                message_id: "msg_a",
                project_id: projectID,
                kind: "assistant_text",
                tool_name: null,
                body: `sharedtoken ${i}`,
                body_idx: `sharedtoken ${i}`,
                time_created: now,
              })
              .run()
          }
        })
        const client = Database.Client().$client
        const prepare = client.prepare.bind(client)
        const reads: number[] = []
        const capture = spyOn(client, "prepare").mockImplementation(
          <R, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string, params?: P) => {
            const statement = prepare<R, P>(sql, params)
            if (!sql.includes("history_fts_idx MATCH")) return statement
            const all = statement.all.bind(statement)
            statement.all = (...args) => {
              const rows = all(...args)
              reads.push(rows.length)
              return rows
            }
            return statement
          },
        )
        try {
          const history = yield* History.Service
          const hits = yield* history.search({ query: "sharedtoken", scope: "project", limit: 5 })
          expect(hits.length).toBe(5)
        } finally {
          capture.mockRestore()
        }
        expect(reads).toEqual([5])
      }),
    ),
  )
})
