import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Database } from "../../src/storage"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Memory } from "../../src/memory"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  // Clear shared in-memory DB rows so tests don't bleed into each other.
  Database.use((db) => db.delete(MemoryFtsTable).run())
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("Memory.reconcile", () => {
  it.live("indexes a new file", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        // Make sure the memory dir starts empty for this test
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
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
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
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
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
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
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
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
