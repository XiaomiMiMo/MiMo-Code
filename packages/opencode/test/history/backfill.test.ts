import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { HistoryFtsTable, HistoryBackfillTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { backfillAll, backfillOnce } from "../../src/history/backfill"
import { History, BackfillService } from "../../src/history"
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

  // [TP-HISTORY-BOOTSTRAP-01] Directory bootstrap never repeats a completed migration.
  it.live("shares a one-time migration across directories and ignores later kind changes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seed([{ session_id: "ses_boot", message_id: "m1", part_id: "p1", role: "user", type: "text", text: "hello" }])
        const db = Database.Client()
        db.update(HistoryBackfillTable).set({ completed: false }).run()
        const select = spyOn(db, "select")
        const scans = () => select.mock.calls.filter(([fields]) => fields && "project_id" in fields).length
        yield* Effect.gen(function* () {
          yield* backfillOnce(new Set())
          expect(scans()).toBe(0)
          yield* Effect.all(
            Array.from({ length: 20 }, () => backfillOnce(new Set(["user_text"]))),
            { concurrency: "unbounded" },
          )
          expect(scans()).toBe(1)
          expect(db.select().from(HistoryBackfillTable).get()?.completed).toBe(true)
          expect(
            db
              .select()
              .from(HistoryFtsTable)
              .all()
              .map((row) => row.part_id),
          ).toEqual(["p1"])
          yield* backfillOnce(new Set(["reasoning"]))
          for (let directory = 0; directory < 3; directory++) {
            yield* provideTmpdirInstance(() =>
              Effect.gen(function* () {
                const service = yield* BackfillService
                yield* service.init()
              }),
            )
          }
          expect(scans()).toBe(1)
        }).pipe(Effect.ensuring(Effect.sync(() => select.mockRestore())))
      }),
    ),
  )

  // [TP-HISTORY-BOOTSTRAP-02] Real migration + file-backed DB across independent processes.
  for (const scenario of ["pending", "existing", "empty-result", "failure", "fresh"] as const) {
    it.live(`persists migration completion across restart: ${scenario}`, () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          if (scenario !== "fresh")
            seed([
              {
                session_id: "ses_restart",
                message_id: "m1",
                part_id: "p1",
                role: "user",
                type: scenario === "empty-result" ? "step-start" : "text",
                text: "history",
              },
            ])
          if (scenario === "existing") yield* backfillAll()
          const db = Database.Client()
          db.$client.exec("DROP TABLE history_backfill")
          db.$client.exec(
            yield* Effect.promise(() =>
              Bun.file(
                new URL("../../migration/20260914000000_history_backfill_once/migration.sql", import.meta.url),
              ).text(),
            ),
          )
          const file = `${Instance.directory}/restart.db`
          db.$client.prepare("VACUUM INTO ?").run(file)
          const run = (fail = false) =>
            Effect.promise(async () => {
              const child = Bun.spawn(
                [process.execPath, new URL("./fixtures/backfill-restart.ts", import.meta.url).pathname],
                {
                  cwd: process.cwd(),
                  env: { ...process.env, MIMOCODE_DB: file, HISTORY_FAIL_SCAN: fail ? "1" : "0" },
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
            })
          const skipped = scenario === "existing" || scenario === "fresh"
          expect(yield* run(scenario === "failure")).toEqual({
            scans: skipped ? 0 : 1,
            completed: scenario !== "failure",
          })
          expect(yield* run()).toEqual({ scans: scenario === "failure" ? 1 : 0, completed: true })
          expect(yield* run()).toEqual({ scans: 0, completed: true })
        }),
      ),
    )
  }
})
