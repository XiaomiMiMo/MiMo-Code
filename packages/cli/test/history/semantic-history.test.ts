import { afterEach, describe, expect, spyOn } from "bun:test"
import { inArray } from "drizzle-orm"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { History } from "../../src/history"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import * as SemanticCandidates from "../../src/semantic/candidates"
import type { SessionID, MessageID, PartID } from "../../src/session/schema"
import type { ProjectID } from "../../src/project/schema"

afterEach(() => {
  delete process.env.MIMOCODE_SEMINDEX_HELPER
})

const it = testEffect(Layer.mergeAll(History.defaultLayer, CrossSpawnSpawner.defaultLayer))
const now = 1_700_000_000_000
const sourceText = "The deployment used a synthetic blue-green rollout."
const semanticText = "synthetic blue-green rollout"
const signature = (text: string) => createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12)

function candidate(input: { source: string; text: string; session: string; message: string; time?: number }) {
  return {
    source: input.source,
    text: input.text,
    signature: signature(input.text),
    rank: 1,
    sessionID: input.session,
    messageID: input.message,
    partID: input.source,
    time: input.time ?? now,
    kind: "assistant_text",
  }
}

async function helper(dir: string, hits: ReturnType<typeof candidate>[], marker?: string) {
  const file = path.join(dir, "semantic-helper.py")
  const markerCode = marker ? `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('called')\n` : ""
  await Bun.write(file, `import json, sys\n${markerCode}sys.stdin.read()\nprint(${JSON.stringify(JSON.stringify(hits))})\n`)
  process.env.MIMOCODE_SEMINDEX_HELPER = file
}

function cleanupFixture(input: { projectIDs?: string[]; sessionIDs?: string[]; messageIDs?: string[]; partIDs?: string[]; ftsIDs?: string[] }) {
  return Effect.addFinalizer(() => Effect.sync(() => Database.use((db) => {
    if (input.ftsIDs?.length) db.delete(HistoryFtsTable).where(inArray(HistoryFtsTable.part_id, input.ftsIDs)).run()
    if (input.partIDs?.length) db.delete(PartTable).where(inArray(PartTable.id, input.partIDs as PartID[])).run()
    if (input.messageIDs?.length) db.delete(MessageTable).where(inArray(MessageTable.id, input.messageIDs as MessageID[])).run()
    if (input.sessionIDs?.length) db.delete(SessionTable).where(inArray(SessionTable.id, input.sessionIDs as SessionID[])).run()
    if (input.projectIDs?.length) db.delete(ProjectTable).where(inArray(ProjectTable.id, input.projectIDs as ProjectID[])).run()
  })))
}

function seed(input: { projectID: string; sessionID: string; messageID: string; partID: string; ftsPartID?: string; body?: string; synthetic?: boolean; partTime?: number; ftsTime?: number; projectDirectory: string }) {
  const body = input.body ?? sourceText
  Database.use((db) => {
    db.insert(ProjectTable).values({
      id: input.projectID as ProjectID,
      worktree: input.projectDirectory,
      sandboxes: [],
      time_created: now,
      time_updated: now,
    }).onConflictDoNothing().run()
    db.insert(SessionTable).values({
      id: input.sessionID as SessionID,
      project_id: input.projectID as ProjectID,
      slug: "history-semantic-fixture",
      directory: input.projectDirectory,
      title: "Synthetic history session",
      version: "1",
      time_created: now,
      time_updated: now,
    }).run()
    db.insert(MessageTable).values({
      id: input.messageID as MessageID,
      session_id: input.sessionID as SessionID,
      agent_id: "main",
      data: { role: "assistant" } as never,
      time_created: now,
      time_updated: now,
    }).run()
    db.insert(PartTable).values({
      id: input.partID as PartID,
      session_id: input.sessionID as SessionID,
      message_id: input.messageID as MessageID,
      data: { type: "text", text: body, synthetic: input.synthetic } as never,
      time_created: input.partTime ?? now,
      time_updated: now,
    }).run()
    db.insert(HistoryFtsTable).values({
      part_id: input.ftsPartID ?? input.partID,
      session_id: input.sessionID,
      message_id: input.messageID,
      project_id: input.projectID,
      kind: input.synthetic ? "synthetic_text" : "assistant_text",
      tool_name: null,
      body,
      body_idx: body,
      time_created: input.ftsTime ?? now,
    }).run()
  })
}

describe("History.hybridSearch", () => {
  it.live("fuses a current semantic source and retains exact recovery identifiers", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const service = yield* History.Service
        const projectID = Instance.project.id
        const ids = { projectID, sessionID: "ses_history_sem" as string, messageID: "msg_history_sem", partID: "prt_history_sem" }
        yield* cleanupFixture({ projectIDs: [projectID], sessionIDs: [ids.sessionID], messageIDs: [ids.messageID], partIDs: [ids.partID], ftsIDs: [`${ids.partID}#0`] })
        seed({ ...ids, ftsPartID: `${ids.partID}#0`, partTime: now - 20_000, ftsTime: now + 2_000, projectDirectory: dir })
        yield* Effect.promise(() => helper(dir, [candidate({ source: `${ids.partID}#0`, text: semanticText, session: ids.sessionID, message: ids.messageID, time: now + 2_000 })]))
        const client = Database.Client().$client
        const prepare = client.prepare.bind(client)
        let scopedSql = ""
        let scopedParams: Array<string | number> = []
        const capture = spyOn(client, "prepare").mockImplementation((sql, ...args) => {
          if (sql.includes("FROM history_fts\n") && sql.includes("kind IN")) {
            scopedSql = sql
            scopedParams = args as Array<string | number>
          }
          return prepare(sql, ...args)
        })
        let hits: import("../../src/history/service").HybridSearchHit[] = []
        try {
          hits = yield* service.hybridSearch({ query: "rollout approach", time_after: now + 1_000, limit: 5 })
        } finally {
          capture.mockRestore()
        }
        expect(hits).toHaveLength(1)
        expect(hits[0]).toMatchObject({ part_id: ids.partID, session_id: ids.sessionID, message_id: ids.messageID, time_created: now + 2_000, retrieval: "semantic", rank: 1 })
        expect(hits[0]).not.toHaveProperty("bm25_score")
        expect(hits[0]).not.toHaveProperty("outcome")
        const detail = yield* service.get({ part_id: ids.partID })
        expect(detail?.text).toContain(sourceText)
        const around = yield* service.around({ message_id: ids.messageID, before: 0, after: 0 })
        expect(around.messages[0]?.parts[0]?.part_id).toBe(ids.partID)
        expect(scopedSql).not.toBe("")
        const plan = prepare(`EXPLAIN QUERY PLAN ${scopedSql}`).all(...scopedParams) as Array<{ detail: string }>
        expect(plan.some((row) => /SEARCH history_fts USING (?:COVERING )?INDEX history_fts_(?:project|session|kind)_idx/.test(row.detail))).toBe(true)
      }),
    ),
  )

  it.live("rejects stale FTS candidates against updated original part data", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const service = yield* History.Service
        const currentProject = Instance.project.id
        const current = { projectID: currentProject, sessionID: "ses_current", messageID: "msg_current", partID: "prt_current" }
        yield* cleanupFixture({ projectIDs: [currentProject], sessionIDs: [current.sessionID], messageIDs: [current.messageID], partIDs: [current.partID], ftsIDs: [current.partID] })
        seed({ ...current, projectDirectory: dir })
        Database.Client().$client.prepare("UPDATE part SET data = ? WHERE id = ?").run(
          JSON.stringify({ type: "text", text: "The deployment used a synthetic canary rollout." }),
          current.partID,
        )
        yield* Effect.promise(() => helper(dir, [
          candidate({ source: current.partID, text: semanticText, session: current.sessionID, message: current.messageID }),
        ]))
        const hits = yield* service.hybridSearch({ query: "historical approach", limit: 5 })
        expect(hits).toEqual([])
      }),
    ),
  )

  it.live("revalidates original part content after semantic retrieval completes", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const service = yield* History.Service
        const ids = { projectID: Instance.project.id, sessionID: "ses_edit_race", messageID: "msg_edit_race", partID: "prt_edit_race" }
        yield* cleanupFixture({ projectIDs: [ids.projectID], sessionIDs: [ids.sessionID], messageIDs: [ids.messageID], partIDs: [ids.partID], ftsIDs: [ids.partID] })
        seed({ ...ids, projectDirectory: dir })
        const hit = candidate({ source: ids.partID, text: semanticText, session: ids.sessionID, message: ids.messageID })
        const lookup = spyOn(SemanticCandidates, "search").mockImplementation(async () => {
          Database.Client().$client.prepare("UPDATE part SET data = ? WHERE id = ?").run(
            JSON.stringify({ type: "text", text: "The deployment used a synthetic canary rollout." }),
            ids.partID,
          )
          return { status: "ok", hits: [hit] }
        })
        let hits: import("../../src/history/service").HybridSearchHit[]
        try {
          hits = yield* service.hybridSearch({ query: "current rollout method", limit: 5 })
        } finally {
          lookup.mockRestore()
        }
        expect(hits).toEqual([])
      }),
    ),
  )

  it.live("revalidates part existence after semantic retrieval completes", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const service = yield* History.Service
        const ids = { projectID: Instance.project.id, sessionID: "ses_delete_race", messageID: "msg_delete_race", partID: "prt_delete_race" }
        yield* cleanupFixture({ projectIDs: [ids.projectID], sessionIDs: [ids.sessionID], messageIDs: [ids.messageID], partIDs: [ids.partID], ftsIDs: [ids.partID] })
        seed({ ...ids, projectDirectory: dir })
        const hit = candidate({ source: ids.partID, text: semanticText, session: ids.sessionID, message: ids.messageID })
        const lookup = spyOn(SemanticCandidates, "search").mockImplementation(async () => {
          Database.Client().$client.prepare("DELETE FROM part WHERE id = ?").run(ids.partID)
          return { status: "ok", hits: [hit] }
        })
        let hits: import("../../src/history/service").HybridSearchHit[]
        try {
          hits = yield* service.hybridSearch({ query: "historical rollout details", limit: 5 })
        } finally {
          lookup.mockRestore()
        }
        expect(hits).toEqual([])
      }),
    ),
  )

  it.live("filters another project's source before semantic top-k", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const service = yield* History.Service
        const other = { projectID: "proj_other", sessionID: "ses_other", messageID: "msg_other", partID: "prt_other" }
        yield* cleanupFixture({ projectIDs: [other.projectID, Instance.project.id], sessionIDs: [other.sessionID], messageIDs: [other.messageID], partIDs: [other.partID], ftsIDs: [other.partID] })
        seed({ ...other, projectDirectory: dir })
        const marker = path.join(dir, "called")
        yield* Effect.promise(() => helper(dir, [candidate({ source: other.partID, text: "blue-green rollout", session: other.sessionID, message: other.messageID })], marker))
        expect(yield* service.hybridSearch({ query: "historical approach", limit: 5 })).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    ),
  )

  it.live("rejects a deleted part source", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const service = yield* History.Service
        const deleted = { sessionID: "ses_deleted", messageID: "msg_deleted", partID: "prt_deleted" }
        yield* Effect.promise(() => helper(dir, [candidate({ source: deleted.partID, text: "deleted source excerpt", session: deleted.sessionID, message: deleted.messageID })]))
        expect(yield* service.hybridSearch({ query: "historical approach", limit: 5 })).toEqual([])
      }),
    ),
  )

  it.live("bypasses semantic retrieval for exact identifiers and honors pre-aborted cancellation", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const service = yield* History.Service
        const ids = { projectID: Instance.project.id, sessionID: "ses_exact", messageID: "msg_exact", partID: "prt_exact" }
        yield* cleanupFixture({ projectIDs: [ids.projectID], sessionIDs: [ids.sessionID], messageIDs: [ids.messageID], partIDs: [ids.partID], ftsIDs: [ids.partID] })
        seed({ ...ids, projectDirectory: dir })
        const marker = path.join(dir, "called")
        yield* Effect.promise(() => helper(dir, [candidate({ source: ids.partID, text: semanticText, session: ids.sessionID, message: ids.messageID })], marker))
        for (const query of [ids.partID, "/tmp/example/file.ts", "--inspect-brk", "Foo.bar()", "a1b2c3d4e5f6", "TypeError: failed\n    at main (/tmp/example/app.js:2:3)"]) {
          yield* service.hybridSearch({ query, limit: 5 })
        }
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        const controller = new AbortController()
        controller.abort()
        const fallback = yield* service.hybridSearch({ query: "deployment rollout", limit: 5, signal: controller.signal })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(fallback.every((hit) => "score" in hit)).toBe(true)
      }),
    ),
  )

  it.live("never semantically retrieves synthetic source parts", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const service = yield* History.Service
        const ids = { projectID: Instance.project.id, sessionID: "ses_synthetic", messageID: "msg_synthetic", partID: "prt_synthetic" }
        yield* cleanupFixture({ projectIDs: [ids.projectID], sessionIDs: [ids.sessionID], messageIDs: [ids.messageID], partIDs: [ids.partID], ftsIDs: [ids.partID] })
        seed({ ...ids, synthetic: true, projectDirectory: dir })
        const marker = path.join(dir, "called")
        yield* Effect.promise(() => helper(dir, [candidate({ source: ids.partID, text: sourceText, session: ids.sessionID, message: ids.messageID })], marker))
        expect(yield* service.hybridSearch({ query: "deployment rollout approach", limit: 5 })).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    ),
  )

  it.live("uses exact FTS output when the provider is unavailable", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const projectID = Instance.project.id
        Database.use((db) => db.insert(HistoryFtsTable).values({
          part_id: "prt_semantic_fallback", session_id: "ses_fixture", message_id: "msg_fixture",
          project_id: projectID, kind: "assistant_text", tool_name: null, body: "provider fallback phrase",
          body_idx: "provider fallback phrase", time_created: 13,
        }).run())
        yield* cleanupFixture({ ftsIDs: ["prt_semantic_fallback"] })
        process.env.MIMOCODE_SEMINDEX_HELPER = path.join(dir, "missing-helper.py")
        const service = yield* History.Service
        const expected = yield* service.search({ query: "provider fallback", limit: 5 })
        const actual = yield* service.hybridSearch({ query: "provider fallback", limit: 5 })
        expect(actual).toEqual(expected)
      }),
    ),
  )
})
