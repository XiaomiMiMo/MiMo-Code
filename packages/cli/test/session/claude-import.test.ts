import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Database, eq } from "../../src/storage"
import { Global } from "../../src/global"
import * as ClaudeImport from "../../src/session/claude-import"
import { ExternalImportTable } from "../../src/session/external-import.sql"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { stopIndexMigration } from "../../src/history/migration"
import { tmpdir } from "../fixture/fixture"

const tables = [
  "project",
  "session",
  "message",
  "part",
  "history_fts",
  "external_import",
  "inbox",
  "inbox_lane_state",
  "inbox_session_epoch",
]
const KEY = "00000000-0000-4000-8000-000000001671"
const projects = () => path.join(Global.Path.home, ".claude", "projects", "-tmp-example")
const transcript = () => path.join(projects(), `${KEY}.jsonl`)

beforeEach(() => {
  const db = Database.Client()
  stopIndexMigration(db)
  for (const table of [...tables].reverse()) db.$client.exec(`DELETE FROM ${table}`)
  db.$client.exec("UPDATE history_index_migration SET phase = 'done'")
})

afterEach(async () => {
  await fs.rm(projects(), { recursive: true, force: true })
})

const at = (minute: number) => `2026-06-01T10:${String(minute).padStart(2, "0")}:00.000Z`
const user = (minute: number, content: unknown) =>
  JSON.stringify({
    type: "user",
    timestamp: at(minute),
    cwd: "/tmp/example",
    version: "2.1.0",
    message: { role: "user", content },
  })
const assistant = (minute: number, content: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(minute),
    cwd: "/tmp/example",
    message: { role: "assistant", model: "test/model", content },
  })

const conversation = [
  JSON.stringify({ type: "summary", summary: "not a message" }),
  user(0, "Fix the import"),
  assistant(1, [
    { type: "text", text: "Reading it" },
    { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/example/a.ts" } },
  ]),
  user(2, [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }]),
  assistant(3, [{ type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } }]),
  user(4, "Thanks"),
  // call_2's result arrives after the next prompt, when its message is already stored
  user(5, [{ type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "late output" }] }]),
  "not json",
  assistant(6, [{ type: "text", text: "Done" }]),
]

async function write(lines: string[]) {
  await fs.mkdir(projects(), { recursive: true })
  await fs.writeFile(transcript(), lines.join("\n") + "\n")
}

function stored() {
  return Database.use((db) => {
    const link = db.select().from(ExternalImportTable).where(eq(ExternalImportTable.source_key, KEY)).get()
    if (!link) return undefined
    const session = db.select().from(SessionTable).where(eq(SessionTable.id, link.session_id)).get()
    const messages = db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.session_id, link.session_id))
      .orderBy(MessageTable.id)
      .all()
    const parts = db
      .select()
      .from(PartTable)
      .where(eq(PartTable.session_id, link.session_id))
      .orderBy(PartTable.id)
      .all()
      .map((p) => ({ ...p.data, id: p.id, sessionID: p.session_id, messageID: p.message_id }) as MessageV2.Part)
    return { link, session, messages, parts }
  })
}

describe("claude-import lines", () => {
  test("keeps lines and multi-byte characters whole across chunk boundaries", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "t.jsonl")
    const expected = ["a", "é中😀".repeat(40), "", "b\r", "no newline at the end"]
    await fs.writeFile(file, expected.join("\n"))
    const size = (await fs.stat(file)).size
    for (const chunk of [1, 2, 3, 5, 64, 1 << 20]) expect([...ClaudeImport.lines(file, size, chunk)]).toEqual(expected)
  })

  test("stops at the given size", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "t.jsonl")
    await fs.writeFile(file, "one\ntwo\nthree\n")
    expect([...ClaudeImport.lines(file, 8)]).toEqual(["one", "two"])
    // a cut inside a line yields the cut piece, which the importer then fails to parse and skips
    expect([...ClaudeImport.lines(file, 6)]).toEqual(["one", "tw"])
  })
})

describe("claude-import run", () => {
  test("imports a transcript, including a tool result that arrives after its message was stored", async () => {
    await write(conversation)
    const stats = await ClaudeImport.run()
    expect(stats.errors).toEqual([])

    const got = stored()!
    expect(got.session).toMatchObject({
      title: "Fix the import",
      directory: "/tmp/example",
      version: "2.1.0",
      time_created: Date.parse(at(0)),
      time_updated: Date.parse(at(6)),
    })
    expect(got.messages.map((m) => m.data.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(got.link.message_ids).toEqual(got.messages.map((m) => m.id))

    const tools = Object.fromEntries(got.parts.flatMap((p) => (p.type === "tool" ? [[p.callID, p.state]] : [])))
    expect(tools.call_1).toMatchObject({ status: "completed", output: "file body" })
    expect(tools.call_2).toMatchObject({ status: "completed", output: "late output" })
    const texts = got.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
    expect(texts).toEqual(["Fix the import", "Reading it", "Thanks", "Done"])
  })

  test("a re-sync replaces the imported messages instead of adding to them", async () => {
    await write(conversation)
    await ClaudeImport.run()
    const first = stored()!

    await write([...conversation, user(7, "One more"), assistant(8, [{ type: "text", text: "Sure" }])])
    const stats = await ClaudeImport.run({ force: true })
    expect(stats.errors).toEqual([])
    expect(stats.resynced).toBe(1)

    const second = stored()!
    expect(second.link.session_id).toBe(first.link.session_id)
    expect(second.messages).toHaveLength(6)
    expect(second.link.message_ids).toHaveLength(6)
    expect(second.messages.some((m) => first.link.message_ids!.includes(m.id))).toBe(false)
  })

  test("a repeated tool result replaces the earlier one, also after its message was stored", async () => {
    await write([
      user(0, "Run it"),
      assistant(1, [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "make" } }]),
      user(2, [{ type: "tool_result", tool_use_id: "call_1", is_error: true, content: "interrupted" }]),
      user(3, "go on"),
      user(4, [{ type: "tool_result", tool_use_id: "call_1", content: "built" }]),
      assistant(5, [{ type: "tool_use", id: "call_2", name: "Bash", input: { command: "test" } }]),
      user(6, [{ type: "tool_result", tool_use_id: "call_2", content: "passed" }]),
      user(7, [{ type: "tool_result", tool_use_id: "call_2", is_error: true, content: "interrupted" }]),
    ])
    const stats = await ClaudeImport.run()
    expect(stats.errors).toEqual([])

    const tools = Object.fromEntries(stored()!.parts.flatMap((p) => (p.type === "tool" ? [[p.callID, p.state]] : [])))
    expect(tools.call_1).toMatchObject({
      status: "completed",
      input: { command: "make" },
      output: "built",
      title: "Bash",
      time: { start: Date.parse(at(1)), end: Date.parse(at(4)) },
    })
    expect(tools.call_2).toMatchObject({ status: "error", input: { command: "test" }, error: "interrupted" })
  })

  test("a transcript larger than one read chunk is imported whole", async () => {
    const output = "é".repeat(800_000) // 1.6 MB, so a read chunk ends inside it
    await write([
      user(0, "Show it"),
      assistant(1, [{ type: "tool_use", id: "call_1", name: "Read", input: {} }]),
      user(2, [{ type: "tool_result", tool_use_id: "call_1", content: output }]),
      assistant(3, [{ type: "text", text: "Shown" }]),
    ])
    const stats = await ClaudeImport.run()
    expect(stats.errors).toEqual([])
    const parts = stored()!.parts
    expect(parts.flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [p.state.output] : []))).toEqual(
      [output],
    )
    expect(parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).toEqual(["Show it", "Shown"])
  })

  test("a re-sync of a transcript that no longer has messages keeps the imported ones", async () => {
    await write(conversation)
    await ClaudeImport.run()
    const first = stored()!

    await write([JSON.stringify({ type: "summary", summary: "not a message" })])
    const stats = await ClaudeImport.run({ force: true })
    expect(stats.errors).toEqual([])
    expect(stats.skipped).toBe(1)
    expect(stored()!.messages.map((m) => m.id)).toEqual(first.messages.map((m) => m.id))
  })

  test("a transcript without messages is skipped and writes nothing", async () => {
    await write([JSON.stringify({ type: "summary", summary: "not a message" }), "not json"])
    const stats = await ClaudeImport.run()
    expect(stats.errors).toEqual([])
    expect(stored()).toBeUndefined()
    expect(Database.use((db) => db.select().from(SessionTable).all())).toEqual([])
  })
})
