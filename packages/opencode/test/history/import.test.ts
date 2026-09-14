import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Database } from "../../src/storage"
import { Global } from "../../src/global"
import * as ClaudeImport from "../../src/session/claude-import"
import * as CodexImport from "../../src/session/codex-import"
import * as OpencodeImport from "../../src/session/opencode-import"
import { HistoryFtsTable, HistoryIndexMigrationTable } from "../../src/history/fts.sql"
import { ExternalImportTable } from "../../src/session/external-import.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { stopIndexMigration } from "../../src/history/migration"
import { tmpdir } from "../fixture/fixture"

const files: string[] = []
beforeEach(() => {
  const db = Database.Client()
  stopIndexMigration(db)
  db.delete(ExternalImportTable).run()
  db.delete(PartTable).run()
  db.delete(MessageTable).run()
  db.delete(SessionTable).run()
  db.delete(ProjectTable).run()
  db.delete(HistoryFtsTable).run()
  db.update(HistoryIndexMigrationTable).set({ phase: "done" }).run()
})
afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })))
})
function hits(word: string) {
  return Database.Client()
    .$client.prepare("SELECT count(*) AS n FROM history_fts_idx WHERE history_fts_idx MATCH ?")
    .get(word)
}

// [TP-HISTORY-IMPORT-01] Real importer entry points maintain search after the one-time job is done.
for (const source of ["claude", "codex"] as const) {
  test(`${source}: imported and resynchronized text is searchable without bootstrap`, async () => {
    const file =
      source === "claude"
        ? path.join(Global.Path.home, ".claude/projects/history-fixture/history-fixture.jsonl")
        : path.join(Global.Path.home, ".codex/sessions/history-fixture.jsonl")
    files.push(file)
    const write = async (text: string) => {
      const content =
        source === "claude"
          ? [
              {
                type: "user",
                uuid: "history-fixture",
                cwd: "/tmp/example",
                timestamp: "2026-06-01T10:00:00Z",
                message: { role: "user", content: text },
              },
            ]
          : [
              { type: "session_meta", payload: { id: "history-fixture", cwd: "/tmp/example" } },
              {
                type: "response_item",
                timestamp: "2026-06-01T10:00:00Z",
                payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
              },
            ]
      await Bun.write(file, content.map((row) => JSON.stringify(row)).join("\n"))
    }
    const run = source === "claude" ? ClaudeImport.run : CodexImport.run
    await write("originalneedle")
    Database.Client().$client.exec(
      "CREATE TRIGGER reject_index BEFORE INSERT ON history_fts BEGIN SELECT RAISE(ABORT, 'index failure'); END",
    )
    const failed = await run({ force: true })
    expect(failed.errors).toHaveLength(1)
    expect(Database.Client().select().from(PartTable).all()).toHaveLength(0)
    Database.Client().$client.exec("DROP TRIGGER reject_index")
    const first = await run({ force: true })
    expect(first.errors).toEqual([])
    expect(first.imported).toBe(1)
    expect(hits("originalneedle")).toEqual({ n: 1 })
    await write("replacementneedle")
    const second = await run({ force: true })
    expect(second.errors).toEqual([])
    expect(second.resynced).toBe(1)
    expect(hits("originalneedle")).toEqual({ n: 0 })
    expect(hits("replacementneedle")).toEqual({ n: 1 })
    expect(Database.Client().select().from(HistoryIndexMigrationTable).get()?.phase).toBe("done")
  })
}

test("OpenCode: import and source edits maintain search without directory initialization", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "source.db")
  const src = new SQLite(file)
  try {
    src.exec(`CREATE TABLE session(id TEXT, directory TEXT, slug TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES('ses_import', '/tmp/example', 'example', 'Example', '1', 1, 1);
      INSERT INTO message VALUES('msg_import', 'ses_import', 1, 1, '{"role":"user"}');
      INSERT INTO part VALUES('part_import', 'msg_import', 'ses_import', 1, 1, '{"type":"text","text":"originalneedle"}');`)
    const first = await OpencodeImport.run({ dbPath: file })
    expect(first.errors).toEqual([])
    expect(first.imported).toBe(1)
    expect(hits("originalneedle")).toEqual({ n: 1 })
    src.exec(`UPDATE session SET time_updated = 2;
      UPDATE part SET data = '{"type":"text","text":"replacementneedle"}';`)
    const second = await OpencodeImport.run({ dbPath: file })
    expect(second.errors).toEqual([])
    expect(second.resynced).toBe(1)
    expect(hits("originalneedle")).toEqual({ n: 0 })
    expect(hits("replacementneedle")).toEqual({ n: 1 })
  } finally {
    src.close()
  }
})
