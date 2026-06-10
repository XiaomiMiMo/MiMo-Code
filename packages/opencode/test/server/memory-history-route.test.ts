import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Database } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Memory } from "../../src/memory"
import { reconcileMemory } from "../../src/memory/reconcile"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  Database.use((db) => {
    db.delete(HistoryFtsTable).run()
    db.delete(MemoryFtsTable).run()
  })
  await Instance.disposeAll()
})

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

function seedHistory(rows: Array<{ part_id: string; body: string; session_id?: string; kind?: string }>) {
  Database.use((db) => {
    for (const r of rows) {
      db.insert(HistoryFtsTable)
        .values({
          part_id: r.part_id,
          session_id: r.session_id ?? "ses_route",
          message_id: "msg_route",
          project_id: Instance.project.id,
          kind: r.kind ?? "user_text",
          tool_name: null,
          body: r.body,
          time_created: Date.now(),
        })
        .run()
    }
  })
}

describe("memory routes", () => {
  test("GET /memory/search returns indexed hits", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const root = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const memory = yield* Memory.Service
              return yield* memory.root()
            }),
          )
          await fs.rm(root, { recursive: true, force: true })
          await fs.mkdir(path.join(root, "global"), { recursive: true })
          const file = path.join(root, "global", "route-test.md")
          await fs.writeFile(file, "distinctive route search token")

          await reconcileMemory({ mimo: root })

          const app = Server.Default().app
          const res = await app.request("/memory/search?query=distinctive")
          expect(res.status).toBe(200)
          const body = (await res.json()) as Array<{ path: string; scope: string }>
          expect(body.length).toBeGreaterThan(0)
          expect(body[0].scope).toBe("global")
          expect(body[0].path).toBe(file)
        },
      }),
    )
  })

  test("GET /memory/file returns full body for an indexed path", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const root = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const memory = yield* Memory.Service
              return yield* memory.root()
            }),
          )
          await fs.rm(root, { recursive: true, force: true })
          await fs.mkdir(path.join(root, "global"), { recursive: true })
          const file = path.join(root, "global", "readable.md")
          const text = "full memory body for route test"
          await fs.writeFile(file, text)
          await reconcileMemory({ mimo: root })

          const app = Server.Default().app
          const res = await app.request(`/memory/file?path=${encodeURIComponent(file)}`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as { path: string; content: string }
          expect(body.path).toBe(file)
          expect(body.content).toBe(text)
        },
      }),
    )
  })

  test("GET /memory/file 404s for paths outside memory roots", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const res = await app.request(`/memory/file?path=${encodeURIComponent("/etc/passwd")}`)
          expect(res.status).toBe(404)
        },
      }),
    )
  })
})

describe("history routes", () => {
  test("GET /history/search returns indexed trajectory hits", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          seedHistory([{ part_id: "part_route_1", body: "unique trajectory phrase alpha" }])

          const app = Server.Default().app
          const res = await app.request("/history/search?query=trajectory&scope=global")
          expect(res.status).toBe(200)
          const body = (await res.json()) as Array<{ part_id: string; snippet: string }>
          expect(body.length).toBe(1)
          expect(body[0].part_id).toBe("part_route_1")
        },
      }),
    )
  })

  test("GET /history/around returns empty window for unknown message", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const res = await app.request("/history/around?message_id=msg_missing")
          expect(res.status).toBe(200)
          const body = (await res.json()) as { session_id: string; messages: unknown[] }
          expect(body.session_id).toBe("")
          expect(body.messages).toEqual([])
        },
      }),
    )
  })
})
