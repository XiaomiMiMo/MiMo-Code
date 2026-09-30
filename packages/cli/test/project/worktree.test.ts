import { $ } from "bun"
import { afterEach, describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Worktree } from "../../src/worktree"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Worktree.defaultLayer, CrossSpawnSpawner.defaultLayer))
const wintest = process.platform !== "win32" ? it.live : it.live.skip

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase()
}

async function waitReady() {
  const { GlobalBus } = await import("../../src/bus/global")

  return await new Promise<{ name: string; branch: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      GlobalBus.off("event", on)
      reject(new Error("timed out waiting for worktree.ready"))
    }, 10_000)

    function on(evt: { directory?: string; payload: { type: string; properties: { name?: string; branch?: string; message?: string } } }) {
      if (evt.payload.type === Worktree.Event.Failed.type) {
        clearTimeout(timer)
        GlobalBus.off("event", on)
        reject(new Error(evt.payload.properties.message ?? "worktree bootstrap failed"))
        return
      }
      if (evt.payload.type !== Worktree.Event.Ready.type) return
      clearTimeout(timer)
      GlobalBus.off("event", on)
      resolve({ name: evt.payload.properties.name!, branch: evt.payload.properties.branch! })
    }

    GlobalBus.on("event", on)
  })
}

describe("Worktree", () => {
  afterEach(() => Instance.disposeAll())

  describe("makeWorktreeInfo", () => {
    it.live("returns info with name, branch, and directory", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo()

            expect(info.name).toBeDefined()
            expect(typeof info.name).toBe("string")
            expect(info.branch).toBe(`mimocode/${info.name}`)
            expect(info.directory).toContain(info.name)
          }),
        { git: true, outsideGit: true },
      ),
    )

    it.live("uses provided name as base", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo("my-feature")

            expect(info.name).toBe("my-feature")
            expect(info.branch).toBe("mimocode/my-feature")
          }),
        { git: true, outsideGit: true },
      ),
    )

    it.live("slugifies the provided name", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo("My Feature Branch!")

            expect(info.name).toBe("my-feature-branch")
          }),
        { git: true, outsideGit: true },
      ),
    )

    it.live("throws NotGitError for non-git directories", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const exit = yield* Effect.exit(svc.makeWorktreeInfo())

            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.NotGitError)
          }),
        { outsideGit: true },
      ),
    )
  })

  describe("create + remove lifecycle", () => {
    it.live("create returns worktree info and remove cleans up", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo()
            yield* svc.createFromInfo(info)

            expect(info.name).toBeDefined()
            expect(info.branch).toStartWith("mimocode/")
            expect(info.directory).toBeDefined()

            const ok = yield* svc.remove({ directory: info.directory })
            expect(ok).toBe(true)
            let initialized = 0
            yield* Effect.promise(() =>
              Instance.provide({
                directory: info.directory,
                init: () => {
                  initialized++
                  return Promise.resolve()
                },
                fn: () => undefined,
              }),
            )
            expect(initialized).toBe(1)
            yield* Effect.promise(() => Instance.disposeDirectory(info.directory))
          }),
        { git: true, outsideGit: true },
      ),
    )

    it.live("create returns after setup and fires Event.Ready after bootstrap", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create()

            expect(info.name).toBeDefined()
            expect(info.branch).toStartWith("mimocode/")

            const text = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(dir).quiet().text())
            const next = yield* Effect.promise(() => fs.realpath(info.directory).catch(() => info.directory))
            expect(normalize(text)).toContain(normalize(next))

            const props = yield* Effect.promise(() => ready)
            expect(props.name).toBe(info.name)
            expect(props.branch).toBe(info.branch)

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true, outsideGit: true },
      ),
    )

    it.live("create with custom name", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create({ name: "test-workspace" })

            expect(info.name).toBe("test-workspace")
            expect(info.branch).toBe("mimocode/test-workspace")

            yield* Effect.promise(() => ready)
            yield* svc.remove({ directory: info.directory })
          }),
        { git: true, outsideGit: true },
      ),
    )
  })

  describe("createFromInfo", () => {
    wintest("creates and bootstraps git worktree", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo("from-info-test")
            yield* svc.createFromInfo(info)

            const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(dir).quiet().text())
            const normalizedList = list.replace(/\\/g, "/")
            const normalizedDir = info.directory.replace(/\\/g, "/")
            expect(normalizedList).toContain(normalizedDir)

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true, outsideGit: true },
      ),
    )
  })

  describe("branch ref advances after commit", () => {
    it.live("child commit in worktree advances the branch ref as seen from the outer repo", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo("ref-advance")
            yield* svc.createFromInfo(info)

            // HEAD in the worktree must be attached to the branch, not detached.
            const symbolic = yield* Effect.promise(() =>
              $`git symbolic-ref --quiet HEAD`.cwd(info.directory).quiet().text(),
            )
            expect(symbolic.trim()).toBe(`refs/heads/${info.branch}`)

            // Commit inside the worktree.
            yield* Effect.promise(() => Bun.write(path.join(info.directory, "change.txt"), "hello"))
            yield* Effect.promise(() => $`git add change.txt`.cwd(info.directory).quiet())
            yield* Effect.promise(() => $`git commit -m "child change"`.cwd(info.directory).quiet())

            const worktreeHead = (
              yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(info.directory).quiet().text())
            ).trim()

            // The branch ref, read from the OUTER repo, must point at the new commit.
            const outerRef = (
              yield* Effect.promise(() => $`git rev-parse ${info.branch}`.cwd(dir).quiet().text())
            ).trim()

            expect(outerRef).toBe(worktreeHead)

            yield* Effect.promise(() => Instance.disposeDirectory(info.directory))
            yield* Effect.promise(() => Bun.sleep(100))
            yield* svc.remove({ directory: info.directory })
          }),
        { git: true, outsideGit: true },
      ),
    )

    it.live("concurrent worktree creates + commits do not lose a branch ref advance", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service

            const infos = yield* Effect.forEach([0, 1, 2], (i) => svc.makeWorktreeInfo(`concurrent-${i}`), {
              concurrency: 1,
            })

            // Create all worktrees concurrently — they share one ref store.
            yield* Effect.forEach(infos, (info) => svc.createFromInfo(info), { concurrency: "unbounded" })

            // Commit into each worktree concurrently.
            const heads = yield* Effect.forEach(
              infos,
              (info) =>
                Effect.gen(function* () {
                  yield* Effect.promise(() =>
                    Bun.write(path.join(info.directory, "change.txt"), `hello ${info.name}`),
                  )
                  yield* Effect.promise(() => $`git add change.txt`.cwd(info.directory).quiet())
                  yield* Effect.promise(() => $`git commit -m "commit ${info.name}"`.cwd(info.directory).quiet())
                  const head = (
                    yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(info.directory).quiet().text())
                  ).trim()
                  return { info, head }
                }),
              { concurrency: "unbounded" },
            )

            // Every branch ref, read from the outer repo, must point at its commit.
            for (const { info, head } of heads) {
              const outerRef = (
                yield* Effect.promise(() => $`git rev-parse ${info.branch}`.cwd(dir).quiet().text())
              ).trim()
              expect(outerRef).toBe(head)
            }

            for (const { info } of heads) {
              yield* Effect.promise(() => Instance.disposeDirectory(info.directory))
            }
            yield* Effect.promise(() => Bun.sleep(100))
            for (const { info } of heads) {
              yield* svc.remove({ directory: info.directory }).pipe(Effect.ignore)
            }
          }),
        { git: true, outsideGit: true },
      ),
    )
  })

  describe("remove edge cases", () => {
    it.live("remove non-existent directory succeeds silently", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const target = path.join(dir, "does-not-exist")
            let initialized = 0
            yield* Effect.promise(() =>
              Instance.provide({
                directory: target,
                init: () => {
                  initialized++
                  return Promise.resolve()
                },
                fn: () => undefined,
              }),
            )

            const ok = yield* svc.remove({ directory: target })
            expect(ok).toBe(true)
            yield* Effect.promise(() =>
              Instance.provide({
                directory: target,
                init: () => {
                  initialized++
                  return Promise.resolve()
                },
                fn: () => undefined,
              }),
            )
            expect(initialized).toBe(2)
            yield* Effect.promise(() => Instance.disposeDirectory(target))
          }),
        { git: true, outsideGit: true },
      ),
    )

    it.live("throws NotGitError for non-git directories", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const exit = yield* Effect.exit(svc.remove({ directory: "/tmp/fake" }))

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.NotGitError)
        }),
        { outsideGit: true },
      ),
    )
  })
})
