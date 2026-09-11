import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { History } from "../../src/history"
import { backfillAll } from "../../src/history/backfill"
import { projection } from "../../src/history/projection"
import { PartTable } from "../../src/session/session.sql"
import { HistoryTool } from "../../src/tool/history"
import { Provider } from "../../src/provider"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    History.defaultLayer,
    Provider.defaultLayer,
    Agent.defaultLayer,
    Truncate.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)
const wipe = () =>
  Database.Client().$client.exec("DELETE FROM history_fts; DELETE FROM part; DELETE FROM message; DELETE FROM session;")
afterEach(wipe)
const ctx = {
  sessionID: SessionID.make("ses_detail"),
  messageID: MessageID.make("msg_detail"),
  callID: "",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
function seed(parts: unknown[]) {
  wipe()
  const db = Database.Client().$client
  db.prepare("INSERT OR IGNORE INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)").run(
    "detail",
    "/synthetic",
    "[]",
    1,
    1,
  )
  db.prepare(
    "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
  ).run("ses_detail", "detail", "d", "/synthetic", "detail", "1", 1, 1)
  db.prepare("INSERT INTO message(id,session_id,agent_id,data,time_created,time_updated) VALUES(?,?,?,?,?,?)").run(
    "msg_detail",
    "ses_detail",
    "main",
    '{"role":"user"}',
    1,
    1,
  )
  const stmt = db.prepare(
    "INSERT INTO part(id,message_id,session_id,data,time_created,time_updated) VALUES(?,?,?,?,?,?)",
  )
  parts.forEach((data, i) =>
    stmt.run(`prt_${String(i).padStart(4, "0")}`, "msg_detail", "ses_detail", JSON.stringify(data), 1, 1),
  )
}
const model: Provider.Model = {
  id: ModelID.make("test"),
  providerID: ProviderID.make("test"),
  api: { id: "test", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
  name: "Test",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: true, video: false, pdf: true },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

it.live("get reads original parts without index; Unicode pages, errors, stable media and routing", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const text = "中文😀".repeat(6000)
      const url = "data:image/png;base64,YWJj"
      seed([
        { type: "text", text },
        { type: "text", text: `before ${url} after` },
        { type: "file", mime: "image/png", url: "file:///private/never-read.png" },
        {
          type: "tool",
          tool: "image",
          state: {
            status: "completed",
            input: { url },
            output: `after ${url}`,
            error: `oops ${url}`,
            attachments: [
              { id: "old-id", mime: "image/png", url },
              { mime: "audio/ogg", url: "data:audio/ogg;base64,YWJj" },
              { mime: "application/pdf", url: "data:application/pdf;base64,YWJj" },
              { mime: "audio/wav", url: "data:audio/wav;base64,YWJj" },
              { mime: "image/png", url: "https://example.com/never-downloaded.png" },
            ],
          },
        },
        { type: "file", mime: "image/png", url },
      ])
      const history = yield* History.Service
      expect(yield* history.get({ part_id: "absent" })).toBeUndefined()
      let offset = 0
      let restored = ""
      while (offset < text.length) {
        const result = yield* history.get({ part_id: "prt_0000", offset, length: 8000 })
        expect(result).toBeDefined()
        restored += result!.text
        offset = result!.next_offset
      }
      expect(restored).toBe(text)
      expect((yield* history.get({ part_id: "prt_0000", offset: text.length }))?.has_more).toBe(false)
      const tool = yield* (yield* HistoryTool).init()
      expect(
        (yield* tool.execute({ operation: "get", part_id: "prt_0000", offset: text.length + 1 }, ctx)).output,
      ).toContain("offset")
      expect((yield* tool.execute({ operation: "get", part_id: "prt_0000", offset: 3 }, ctx)).output).toContain(
        "surrogate",
      )
      for (const id of ["tool:2", "tool:3", "tool:4"]) {
        const result = yield* tool.execute(
          { operation: "get", part_id: "prt_0003", attachment: id },
          { ...ctx, extra: { model } },
        )
        expect(result.attachments).toHaveLength(1)
      }
      const blind = {
        ...model,
        capabilities: { ...model.capabilities, input: { ...model.capabilities.input, image: false } },
      }
      expect(
        (yield* tool.execute(
          { operation: "get", part_id: "prt_0001", attachment: "inline:0" },
          { ...ctx, extra: { model: blind } },
        )).output,
      ).toContain("Cannot display")
      expect((yield* tool.execute({ operation: "get", part_id: "missing" }, ctx)).output).toContain("not found")
      expect(
        (yield* tool.execute(
          { operation: "get", part_id: "prt_0004", attachment: "file:0" },
          { ...ctx, extra: { model } },
        )).attachments?.[0]?.url,
      ).toBe(url)
      const plain = yield* tool.execute({ operation: "get", part_id: "prt_0000", length: 8000 }, ctx)
      expect(Buffer.byteLength(plain.output)).toBeLessThanOrEqual(20480)
      expect(plain.output).toContain("offset=0 next_offset=")
      expect(plain.output).toContain("Continue: history operation=get")
      const info = yield* tool.execute({ operation: "get", part_id: "prt_0003" }, ctx)
      expect(info.attachments).toBeUndefined()
      expect(info.output).not.toContain("YWJj")
      for (const id of ["inline:0", "inline:1", "inline:2", "tool:0"]) {
        const result = yield* tool.execute(
          { operation: "get", part_id: "prt_0003", attachment: id },
          { ...ctx, extra: { model } },
        )
        expect(result.attachments).toEqual([{ type: "file", mime: "image/png", url, filename: undefined }])
        expect(result.attachments?.[0]).not.toHaveProperty("id")
      }
      expect(
        (yield* tool.execute({ operation: "get", part_id: "prt_0003", attachment: "tool:999" }, ctx)).output,
      ).toContain("not found")
      expect(
        (yield* tool.execute(
          { operation: "get", part_id: "prt_0003", attachment: "tool:1" },
          { ...ctx, extra: { model } },
        )).output,
      ).toContain("Cannot display")
      expect(
        (yield* tool.execute({ operation: "get", part_id: "prt_0001", attachment: "inline:0" }, ctx)).output,
      ).toContain("Cannot display")
      expect(
        (yield* tool.execute({ operation: "get", part_id: "prt_0002", attachment: "file:0" }, ctx)).output,
      ).toContain("no file was read")
      for (const args of [{ offset: -1 }, { offset: 1.5 }, { length: 0 }, { length: 8001 }, { length: 1.2 }])
        expect(tool.parameters.safeParse({ operation: "get", part_id: "prt_0000", ...args }).success).toBe(false)
    }),
  ),
)

it.live("SQL preview bounds NUL-containing fields without losing get details", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const text = "\u0000" + "x".repeat(10000)
      seed([
        { type: "text", text },
        { type: "tool", state: { input: {}, output: text } },
      ])
      const projected = Database.use((db) =>
        db
          .select(projection(true, true, true, true, true))
          .from(PartTable)
          .all(),
      )
      expect(JSON.stringify(projected)).not.toContain("x".repeat(100))
      expect(JSON.stringify(projected)).toContain("large field omitted")
      const history = yield* History.Service
      expect((yield* history.get({ part_id: "prt_0000" }))?.text).toBe(text.slice(0, 4000))
    }),
  ),
)

it.live("mixed 500+ scan, SQL projection, legacy migration and interrupted rebuild preserve source", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const url = `data:image/png;base64,${"YWJj".repeat(1024)}`
      seed(
        Array.from({ length: 612 }, (_, i) =>
          i % 3 === 0
            ? { type: "file", mime: "image/png", url }
            : i % 3 === 1
              ? { type: "text", text: `needle before ${url} after ${i}` }
              : {
                  type: "tool",
                  tool: "image",
                  state: {
                    status: "completed",
                    input: { prompt: "needle" },
                    output: url,
                    attachments: [{ mime: "image/png", url }],
                  },
                },
        ),
      )
      const db = Database.Client().$client
      const original = db.prepare("SELECT data FROM part ORDER BY id").all()
      const projected = Database.use((db) => db.select(projection(false, false)).from(PartTable).all())
      expect(JSON.stringify(projected.filter((p) => p.data.type !== "text"))).not.toContain("YWJj")
      const preview = Database.use((db) =>
        db
          .select(projection(true, true, true, true, true))
          .from(PartTable)
          .all(),
      )
      expect(JSON.stringify(preview)).not.toContain("YWJj")
      expect(JSON.stringify(preview)).toContain("large field omitted")
      const context = yield* (yield* History.Service).around({ message_id: "msg_detail", before: 0, after: 0 })
      expect(context.messages[0].parts[1].text).toContain("omitted")
      expect(context.messages[0].parts[1].part_id).toBe("prt_0001")
      yield* backfillAll()
      expect((db.prepare("SELECT count(*) AS n FROM history_fts").get() as { n: number }).n).toBe(408)
      expect(JSON.stringify(db.prepare("SELECT body FROM history_fts").all())).not.toContain("YWJj")
      // Emulate an old dirty index; execute the real migration, then an interrupted
      // rebuild (some rows already present) followed by idempotent continuation.
      db.prepare("UPDATE history_fts SET body=? WHERE part_id='prt_0001'").run(`old ${url}`)
      const migration = yield* Effect.promise(() =>
        Bun.file(new URL("../../migration/20260908000000_history_media_rebuild/migration.sql", import.meta.url)).text(),
      )
      db.exec(migration)
      expect((db.prepare("SELECT count(*) AS n FROM history_fts").get() as { n: number }).n).toBe(0)
      const history = yield* History.Service
      expect((yield* history.get({ part_id: "prt_0001" }))?.text).toContain("before")
      db.exec(
        "INSERT INTO history_fts(part_id,session_id,message_id,project_id,kind,body,time_created) VALUES('prt_0001','ses_detail','msg_detail','detail','user_text','needle before [media] after 1',1)",
      )
      yield* backfillAll()
      yield* backfillAll()
      expect((db.prepare("SELECT count(*) AS n FROM history_fts").get() as { n: number }).n).toBe(408)
      expect(db.prepare("SELECT data FROM part ORDER BY id").all()).toEqual(original)
      expect((yield* history.search({ query: "after", scope: "global" })).length).toBe(10)
      const tool = yield* (yield* HistoryTool).init()
      const around = yield* tool.execute({ operation: "around", message_id: "msg_detail", before: 0, after: 0 }, ctx)
      expect(Buffer.byteLength(around.output)).toBeLessThanOrEqual(20480)
      expect(around.output).toContain("part_id=")
      expect(around.output).toContain("omitted")
      expect(around.output).not.toContain("YWJj")
    }),
  ),
)

it.live("summary and many-attachment lists have total byte budgets, locators remain pageable", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      seed([
        {
          type: "tool",
          tool: "many",
          state: {
            input: {},
            output: "中".repeat(15000),
            attachments: Array.from({ length: 1200 }, () => ({ mime: "image/png", url: "data:image/png;base64,YWJj" })),
          },
        },
        ...Array.from({ length: 50 }, () => ({ type: "text", text: `needle ${"中".repeat(10000)}` })),
      ])
      yield* backfillAll()
      const tool = yield* (yield* HistoryTool).init()
      const get = yield* tool.execute({ operation: "get", part_id: "prt_0000", length: 8000 }, ctx)
      expect(Buffer.byteLength(get.output)).toBeLessThanOrEqual(20480)
      expect(get.output).toContain("Attachment list omitted")
      expect(get.output).toContain("tool: 0..1199 (1200 attachments)")
      expect(
        (yield* tool.execute(
          { operation: "get", part_id: "prt_0000", attachment: "tool:1199" },
          { ...ctx, extra: { model } },
        )).attachments,
      ).toHaveLength(1)
      const search = yield* tool.execute({ operation: "search", query: "needle", scope: "global", limit: 50 }, ctx)
      expect(Buffer.byteLength(search.output)).toBeLessThanOrEqual(20480)
      expect(search.output).toContain("omitted")
      expect(search.output).toContain("part_id=")
    }),
  ),
)
