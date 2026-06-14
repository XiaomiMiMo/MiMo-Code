import { afterEach, describe, expect } from "bun:test"
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

const it = testEffect(Layer.mergeAll(History.defaultLayer, CrossSpawnSpawner.defaultLayer))

function seedFts(rows: Array<Partial<typeof HistoryFtsTable.$inferInsert>>) {
  Database.use((db) => {
    for (const r of rows) {
      db.insert(HistoryFtsTable)
        .values({
          part_id: r.part_id!,
          session_id: r.session_id ?? "ses_a",
          message_id: r.message_id ?? "msg_x",
          project_id: r.project_id ?? "proj_a",
          kind: r.kind ?? "user_text",
          tool_name: r.tool_name ?? null,
          body: r.body!,
          time_created: r.time_created ?? Date.now(),
        })
        .run()
    }
  })
}

describe("History.search", () => {
  it.live("returns BM25-ranked matches", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedFts([
          { part_id: "p1", body: "JWT signing with RS256" },
          { part_id: "p2", body: "database query optimization" },
        ])
        const svc = yield* History.Service
        const r = yield* svc.search({ query: "JWT", scope: "global" })
        expect(r.length).toBe(1)
        expect(r[0].part_id).toBe("p1")
        expect(r[0].score).toBeGreaterThan(0)
      }),
    ),
  )

  it.live("session_id filter narrows results", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedFts([
          { part_id: "p1", session_id: "ses_A", body: "shared here" },
          { part_id: "p2", session_id: "ses_B", body: "shared here" },
        ])
        const svc = yield* History.Service
        const allHits = yield* svc.search({ query: "shared", scope: "global" })
        expect(allHits.length).toBe(2)
        const onlyA = yield* svc.search({ query: "shared", scope: "global", session_id: "ses_A" })
        expect(onlyA.length).toBe(1)
        expect(onlyA[0].session_id).toBe("ses_A")
      }),
    ),
  )

  it.live("kind filter narrows results", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedFts([
          { part_id: "p1", kind: "user_text", body: "git log oneline" },
          { part_id: "p2", kind: "tool_input", body: "Bash git log oneline" },
        ])
        const svc = yield* History.Service
        const onlyTool = yield* svc.search({ query: "git", scope: "global", kind: "tool_input" })
        expect(onlyTool.length).toBe(1)
        expect(onlyTool[0].kind).toBe("tool_input")
      }),
    ),
  )

  it.live("tool_name filter requires matching tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedFts([
          { part_id: "p1", kind: "tool_input", tool_name: "Bash", body: "Bash git log" },
          { part_id: "p2", kind: "tool_input", tool_name: "Read", body: "Read git log" },
        ])
        const svc = yield* History.Service
        const r = yield* svc.search({ query: "git", scope: "global", tool_name: "Bash" })
        expect(r.length).toBe(1)
        expect(r[0].tool_name).toBe("Bash")
      }),
    ),
  )

  it.live("time_after / time_before window", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedFts([
          { part_id: "p_old", body: "match", time_created: 1000 },
          { part_id: "p_new", body: "match", time_created: 9000 },
        ])
        const svc = yield* History.Service
        const recent = yield* svc.search({ query: "match", scope: "global", time_after: 5000 })
        expect(recent.length).toBe(1)
        expect(recent[0].part_id).toBe("p_new")
      }),
    ),
  )

  it.live("limit hard-capped at 50", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedFts(
          Array.from({ length: 60 }, (_, i) => ({ part_id: `p${i}`, body: "match" })),
        )
        const svc = yield* History.Service
        const r = yield* svc.search({ query: "match", scope: "global", limit: 1000 })
        expect(r.length).toBe(50)
      }),
    ),
  )

  it.live("empty / punctuation-only query returns empty", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedFts([{ part_id: "p1", body: "match" }])
        const svc = yield* History.Service
        const r = yield* svc.search({ query: "   ", scope: "global" })
        expect(r.length).toBe(0)
      }),
    ),
  )
})

describe("History.around", () => {
  it.live("returns ±N messages with matched flag", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ProjectTable).values({ id: "p", worktree: "/tmp", sandboxes: [] as any, time_created: now, time_updated: now } as any).run()
          db.insert(SessionTable)
            .values({
              id: "ses_a" as any,
              project_id: "p" as any,
              slug: "x",
              directory: "/tmp",
              title: "t",
              version: "1",
              time_created: now,
              time_updated: now,
            })
            .run()
          for (let i = 0; i < 5; i++) {
            db.insert(MessageTable)
              .values({
                id: `m${i}` as any,
                session_id: "ses_a" as any,
                agent_id: "main",
                data: { role: i % 2 === 0 ? "user" : "assistant" } as any,
                time_created: now + i,
                time_updated: now + i,
              })
              .run()
            db.insert(PartTable)
              .values({
                id: `pt${i}` as any,
                message_id: `m${i}` as any,
                session_id: "ses_a" as any,
                data: { type: "text", text: `body ${i}` } as any,
                time_created: now + i,
                time_updated: now + i,
              })
              .run()
          }
        })

        const svc = yield* History.Service
        const ctx = yield* svc.around({ message_id: "m2", before: 1, after: 1 })
        expect(ctx.session_id).toBe("ses_a")
        expect(ctx.messages.map((m) => m.message_id)).toEqual(["m1", "m2", "m3"])
        expect(ctx.messages.find((m) => m.matched)?.message_id).toBe("m2")
      }),
    ),
  )

  it.live("unknown message_id returns empty messages", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* History.Service
        const ctx = yield* svc.around({ message_id: "nope" })
        expect(ctx.messages).toEqual([])
      }),
    ),
  )
})
