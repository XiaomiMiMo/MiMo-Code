import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Worktree } from "../../src/worktree"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(Worktree.defaultLayer.pipe(Layer.provideMerge(CrossSpawnSpawner.defaultLayer)))

describe("Worktree.head / isPristine", () => {
  it.live("head returns the worktree HEAD sha; a fresh worktree is pristine, a dirtied one is not", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const wt = yield* Worktree.Service
          const info = yield* wt.makeWorktreeInfo()
          yield* wt.createFromInfo(info)
          const base = yield* wt.head(info.directory)
          expect(base.length).toBeGreaterThan(0)
          // Untouched worktree -> pristine.
          expect(yield* wt.isPristine(info.directory, base)).toBe(true)
          // Write a file -> no longer pristine.
          yield* Effect.promise(() => Bun.write(`${info.directory}/dirty.txt`, "x"))
          expect(yield* wt.isPristine(info.directory, base)).toBe(false)
          yield* wt.remove({ directory: info.directory })
        }),
      { git: true },
    ),
  )
})
