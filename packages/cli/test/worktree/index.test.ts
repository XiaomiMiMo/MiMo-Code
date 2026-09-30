import { describe, expect } from "bun:test"
import { $ } from "bun"
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

describe("Worktree.setup git identity", () => {
  it.live("pins the parent repo identity into the new worktree's local config", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const wt = yield* Worktree.Service
          const info = yield* wt.makeWorktreeInfo()
          yield* wt.createFromInfo(info)
          // The fixture sets the parent repo's local identity to Test/test@mimocode.test.
          const name = (yield* Effect.promise(() => $`git config user.name`.cwd(info.directory).quiet().text())).trim()
          const email = (
            yield* Effect.promise(() => $`git config user.email`.cwd(info.directory).quiet().text())
          ).trim()
          expect(name).toBe("Test")
          expect(email).toBe("test@mimocode.test")
          yield* wt.remove({ directory: info.directory })
        }),
      { git: true },
    ),
  )

  it.live("pins NO identity when the parent has none, leaving the fallback to git", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // Strip the parent's identity so the abstain path is exercised.
          yield* Effect.promise(() => $`git config --unset user.name`.cwd(dir).quiet().nothrow())
          yield* Effect.promise(() => $`git config --unset user.email`.cwd(dir).quiet().nothrow())
          const wt = yield* Worktree.Service
          const info = yield* wt.makeWorktreeInfo()
          yield* wt.createFromInfo(info)
          // --local, so a global identity on the host machine cannot mask an
          // identity we wrongly pinned into the worktree.
          const name = (
            yield* Effect.promise(() =>
              $`git config --local --get user.name`.cwd(info.directory).quiet().nothrow().text(),
            )
          ).trim()
          const email = (
            yield* Effect.promise(() =>
              $`git config --local --get user.email`.cwd(info.directory).quiet().nothrow().text(),
            )
          ).trim()
          expect(name).toBe("")
          expect(email).toBe("")
          yield* wt.remove({ directory: info.directory })
        }),
      { git: true },
    ),
  )

  it.live("does not override an identity git itself would resolve from EMAIL", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => $`git config --unset user.name`.cwd(dir).quiet().nothrow())
          yield* Effect.promise(() => $`git config --unset user.email`.cwd(dir).quiet().nothrow())
          const wt = yield* Worktree.Service
          const info = yield* wt.makeWorktreeInfo()
          yield* wt.createFromInfo(info)
          // `git config user.email` cannot see EMAIL, but `git commit` honours it.
          // Supply the name via GIT_*_NAME so the author name never depends on
          // GECOS autodetection, and leave both email paths to git.
          const env: Record<string, string | undefined> = { ...process.env }
          env["EMAIL"] = "chosen@example.test"
          env["GIT_AUTHOR_NAME"] = "Chosen"
          env["GIT_COMMITTER_NAME"] = "Chosen"
          delete env["GIT_AUTHOR_EMAIL"]
          delete env["GIT_COMMITTER_EMAIL"]
          yield* Effect.promise(() => Bun.write(`${info.directory}/probe.txt`, "x"))
          yield* Effect.promise(() => $`git add probe.txt`.cwd(info.directory).env(env).quiet())
          yield* Effect.promise(() => $`git commit -m probe`.cwd(info.directory).env(env).quiet())
          const author = (
            yield* Effect.promise(() => $`git log -1 --format=%ae`.cwd(info.directory).env(env).quiet().text())
          ).trim()
          expect(author).toBe("chosen@example.test")
          yield* wt.remove({ directory: info.directory })
        }),
      { git: true },
    ),
  )
})
