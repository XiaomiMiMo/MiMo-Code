import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "../../src/storage"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Memory } from "../../src/memory"
import { reconcileMemory } from "../../src/memory/reconcile"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  Database.use((db) => db.delete(MemoryFtsTable).run())
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer))

// CC's real layout is ~/.claude/projects/<slug>/memory; parseCcPath's regex
// anchors on `.claude/projects` as a safety contract, so test fixtures must
// mirror that path shape.
async function tmpCcBase() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-search-"))
  const base = path.join(tmp, ".claude", "projects")
  await fs.mkdir(base, { recursive: true })
  return base
}

async function setupCcFile(ccBase: string, slug: string, name: string, body: string) {
  const dir = path.join(ccBase, slug, "memory")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), body)
}

// Disable lazy reconcile-on-search so our explicit reconcileMemory() call's
// CC rows are not pruned by the service's config-gated walk (which uses
// cc_index=false by default and therefore passes cc:undefined to reconcile).
const noLazyReconcile = { checkpoint: { memory_reconcile_on_search: false } }

describe("memory.search with cc scope", () => {
  it.live("ranks CC and mimo hits in one result list", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const memory = yield* Memory.Service
          const mimoRoot = yield* memory.root()
          yield* Effect.promise(() => fs.rm(mimoRoot, { recursive: true, force: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(mimoRoot, "global"), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(path.join(mimoRoot, "global", "m.md"), "distinctivetoken from mimo"),
          )

          const ccBase = yield* Effect.promise(() => tmpCcBase())
          yield* Effect.promise(() =>
            setupCcFile(
              ccBase,
              "-slug",
              "feedback_x.md",
              `---
metadata:
  type: feedback
---
distinctivetoken from CC`,
            ),
          )

          yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot, cc: ccBase }))

          const results = yield* memory.search({ query: "distinctivetoken" })
          expect(results.length).toBe(2)
          const scopes = results.map((r) => r.scope).sort()
          expect(scopes).toEqual(["cc", "global"])
        }),
      { config: noLazyReconcile },
    ),
  )

  it.live("scope filter: cc returns only CC rows", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const memory = yield* Memory.Service
          const mimoRoot = yield* memory.root()
          yield* Effect.promise(() => fs.rm(mimoRoot, { recursive: true, force: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(mimoRoot, "global"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(mimoRoot, "global", "m.md"), "tokenz"))

          const ccBase = yield* Effect.promise(() => tmpCcBase())
          yield* Effect.promise(() =>
            setupCcFile(ccBase, "-s", "feedback_x.md", `---
metadata:
  type: feedback
---
tokenz`),
          )

          yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot, cc: ccBase }))

          const ccOnly = yield* memory.search({ query: "tokenz", scope: "cc" })
          expect(ccOnly.length).toBe(1)
          expect(ccOnly[0].scope).toBe("cc")

          const globalOnly = yield* memory.search({ query: "tokenz", scope: "global" })
          expect(globalOnly.length).toBe(1)
          expect(globalOnly[0].scope).toBe("global")
        }),
      { config: noLazyReconcile },
    ),
  )

  it.live("type filter: feedback returns only CC feedback rows", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const memory = yield* Memory.Service
          const mimoRoot = yield* memory.root()
          yield* Effect.promise(() => fs.rm(mimoRoot, { recursive: true, force: true }))

          const ccBase = yield* Effect.promise(() => tmpCcBase())
          yield* Effect.promise(() =>
            setupCcFile(ccBase, "-a", "feedback_x.md", `---
metadata:
  type: feedback
---
sharedterm a`),
          )
          yield* Effect.promise(() =>
            setupCcFile(ccBase, "-a", "project_y.md", `---
metadata:
  type: project
---
sharedterm b`),
          )

          yield* Effect.promise(() => reconcileMemory({ mimo: mimoRoot, cc: ccBase }))

          const fb = yield* memory.search({ query: "sharedterm", type: "feedback" })
          expect(fb.length).toBe(1)
          expect(fb[0].type).toBe("feedback")

          const pj = yield* memory.search({ query: "sharedterm", type: "project" })
          expect(pj.length).toBe(1)
          expect(pj[0].type).toBe("project")
        }),
      { config: noLazyReconcile },
    ),
  )
})
