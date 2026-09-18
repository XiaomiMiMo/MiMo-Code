import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Deferred, Effect, Layer, ManagedRuntime, Option } from "effect"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { FileWatcher } from "../../src/file/watcher"
import { Git } from "../../src/git"
import { Instance } from "../../src/project/instance"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceRef } from "../../src/effect/instance-ref"

// Native @parcel/watcher bindings aren't reliably available in CI (missing on Linux, flaky on Windows)
const describeWatcher = FileWatcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const watcherConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    MIMOCODE_EXPERIMENTAL_FILEWATCHER: "true",
    MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

/** Run `body` with a live FileWatcher service. */
function withWatcher<E>(directory: string, body: Effect.Effect<void, E>) {
  return Instance.provide({
    directory,
    fn: async () => {
      const layer: Layer.Layer<FileWatcher.Service, never, never> = FileWatcher.layer.pipe(
        Layer.provide(Config.defaultLayer),
        Layer.provide(Git.defaultLayer),
        Layer.provide(watcherConfigLayer),
      )
      const rt = ManagedRuntime.make(layer)
      try {
        await rt.runPromise(FileWatcher.Service.use((s) => s.init()))
        await Effect.runPromise(ready(directory))
        await Effect.runPromise(body)
      } finally {
        await rt.dispose()
      }
    },
  })
}

function listen(directory: string, check: (evt: WatcherEvent) => boolean, hit: (evt: WatcherEvent) => void) {
  let done = false

  const unsub = Bus.subscribe(FileWatcher.Event.Updated, (evt) => {
    if (done) return
    if (!check(evt.properties)) return
    hit(evt.properties)
  })

  return () => {
    if (done) return
    done = true
    unsub()
  }
}

function wait(directory: string, check: (evt: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<WatcherEvent>()
    const cleanup = yield* Effect.sync(() => {
      let off = () => {}
      off = listen(directory, check, (evt) => {
        off()
        Deferred.doneUnsafe(deferred, Effect.succeed(evt))
      })
      return off
    })
    return { cleanup, deferred }
  })
}

function nextUpdate<E>(directory: string, check: (evt: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.acquireUseRelease(
    wait(directory, check),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        return yield* Deferred.await(deferred).pipe(Effect.timeout("5 seconds"))
      }),
    ({ cleanup }) => Effect.sync(cleanup),
  )
}

/** Effect that asserts no matching event arrives within `ms`. */
function noUpdate<E>(
  directory: string,
  check: (evt: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  ms = 500,
) {
  return Effect.acquireUseRelease(
    wait(directory, check),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption(`${ms} millis`))).toEqual(Option.none())
      }),
    ({ cleanup }) => Effect.sync(cleanup),
  )
}

function ready(directory: string) {
  const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
  const head = path.join(directory, ".git", "HEAD")

  return Effect.gen(function* () {
    yield* nextUpdate(
      directory,
      (evt) => evt.file === file && evt.event === "add",
      Effect.promise(() => fs.writeFile(file, "ready")),
    ).pipe(Effect.ensuring(Effect.promise(() => fs.rm(file, { force: true }).catch(() => undefined))), Effect.asVoid)

    const git = yield* Effect.promise(() =>
      fs
        .stat(head)
        .then(() => true)
        .catch(() => false),
    )
    if (!git) return

    const branch = `watch-${Math.random().toString(36).slice(2)}`
    const hash = yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(directory).quiet().text())
    yield* nextUpdate(
      directory,
      (evt) => evt.file === head && evt.event !== "unlink",
      Effect.promise(async () => {
        await fs.writeFile(path.join(directory, ".git", "refs", "heads", branch), hash.trim() + "\n")
        await fs.writeFile(head, `ref: refs/heads/${branch}\n`)
      }),
    ).pipe(Effect.asVoid)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWatcher("FileWatcher", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("publishes root create, update, and delete events", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "watch.txt")
    const dir = tmp.path
    const cases = [
      { event: "add" as const, trigger: Effect.promise(() => fs.writeFile(file, "a")) },
      { event: "change" as const, trigger: Effect.promise(() => fs.writeFile(file, "b")) },
      { event: "unlink" as const, trigger: Effect.promise(() => fs.unlink(file)) },
    ]

    await withWatcher(
      dir,
      Effect.forEach(cases, ({ event, trigger }) =>
        nextUpdate(dir, (evt) => evt.file === file && evt.event === event, trigger).pipe(
          Effect.tap((evt) => Effect.sync(() => expect(evt).toEqual({ file, event }))),
        ),
      ),
    )
  })

  test("watches non-git roots", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "plain.txt")
    const dir = tmp.path

    await withWatcher(
      dir,
      nextUpdate(
        dir,
        (e) => e.file === file && e.event === "add",
        Effect.promise(() => fs.writeFile(file, "plain")),
      ).pipe(Effect.tap((evt) => Effect.sync(() => expect(evt).toEqual({ file, event: "add" })))),
    )
  })

  test("cleanup stops publishing events", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "after-dispose.txt")

    // Start and immediately stop the watcher (withWatcher disposes on exit)
    await withWatcher(tmp.path, Effect.void)

    // Now write a file — no watcher should be listening
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Effect.runPromise(
          noUpdate(
            tmp.path,
            (e) => e.file === file,
            Effect.promise(() => fs.writeFile(file, "gone")),
          ),
        ),
    })
  })

  test("ignores .git/index changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const gitIndex = path.join(tmp.path, ".git", "index")
    const edit = path.join(tmp.path, "tracked.txt")

    await withWatcher(
      tmp.path,
      noUpdate(
        tmp.path,
        (e) => e.file === gitIndex,
        Effect.promise(async () => {
          await fs.writeFile(edit, "a")
          await $`git add .`.cwd(tmp.path).quiet().nothrow()
        }),
      ),
    )
  })

  // engine-runtime: [TP-R12-11]
  test("routes shared HEAD updates to both Instances and keeps the remaining subscriber alive", async () => {
    await using tmp = await tmpdir({ git: true })
    const directories = [path.join(tmp.path, "first"), path.join(tmp.path, "second")]
    await Promise.all(directories.map((directory) => fs.mkdir(directory)))
    await $`git branch next-head`.cwd(tmp.path).quiet()
    await $`git branch final-head`.cwd(tmp.path).quiet()
    const runtime = ManagedRuntime.make(FileWatcher.defaultLayer.pipe(Layer.provide(watcherConfigLayer)))
    const counts = [0, 0]
    const head = path.join(tmp.path, ".git", "HEAD")
    const observed = (predicate: () => boolean) =>
      Effect.runPromise(
        Effect.gen(function* () {
          while (!predicate()) yield* Effect.sleep("10 millis")
        }).pipe(Effect.timeout("5 seconds")),
      )
    try {
      for (const [index, directory] of directories.entries()) {
        await Instance.provide({
          directory,
          fn: async () => {
            Bus.subscribe(FileWatcher.Event.Updated, (event) => {
              if (event.properties.file === head) counts[index]++
            })
            await runtime.runPromise(FileWatcher.Service.use((service) => service.init()))
          },
        })
      }
      await fs.writeFile(head, "ref: refs/heads/next-head\n")
      await observed(() => counts.every((count) => count > 0))
      await Instance.provide({ directory: directories[0], fn: () => Instance.dispose() })
      const before = counts.slice()
      await fs.writeFile(head, "ref: refs/heads/final-head\n")
      await observed(() => counts[1] > before[1])
      expect(counts[0]).toBe(before[0])
    } finally {
      await runtime.dispose()
    }
  })

  for (const scenario of ["named", "first-absent", "second-absent", "effect-only"] as const) {
    // engine-runtime: [TP-R12-11]
    test(`preserves each shared subscriber workspace: ${scenario}`, async () => {
      await using tmp = await tmpdir({ git: true })
      const directories = [path.join(tmp.path, "a"), path.join(tmp.path, "b")]
      await Promise.all(directories.map((directory) => fs.mkdir(directory)))
      await $`git branch workspace-next`.cwd(tmp.path).quiet()
      const workspaces = [
        scenario === "first-absent" ? undefined : WorkspaceID.make("workspace-a"),
        scenario === "second-absent" ? undefined : WorkspaceID.make("workspace-b"),
      ]
      const runtime = ManagedRuntime.make(FileWatcher.defaultLayer.pipe(Layer.provide(watcherConfigLayer)))
      const rows: GlobalEvent[] = []
      const head = path.join(tmp.path, ".git", "HEAD")
      const receive = (event: GlobalEvent) => {
        if (event.payload.type === FileWatcher.Event.Updated.type && event.payload.properties.file === head)
          rows.push(event)
      }
      GlobalBus.on("event", receive)
      try {
        for (const [index, directory] of directories.entries()) {
          await WorkspaceContext.provide({
            workspaceID: scenario === "effect-only" ? undefined : workspaces[index],
            fn: () =>
              Instance.provide({
                directory,
                fn: () =>
                  runtime.runPromise(
                    FileWatcher.Service.use((service) => service.init()).pipe(
                      Effect.provideService(WorkspaceRef, scenario === "effect-only" ? workspaces[index] : undefined),
                    ),
                  ),
              }),
          })
        }
        await fs.writeFile(head, "ref: refs/heads/workspace-next\n")
        await Effect.runPromise(
          Effect.gen(function* () {
            while (!directories.every((directory) => rows.some((row) => row.directory === directory))) {
              yield* Effect.sleep("10 millis")
            }
          }).pipe(Effect.timeout("5 seconds")),
        )
        for (const [index, directory] of directories.entries()) {
          expect(rows.filter((row) => row.directory === directory).map((row) => row.workspace)).toEqual([
            workspaces[index],
          ])
        }
      } finally {
        GlobalBus.off("event", receive)
        await runtime.dispose()
      }
    })
  }

  // engine-runtime: [TP-R12-11]
  test("watches a linked worktree's own HEAD rather than the project main HEAD", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(tmp.path, "linked")
    await $`git worktree add -b linked ${linked}`.cwd(tmp.path).quiet()
    const gitdir = (await $`git rev-parse --absolute-git-dir`.cwd(linked).quiet().text()).trim()
    const head = path.join(gitdir, "HEAD")
    await $`git branch linked-next`.cwd(linked).quiet()
    await withWatcher(
      linked,
      nextUpdate(
        linked,
        (evt) => evt.file === head && evt.event !== "unlink",
        Effect.promise(() => fs.writeFile(head, "ref: refs/heads/linked-next\n")),
      ).pipe(Effect.tap((evt) => Effect.sync(() => expect(evt.file).toBe(head)))),
    )
  })

  test("publishes .git/HEAD events", async () => {
    await using tmp = await tmpdir({ git: true })
    const head = path.join(tmp.path, ".git", "HEAD")
    const branch = `watch-${Math.random().toString(36).slice(2)}`
    await $`git branch ${branch}`.cwd(tmp.path).quiet()

    await withWatcher(
      tmp.path,
      nextUpdate(
        tmp.path,
        (evt) => evt.file === head && evt.event !== "unlink",
        Effect.promise(() => fs.writeFile(head, `ref: refs/heads/${branch}\n`)),
      ).pipe(
        Effect.tap((evt) =>
          Effect.sync(() => {
            expect(evt.file).toBe(head)
            expect(["add", "change"]).toContain(evt.event)
          }),
        ),
      ),
    )
  })
})
