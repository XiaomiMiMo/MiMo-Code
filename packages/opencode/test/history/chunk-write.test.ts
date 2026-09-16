import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { SQLQueryBindings } from "bun:sqlite"
import { Database } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { chunkRowFilter, deleteHistoryRows, upsertHistoryBody } from "../../src/history/chunk-write"
import { extract } from "../../src/history/extract"
import { MAX_BYTES } from "../../src/tool/truncate"

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
afterEach(() => wipe())

function seedProject() {
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({ id: "p", worktree: "/tmp", sandboxes: [] as any, time_created: now, time_updated: now } as any)
      .run()
  })
}

describe("history upsert truncation 兜底", () => {
  it.each([48_001, 51_200, 980_000])("writes exactly one truncated row for %i characters", (length) => {
    const db = Database.Client()
    upsertHistoryBody(db, {
      part_id: "prt_single", session_id: "ses_a", message_id: "msg_1",
      project_id: "p", tool_name: null, body: "x".repeat(length), time_created: 1,
    })
    const rows = db.select().from(HistoryFtsTable).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.part_id).toBe("prt_single")
    expect(Buffer.byteLength(rows[0]!.body)).toBeLessThanOrEqual(MAX_BYTES + 256)
  })

  it("indexed legacy cleanup preserves adjacent ids and literal wildcard characters", () => {
    const db = Database.Client()
    const base = "prt_under_%score"
    const keep = [base + "0", base + "$", "prt_under_Xscore#0", "prt_under_%scor#0"]
    for (const id of [base, base + "#0", base + "#12", ...keep]) {
      db.insert(HistoryFtsTable).values({
        part_id: id, session_id: "ses_a", message_id: "msg_1", project_id: "p",
        body: "legacy", time_created: 1,
      }).run()
    }
    const query = db.delete(HistoryFtsTable).where(chunkRowFilter(base)).toSQL()
    const plan = db.$client.prepare("EXPLAIN QUERY PLAN " + query.sql).all(...query.params as SQLQueryBindings[]) as { detail: string }[]
    expect(plan.some((row) => /SCAN history_fts/.test(row.detail))).toBe(false)
    expect(plan.some((row) => /SEARCH history_fts.*INDEX/.test(row.detail))).toBe(true)
    deleteHistoryRows(db, base + "#1")
    expect(db.select().from(HistoryFtsTable).all().map((row) => row.part_id).sort()).toEqual(keep.sort())
  })

  it("upsertHistoryBody truncates oversized body via tool-result preview path", () => {
    seedProject()
    const huge = "find-result\n".repeat(20_000) + "END_MARKER"
    Database.use((db) => {
      upsertHistoryBody(db, {
        part_id: "prt_huge",
        session_id: "ses_a",
        message_id: "msg_1",
        project_id: "p",
        tool_name: "bash",
        body: huge,
        time_created: 1,
      })
    })
    const rows = Database.use((db) => db.select().from(HistoryFtsTable).all())
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const total = rows.reduce((n, r) => n + Buffer.byteLength(r.body, "utf-8"), 0)
    expect(total).toBeLessThanOrEqual(MAX_BYTES + 256)
    // Full payload must not be persisted — only the tool-result preview.
    expect(total).toBeLessThan(Buffer.byteLength(huge, "utf-8") / 2)
  })

  it("delete removes base rows after budgeted upsert", () => {
    seedProject()
    Database.use((db) => {
      upsertHistoryBody(db, {
        part_id: "prt_x",
        session_id: "ses_a",
        message_id: "msg_1",
        project_id: "p",
        tool_name: null,
        body: "short body",
        time_created: 2,
      })
    })
    expect(Database.use((db) => db.select().from(HistoryFtsTable).all().length)).toBe(1)
    Database.use((db) => deleteHistoryRows(db, "prt_x"))
    expect(Database.use((db) => db.select().from(HistoryFtsTable).all().length)).toBe(0)
  })

  it("shrinking body replaces prior rows", () => {
    seedProject()
    Database.use((db) => {
      upsertHistoryBody(db, {
        part_id: "prt_s",
        session_id: "ses_a",
        message_id: "msg_1",
        project_id: "p",
        tool_name: null,
        body: "y".repeat(80_000),
        time_created: 1,
      })
    })
    Database.use((db) => {
      upsertHistoryBody(db, {
        part_id: "prt_s",
        session_id: "ses_a",
        message_id: "msg_1",
        project_id: "p",
        tool_name: null,
        body: "tiny",
        time_created: 2,
      })
    })
    const rows = Database.use((db) => db.select().from(HistoryFtsTable).all())
    expect(rows.length).toBe(1)
    expect(rows[0]!.body).toBe("tiny")
  })
})

describe("history extract + budgeted index", () => {
  it("indexes tool output within the tool-output budget", () => {
    const part = {
      type: "tool",
      id: "prt_tool",
      sessionID: "ses_a",
      messageID: "msg_1",
      tool: "bash",
      state: { status: "completed", input: { command: "ls" }, output: "line\n".repeat(20_000) },
    } as never
    const extracted = extract(part)
    expect(extracted).not.toBeNull()
    expect(Buffer.byteLength(extracted!.body, "utf-8")).toBeLessThanOrEqual(MAX_BYTES + 256)
    seedProject()
    Database.use((db) => {
      upsertHistoryBody(db, {
        part_id: "prt_tool",
        session_id: "ses_a",
        message_id: "msg_1",
        project_id: "p",
        tool_name: extracted!.tool_name,
        body: extracted!.body,
        time_created: Date.now(),
      })
    })
    const rows = Database.use((db) => db.select().from(HistoryFtsTable).all())
    expect(rows.length).toBe(1)
  })
})
