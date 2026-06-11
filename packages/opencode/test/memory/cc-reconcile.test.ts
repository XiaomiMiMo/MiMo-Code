import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Database, eq } from "../../src/storage"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Memory } from "../../src/memory"
import { reconcileMemory, walkCcRoot } from "../../src/memory/reconcile"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  Database.use((db) => db.delete(MemoryFtsTable).run())
  await Instance.disposeAll()
})

const itLive = testEffect(Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer))

async function tmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cc-walk-"))
}

// CC's real layout is ~/.claude/projects/<slug>/memory; parseCcPath's regex
// anchors on `.claude/projects` as a safety contract, so integration test
// fixtures must mirror that path shape.
async function tmpCcBase() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-base-"))
  const base = path.join(tmp, ".claude", "projects")
  await fs.mkdir(base, { recursive: true })
  return base
}

describe("walkCcRoot", () => {
  test("returns empty array when base dir missing", async () => {
    const dir = await tmp()
    const missing = path.join(dir, "does", "not", "exist")
    expect(await walkCcRoot(missing)).toEqual([])
  })

  test("walks <base>/<slug>/memory/*.md", async () => {
    const base = await tmp()
    const slug = "-myproj"
    const memoryDir = path.join(base, slug, "memory")
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.writeFile(path.join(memoryDir, "feedback_x.md"), "body")
    await fs.writeFile(path.join(memoryDir, "MEMORY.md"), "body")

    const files = (await walkCcRoot(base)).sort()
    expect(files).toEqual(
      [path.join(memoryDir, "MEMORY.md"), path.join(memoryDir, "feedback_x.md")].sort(),
    )
  })

  test("walks multiple slugs", async () => {
    const base = await tmp()
    for (const slug of ["-a", "-b"]) {
      const dir = path.join(base, slug, "memory")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "f.md"), "x")
    }
    const files = await walkCcRoot(base)
    expect(files.length).toBe(2)
  })

  test("ignores slugs that have no memory subdir", async () => {
    const base = await tmp()
    await fs.mkdir(path.join(base, "-no-mem"), { recursive: true })
    await fs.writeFile(path.join(base, "-no-mem", "session.jsonl"), "x")
    expect(await walkCcRoot(base)).toEqual([])
  })

  test("ignores non-md files inside memory dir", async () => {
    const base = await tmp()
    const dir = path.join(base, "-x", "memory")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "ok.md"), "y")
    await fs.writeFile(path.join(dir, "skip.txt"), "y")
    const files = await walkCcRoot(base)
    expect(files).toEqual([path.join(dir, "ok.md")])
  })
})

describe("reconcileMemory cross-root", () => {
  itLive.live("indexes CC files under scope='cc' with frontmatter type", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const mimoRoot = yield* memory.root()
        yield* Effect.promise(() => fs.rm(mimoRoot, { recursive: true, force: true }))

        const ccBase = yield* Effect.promise(() => tmpCcBase())
        const slug = "-x"
        const ccDir = path.join(ccBase, slug, "memory")
        yield* Effect.promise(() => fs.mkdir(ccDir, { recursive: true }))
        const fb = `---
name: cache_ttl
description: prefix cache TTL is per-model
metadata:
  type: feedback
---
Body about cache.`
        yield* Effect.promise(() => fs.writeFile(path.join(ccDir, "feedback_cache_ttl.md"), fb))

        yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot, cc: ccBase }))

        const rows = Database.use((db) =>
          db.select().from(MemoryFtsTable).where(eq(MemoryFtsTable.scope, "cc")).all(),
        )
        expect(rows.length).toBe(1)
        expect(rows[0].scope).toBe("cc")
        expect(rows[0].scope_id).toBe(slug)
        expect(rows[0].type).toBe("feedback")
        expect(rows[0].body).toContain("Body about cache.")
      }),
    ),
  )

  itLive.live("MEMORY.md → type='free'", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const mimoRoot = yield* memory.root()
        yield* Effect.promise(() => fs.rm(mimoRoot, { recursive: true, force: true }))

        const ccBase = yield* Effect.promise(() => tmpCcBase())
        const ccDir = path.join(ccBase, "-y", "memory")
        yield* Effect.promise(() => fs.mkdir(ccDir, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(ccDir, "MEMORY.md"), "- [Title](file.md) — line"),
        )

        yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot, cc: ccBase }))

        const rows = Database.use((db) =>
          db.select().from(MemoryFtsTable).where(eq(MemoryFtsTable.scope, "cc")).all(),
        )
        expect(rows.length).toBe(1)
        expect(rows[0].type).toBe("free")
      }),
    ),
  )

  itLive.live("union prune: deleting one CC file leaves mimo rows untouched", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const mimoRoot = yield* memory.root()
        yield* Effect.promise(() => fs.rm(mimoRoot, { recursive: true, force: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(mimoRoot, "global"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(mimoRoot, "global", "m.md"), "mimo body"))

        const ccBase = yield* Effect.promise(() => tmpCcBase())
        const ccDir = path.join(ccBase, "-z", "memory")
        yield* Effect.promise(() => fs.mkdir(ccDir, { recursive: true }))
        const ccFile = path.join(ccDir, "feedback_x.md")
        yield* Effect.promise(() =>
          fs.writeFile(
            ccFile,
            `---
metadata:
  type: feedback
---
cc body`,
          ),
        )

        yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot, cc: ccBase }))
        expect(Database.use((db) => db.select().from(MemoryFtsTable).all()).length).toBe(2)

        // Delete CC file off disk; reconcile.
        yield* Effect.promise(() => fs.rm(ccFile))
        yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot, cc: ccBase }))

        const rows = Database.use((db) => db.select().from(MemoryFtsTable).all())
        expect(rows.length).toBe(1)
        expect(rows[0].scope).toBe("global") // mimo row preserved
      }),
    ),
  )

  itLive.live("flag flip on→off (passing cc undefined) prunes CC rows", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const mimoRoot = yield* memory.root()
        yield* Effect.promise(() => fs.rm(mimoRoot, { recursive: true, force: true }))

        const ccBase = yield* Effect.promise(() => tmpCcBase())
        const ccDir = path.join(ccBase, "-q", "memory")
        yield* Effect.promise(() => fs.mkdir(ccDir, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(ccDir, "x.md"),
            `---
metadata:
  type: feedback
---
body`,
          ),
        )

        // First reconcile WITH cc root — row indexed.
        yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot, cc: ccBase }))
        expect(
          Database.use((db) =>
            db.select().from(MemoryFtsTable).where(eq(MemoryFtsTable.scope, "cc")).all(),
          ).length,
        ).toBe(1)

        // Second reconcile WITHOUT cc root — row pruned.
        yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot }))
        expect(
          Database.use((db) =>
            db.select().from(MemoryFtsTable).where(eq(MemoryFtsTable.scope, "cc")).all(),
          ).length,
        ).toBe(0)
      }),
    ),
  )

  itLive.live("ENOENT on cc base is silent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const mimoRoot = yield* memory.root()
        yield* Effect.promise(() => fs.rm(mimoRoot, { recursive: true, force: true }))

        const result = yield* Effect.promise(() =>
          reconcileMemory({ mimo: mimoRoot, cc: "/definitely/not/a/real/path/abc123" }),
        )
        expect(result.indexed).toBe(0)
        expect(result.pruned).toBe(0)
      }),
    ),
  )
})
