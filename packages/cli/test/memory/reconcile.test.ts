import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Database } from "../../src/storage"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Memory } from "../../src/memory"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetMemory } from "../fixture/memory"
import { testEffect } from "../lib/effect"

// Memory state is process-global; see resetMemory.
beforeEach(resetMemory)

afterEach(async () => {
  await Instance.disposeAll()
  await resetMemory()
})

const it = testEffect(Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("Memory.reconcile", () => {
  // Desktop engine-runtime [TP-R6-06]: native filesystem paths must remain FTS identities.
  it.live("indexes native memory layouts, searches them and reconciles updates/deletes [TP-R6-06]", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const cases = [
          ["global", "", "MEMORY", "memory"],
          ["projects", "project-example", "MEMORY", "memory"],
          ["sessions", "ses_example", "checkpoint", "checkpoint"],
          ["sessions", "ses_example", "notes", "free"],
          ["sessions", "ses_example", "tasks/T1/progress", "progress"],
          ["sessions", "ses_example", "tasks/T1/notes", "notes"],
        ] as const
        for (const [scope, scopeID, key] of cases) {
          const file = path.join(root, scope, scopeID, `${key}.md`)
          yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(file, "nativepathregression original"))
        }

        expect(yield* memory.reconcile()).toEqual({ indexed: cases.length, pruned: 0 })
        const before = Database.use((db) => db.select().from(MemoryFtsTable).all())
        for (const [scope, scopeID, key, type] of cases) {
          expect(before.find((row) => row.path === path.join(root, scope, scopeID, `${key}.md`))).toMatchObject({
            scope, scope_id: scopeID, type, body: "nativepathregression original",
          })
        }
        const results = yield* memory.search({ query: "nativepathregression" })
        expect(results.map((row) => row.path).sort()).toEqual(before.map((row) => row.path).sort())
        expect(yield* memory.reconcile()).toEqual({ indexed: 0, pruned: 0 })
        expect(Database.use((db) => db.select().from(MemoryFtsTable).all())).toEqual(before)

        const globalFile = path.join(root, "global", "MEMORY.md")
        yield* Effect.promise(() => fs.writeFile(globalFile, "nativepathupdated replacement content"))
        expect(yield* memory.reconcile()).toEqual({ indexed: 1, pruned: 0 })
        expect((yield* memory.search({ query: "nativepathupdated" })).map((row) => row.path)).toEqual([globalFile])
        yield* Effect.promise(() => fs.unlink(globalFile))
        expect(yield* memory.reconcile()).toEqual({ indexed: 0, pruned: 1 })
        expect(yield* memory.search({ query: "nativepathupdated" })).toEqual([])
        expect(Database.use((db) => db.select().from(MemoryFtsTable).all())).toHaveLength(cases.length - 1)
      }),
    ),
  )

  it.live("indexes a new file", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const dir = path.join(root, "global")
        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "test.md"), "hello world"))

        yield* memory.reconcile()

        const rows = Database.use((db) => db.select().from(MemoryFtsTable).all())
        expect(rows.length).toBe(1)
        expect(rows[0].body).toBe("hello world")
        expect(rows[0].scope).toBe("global")
        expect(rows[0].type).toBe("free")
      }),
    ),
  )

  it.live("removes index entry when file deleted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const filePath = path.join(root, "global", "test.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(filePath), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(filePath, "hello"))
        yield* memory.reconcile()

        // Verify indexed
        let rows = Database.use((db) => db.select().from(MemoryFtsTable).all())
        expect(rows.length).toBe(1)

        // Delete file
        yield* Effect.promise(() => fs.rm(filePath))
        yield* memory.reconcile()

        rows = Database.use((db) => db.select().from(MemoryFtsTable).all())
        expect(rows.length).toBe(0)
      }),
    ),
  )

  it.live("skips reindex when fingerprint matches", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const filePath = path.join(root, "global", "test.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(filePath), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(filePath, "hello"))
        yield* memory.reconcile()

        const before = Database.use((db) => db.select().from(MemoryFtsTable).all())
        expect(before.length).toBe(1)
        const beforeAt = before[0].last_indexed_at

        // Reconcile again without changes
        yield* memory.reconcile()
        const after = Database.use((db) => db.select().from(MemoryFtsTable).all())
        // last_indexed_at NOT updated because fingerprint matched
        expect(after[0].last_indexed_at).toBe(beforeAt)
      }),
    ),
  )

  it.live("reindexes on file change", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const filePath = path.join(root, "global", "test.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(filePath), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(filePath, "v1"))
        yield* memory.reconcile()

        // Modify with delay to ensure mtime change
        yield* Effect.sleep("10 millis")
        yield* Effect.promise(() => fs.writeFile(filePath, "v2"))
        yield* memory.reconcile()

        const rows = Database.use((db) => db.select().from(MemoryFtsTable).all())
        expect(rows.length).toBe(1)
        expect(rows[0].body).toBe("v2")
      }),
    ),
  )
})
