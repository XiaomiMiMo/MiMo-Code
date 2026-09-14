import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { HistoryFtsTable, HistoryIndexMigrationTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { backfillAll } from "./fixtures/seed-index"
import { migrateIndexBatch, startIndexMigration, stopIndexMigration } from "../../src/history/migration"
import { fileURLToPath } from "node:url"
import { History } from "../../src/history"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

// The test process shares a single in-memory SQLite DB (test/preload sets
// MIMOCODE_DB=:memory:), so other suites' SessionTable/PartTable rows are visible
// here. backfillAll() walks ALL sessions in the DB and would index those rows,
// so wipe the relevant tables both before AND after each test.
const wipe = () =>
  Database.use((db) => {
    db.delete(HistoryFtsTable).run()
    db.delete(PartTable).run()
    db.delete(MessageTable).run()
    db.delete(SessionTable).run()
    db.delete(ProjectTable).run()
  })

beforeEach(() => {
  Database.close()
  wipe()
  stopIndexMigration(Database.Client())
})

afterEach(async () => {
  wipe()
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(History.defaultLayer, CrossSpawnSpawner.defaultLayer))

function seed(
  parts: Array<{
    session_id: string
    message_id: string
    part_id: string
    role: "user" | "assistant"
    type: string
    text?: string
    tool?: string
    state?: any
  }>,
) {
  const now = Date.now()
  const seenProjects = new Set<string>()
  const seenSessions = new Set<string>()
  const seenMessages = new Set<string>()
  Database.use((db) => {
    for (const p of parts) {
      const projectID = "proj_" + p.session_id
      if (!seenProjects.has(projectID)) {
        db.insert(ProjectTable)
          .values({
            id: projectID as any,
            worktree: "/tmp",
            sandboxes: [] as any,
            time_created: now,
            time_updated: now,
          } as any)
          .onConflictDoNothing()
          .run()
        seenProjects.add(projectID)
      }
      if (!seenSessions.has(p.session_id)) {
        db.insert(SessionTable)
          .values({
            id: p.session_id as any,
            project_id: projectID as any,
            slug: "x",
            directory: "/tmp",
            title: "t",
            version: "1",
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .run()
        seenSessions.add(p.session_id)
      }
      if (!seenMessages.has(p.message_id)) {
        db.insert(MessageTable)
          .values({
            id: p.message_id as any,
            session_id: p.session_id as any,
            agent_id: "main",
            data: { role: p.role } as any,
            time_created: now,
            time_updated: now,
          })
          .run()
        seenMessages.add(p.message_id)
      }
      const data: any = { type: p.type }
      if (p.text !== undefined) data.text = p.text
      if (p.tool) data.tool = p.tool
      if (p.state) data.state = p.state
      db.insert(PartTable)
        .values({
          id: p.part_id as any,
          message_id: p.message_id as any,
          session_id: p.session_id as any,
          data,
          time_created: now,
          time_updated: now,
        })
        .run()
    }
  })
}

describe("History.backfill", () => {
  it.live("indexes existing text and tool parts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seed([
          { session_id: "ses_1", message_id: "m1", part_id: "p1", role: "user", type: "text", text: "hello" },
          {
            session_id: "ses_1",
            message_id: "m2",
            part_id: "p2",
            role: "assistant",
            type: "tool",
            tool: "Bash",
            state: { status: "completed", input: { command: "ls" } },
          },
          {
            session_id: "ses_1",
            message_id: "m3",
            part_id: "p3",
            role: "assistant",
            type: "step-start",
          },
        ])

        yield* backfillAll()

        const rows = Database.use((db) => db.select().from(HistoryFtsTable).all())
        expect(rows.map((r) => r.part_id).sort()).toEqual(["p1", "p2"])
      }),
    ),
  )

  it.live("is idempotent (NOT EXISTS skips already-indexed parts)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seed([{ session_id: "ses_x", message_id: "m1", part_id: "p1", role: "user", type: "text", text: "first" }])
        yield* backfillAll()
        seed([{ session_id: "ses_x", message_id: "m2", part_id: "p2", role: "user", type: "text", text: "second" }])
        yield* backfillAll()

        const rows = Database.use((db) => db.select().from(HistoryFtsTable).all())
        expect(rows.map((r) => r.part_id).sort()).toEqual(["p1", "p2"])
      }),
    ),
  )
})

async function prepareMigration() {
  const db = Database.Client()
  db.$client.exec("DROP TABLE history_index_migration; DROP TRIGGER history_part_ad")
  db.$client.exec(
    await Bun.file(
      new URL("../../migration/20260914010000_history_index_version/migration.sql", import.meta.url),
    ).text(),
  )
  return db
}
function finish(db: ReturnType<typeof Database.Client>) {
  let count = 0
  while (migrateIndexBatch(db)) {
    if (++count > 100) throw new Error("migration failed to terminate")
  }
}
function textParts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    session_id: "ses_compat",
    message_id: "msg_compat",
    part_id: `part_${i}`,
    role: "user" as const,
    type: "text",
    text: `searchable${i}`,
  }))
}

// A partially populated index still needs recovery.
test("repairs a partially rebuilt index and preserves existing non-default kinds", async () => {
  seed(textParts(300))
  const db = Database.Client()
  db.insert(HistoryFtsTable)
    .values({
      part_id: "part_0",
      session_id: "ses_compat",
      message_id: "msg_compat",
      project_id: "proj_ses_compat",
      kind: "reasoning",
      body: "keepword data:image/png;base64,aGVsbG8= tailword",
      time_created: 1,
    })
    .run()
  await prepareMigration()
  finish(db)
  const rows = db.select().from(HistoryFtsTable).all()
  expect(rows).toHaveLength(300)
  expect(rows.find((r) => r.part_id === "part_0")?.kind).toBe("reasoning")
  expect(rows.find((r) => r.part_id === "part_0")?.body).not.toContain("aGVsbG8=")
  expect(
    db.$client.prepare("SELECT count(*) AS n FROM history_fts_idx WHERE history_fts_idx MATCH 'keepword'").get(),
  ).toEqual({ n: 1 })
  expect(
    db.$client.prepare("SELECT count(*) AS n FROM history_fts_idx WHERE history_fts_idx MATCH 'searchable299'").get(),
  ).toEqual({ n: 1 })
  expect(db.select().from(HistoryIndexMigrationTable).get()?.phase).toBe("done")
  expect(migrateIndexBatch(db)).toBe(false)
})

test("failed batch rolls back index writes and cursor; resumes without revisiting prior batch", async () => {
  seed(textParts(300))
  const db = await prepareMigration()
  migrateIndexBatch(db) // clean -> repair
  migrateIndexBatch(db) // first 128 rows
  const before = db.select().from(HistoryIndexMigrationTable).get()
  db.$client.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON history_fts WHEN NEW.part_id = 'part_200' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  )
  expect(() => migrateIndexBatch(db)).toThrow("test failure")
  expect(db.select().from(HistoryIndexMigrationTable).get()).toEqual(before)
  expect(db.select().from(HistoryFtsTable).all()).toHaveLength(128)
  db.$client.exec("DROP TRIGGER fail_history")
  // If the committed prefix were visited again, corrupt JSON would fail extraction.
  db.$client.exec("DELETE FROM history_fts WHERE part_id = 'part_0'")
  db.$client.exec("UPDATE part SET data = 'invalid json' WHERE id = 'part_0'")
  finish(db)
  expect(db.select().from(HistoryFtsTable).all()).toHaveLength(299)
})

for (const count of [0, 300]) {
  test(`durable progress across real processes, ${count} parts`, async () => {
    seed(textParts(count))
    const db = await prepareMigration()
    const { tmpdir } = await import("../fixture/fixture")
    await using dir = await tmpdir()
    const file = `${dir.path}/index with spaces.db`
    db.$client.prepare("VACUUM INTO ?").run(file)
    const run = async (limit = Infinity) => {
      const child = Bun.spawn(
        [process.execPath, fileURLToPath(new URL("./fixtures/backfill-restart.ts", import.meta.url))],
        {
          cwd: process.cwd(),
          env: { ...process.env, MIMOCODE_DB: file, HISTORY_BATCH_LIMIT: String(limit) },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      return JSON.parse(stdout.trim().split("\n").at(-1)!)
    }
    const first = await run(2)
    const second = await run()
    expect(second.before).toEqual(first.after)
    expect(second.after.phase).toBe("done")
    expect((await run()).batches).toBe(0)
    if (count) expect(first.after.cursor).toBe(128)
  })
}

// Opening directories must not restart a completed migration.
it.live("database startup finishes once and directory initialization does not reopen migration", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      Database.close()
      const db = Database.Client()
      for (let i = 0; i < 20; i++) startIndexMigration(db)
      yield* Effect.sleep("100 millis")
      expect(db.select().from(HistoryIndexMigrationTable).get()?.phase).toBe("done")
      // Deliberately bypass all normal writers to detect an unwanted historical scan.
      seed(textParts(1))
      for (let i = 0; i < 3; i++) {
        yield* provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const history = yield* History.Service
            yield* history.search({ query: "searchable0", scope: "global" })
          }),
        )
        startIndexMigration(db)
      }
      yield* Effect.sleep("30 millis")
      expect(db.select().from(HistoryFtsTable).all()).toHaveLength(0)
      expect(db.select().from(HistoryIndexMigrationTable).get()?.phase).toBe("done")
    }),
  ),
)
