import { afterEach, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Scope, ScopedCache } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Hash } from "@mimo-ai/shared/util/hash"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Config } from "../../src/config"
import { Global } from "../../src/global"
import { Snapshot } from "../../src/snapshot"
import * as Resources from "../../src/snapshot/resources"
import { Instance } from "../../src/project/instance"
import { provideInstance, tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

const clock = Effect.gen(function* () {
  const base = yield* TestClock.make({ warningDelay: "30 seconds" })
  const sleeps: number[] = []
  return {
    ...base,
    sleeps,
    sleep: (duration: Duration.Duration) =>
      Effect.suspend(() => {
        sleeps.push(Duration.toMillis(duration))
        return base.sleep(duration)
      }),
  }
})

function observe(before?: (command: ChildProcess.StandardCommand) => Effect.Effect<void>) {
  const calls: {
    command: ChildProcess.StandardCommand
    handle: ChildProcessSpawner.ChildProcessHandle
    code?: number
  }[] = []
  const layer = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          if (!ChildProcess.isStandardCommand(command)) return yield* real.spawn(command)
          if (before) yield* before(command)
          const handle = yield* real.spawn(command)
          const call = { command, handle, code: undefined as number | undefined }
          calls.push(call)
          return ChildProcessSpawner.makeHandle({
            ...handle,
            exitCode: handle.exitCode.pipe(
              Effect.tap((code) =>
                Effect.sync(() => {
                  call.code = code
                }),
              ),
            ),
          })
        }),
      )
    }),
  ).pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))
  return { calls, layer }
}

const snapshotLayer = (
  spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  config: Layer.Layer<Config.Service> = Config.defaultLayer,
) => Snapshot.layer.pipe(Layer.provide(spawner), Layer.provide(AppFileSystem.defaultLayer), Layer.provideMerge(config))

const instance = (directory: string) =>
  Effect.promise(() => Instance.provide({ directory, fn: () => Instance.current }))

const gitdir = (ctx: { project: { id: string }; worktree: string }) =>
  path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))

const wait = (predicate: () => boolean | Promise<boolean>) =>
  Effect.promise(async () => {
    for (let i = 0; i < 400; i++) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error("snapshot operation did not settle")
  })

// [TP-R12-12] Tree contents expose overlapping index writes that mere spawn counts would miss.
test("shared git index stays serialized through queued callers and reborrow while other worktrees proceed", async () => {
  await using tmp = await tmpdir({ git: true })
  const a = path.join(tmp.path, "a")
  const b = path.join(tmp.path, "b")
  const other = path.join(tmp.path, "linked")
  await fs.mkdir(a)
  await fs.mkdir(b)
  await fs.writeFile(path.join(a, "value.txt"), "a-before")
  await fs.writeFile(path.join(b, "value.txt"), "b-before")
  await $`git worktree add -b feat/example ${other}`.cwd(tmp.path).quiet()
  await fs.writeFile(path.join(other, "value.txt"), "other-before")
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let armed = false
      const spy = observe((command) =>
        Effect.gen(function* () {
          if (!armed || command.options.cwd !== a || !command.args.includes("write-tree")) return
          armed = false
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      yield* Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const ca = yield* instance(a)
        const cb = yield* instance(b)
        const cc = yield* instance(other)
        expect(ca.worktree).toBe(cb.worktree)
        expect(cc.worktree).toBe(other)
        expect(cc.project.id).toBe(ca.project.id)
        expect(gitdir(cc)).not.toBe(gitdir(ca))
        yield* snapshot.track().pipe(Effect.provideService(InstanceRef, ca))
        yield* snapshot.track().pipe(Effect.provideService(InstanceRef, cb))
        yield* snapshot.track().pipe(Effect.provideService(InstanceRef, cc))
        yield* Effect.promise(() => fs.writeFile(path.join(a, "added.txt"), "a-after"))
        yield* Effect.promise(() => fs.writeFile(path.join(b, "added.txt"), "b-after"))
        yield* Effect.promise(() => fs.writeFile(path.join(other, "value.txt"), "other-after"))
        armed = true
        const first = yield* snapshot.track().pipe(Effect.provideService(InstanceRef, ca), Effect.forkScoped)
        yield* Deferred.await(started)
        const second = yield* snapshot.track().pipe(Effect.provideService(InstanceRef, cb), Effect.forkScoped)
        yield* Effect.yieldNow
        const isolated = yield* snapshot.track().pipe(Effect.provideService(InstanceRef, cc))
        expect(isolated).toMatch(/^[0-9a-f]{40}$/)
        expect(yield* Effect.promise(() => $`git --git-dir ${gitdir(cc)} show ${`${isolated}:value.txt`}`.text())).toBe(
          "other-after",
        )
        yield* Effect.promise(() => Instance.disposeDirectory(a))
        yield* Effect.promise(() => Instance.disposeDirectory(b))
        const next = yield* instance(a)
        const borrowed = yield* snapshot.track().pipe(Effect.provideService(InstanceRef, next), Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        const h1 = yield* Fiber.join(first)
        const h2 = yield* Fiber.join(second)
        const h3 = yield* Fiber.join(borrowed)
        const show = (hash: string | undefined, file: string) =>
          Effect.promise(() => $`git --git-dir ${gitdir(ca)} show ${`${hash}:${file}`}`.text())
        expect(yield* show(h1, "a/added.txt")).toBe("a-after")
        expect(yield* show(h1, "b/value.txt")).toBe("b-before")
        expect(
          yield* Effect.promise(() => $`git --git-dir ${gitdir(ca)} ls-tree -r --name-only ${h1}`.text()),
        ).not.toContain("b/added.txt")
        expect(yield* show(h2, "b/added.txt")).toBe("b-after")
        expect(h3).toBe(h2)
        yield* Effect.promise(() => Instance.disposeDirectory(a))
        yield* Effect.promise(() => Instance.disposeDirectory(other))
        expect(yield* show(h1, "b/value.txt")).toBe("b-before")
        expect(yield* Effect.forEach(spy.calls, (call) => call.handle.isRunning)).not.toContain(true)
        expect(spy.calls.every((call) => call.code === 0 || call.command.args.includes("check-ignore"))).toBe(true)
      }).pipe(Effect.provide(snapshotLayer(spy.layer)))
    }).pipe(Effect.scoped),
  )
}, 20_000)

// [TP-R12-12] Closing the runtime must reap the actual GC process and its hook child.
test("runtime shutdown interrupts an in-flight git GC and reaps its process group", async () => {
  await using tmp = await tmpdir({ git: true })
  await using markers = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "kept.txt"), "retained")
  const marker = path.join(markers.path, "hook.pid")
  const spy = observe()
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const time = yield* clock
      let pid = 0
      yield* Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const hash = yield* snapshot.track().pipe(provideInstance(tmp.path))
        const store = gitdir(yield* instance(tmp.path))
        const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
        const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(() => {}, 1000)`
        const hook = `${quote(process.execPath)} -e ${quote(script)}`
        yield* Effect.promise(() => $`git --git-dir ${store} config gc.cruftPacks true`.quiet())
        yield* Effect.promise(() => $`git --git-dir ${store} config gc.recentObjectsHook ${hook}`.quiet())
        const loose = (yield* Effect.promise(() =>
          $`git --git-dir ${store} hash-object -w --stdin < ${Buffer.from("unreachable")}`.text(),
        )).trim()
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
        yield* Effect.promise(() => fs.utimes(path.join(store, "objects", loose.slice(0, 2), loose.slice(2)), old, old))
        yield* time.adjust("1 minute")
        yield* wait(() =>
          fs.access(marker).then(
            () => true,
            () => false,
          ),
        )
        pid = Number(yield* Effect.promise(() => fs.readFile(marker, "utf8")))
        expect(alive(pid)).toBe(true)
        const gc = spy.calls.find((call) => call.command.args.includes("gc"))!
        expect(yield* gc.handle.isRunning).toBe(true)
        expect(yield* Effect.promise(() => $`git --git-dir ${store} show ${`${hash}:kept.txt`}`.text())).toBe(
          "retained",
        )
      }).pipe(Effect.provide(snapshotLayer(spy.layer)), Effect.provideService(Clock.Clock, time))
      expect(yield* Effect.forEach(spy.calls, (call) => call.handle.isRunning)).not.toContain(true)
      yield* wait(() => !alive(pid))
      expect(alive(pid)).toBe(false)
      const count = spy.calls.length
      yield* time.adjust("2 hours")
      expect(spy.calls).toHaveLength(count)
    }).pipe(Effect.scoped),
  )
}, 20_000)

// [TP-R12-12] A cached caller interruption must not terminate the shared Runtime cleanup fiber.
test("runtime GC survives replayed ScopedCache interruptions across leases and later cycles", async () => {
  await using tmp = await tmpdir({ git: true })
  await using other = await tmpdir({ git: true })
  const bad = path.join(tmp.path, "bad")
  const good = path.join(tmp.path, "good")
  await fs.mkdir(bad)
  await fs.mkdir(good)
  await fs.writeFile(path.join(good, "kept.txt"), "shared retained")
  await fs.writeFile(path.join(other.path, "kept.txt"), "other retained")
  const spy = observe()
  await Effect.runPromise(
    Effect.gen(function* () {
      const time = yield* clock
      const real = yield* Config.Service
      const started = yield* Deferred.make<void>()
      let lookups = 0
      const cache = yield* ScopedCache.make<string, Config.Info>({
        capacity: 8,
        lookup: (directory) =>
          Effect.gen(function* () {
            if (directory !== bad) return yield* real.get()
            lookups += 1
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
      })
      const config = Layer.succeed(
        Config.Service,
        Config.Service.of({
          ...real,
          get: () =>
            Effect.gen(function* () {
              const ctx = yield* InstanceRef
              if (!ctx) return yield* Effect.die(new Error("missing test instance"))
              return yield* ScopedCache.get(cache, ctx.directory)
            }),
        }),
      )
      yield* Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const cbad = yield* instance(bad)
        const caller = yield* snapshot.track().pipe(Effect.provideService(InstanceRef, cbad), Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(caller)
        const replay = yield* ScopedCache.get(cache, bad).pipe(Effect.forkChild)
        const exit = yield* Fiber.await(replay)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(lookups).toBe(1)
        const shared = yield* snapshot.track().pipe(provideInstance(good))
        const isolated = yield* snapshot.track().pipe(provideInstance(other.path))
        expect(shared).toMatch(/^[0-9a-f]{40}$/)
        expect(isolated).toMatch(/^[0-9a-f]{40}$/)
        const stores = [gitdir(yield* instance(good)), gitdir(yield* instance(other.path))]
        for (const cycle of [1, 2]) {
          yield* time.adjust(cycle === 1 ? "1 minute" : "1 hour")
          yield* wait(() => time.sleeps.filter((ms) => ms === 3_600_000).length === cycle)
          const gc = spy.calls.filter((call) => call.command.args.includes("gc"))
          expect(gc).toHaveLength(cycle * 2)
          expect(gc.every((call) => call.code === 0)).toBe(true)
          expect(gc.slice(-2).map((call) => call.command.options.cwd)).toEqual([tmp.path, other.path])
          expect(lookups).toBe(1)
          expect(
            yield* Effect.promise(() => $`git --git-dir ${stores[0]} show ${`${shared}:good/kept.txt`}`.text()),
          ).toBe("shared retained")
          expect(yield* Effect.promise(() => $`git --git-dir ${stores[1]} show ${`${isolated}:kept.txt`}`.text())).toBe(
            "other retained",
          )
        }
      }).pipe(Effect.provide(snapshotLayer(spy.layer, config)), Effect.provideService(Clock.Clock, time))
      expect(yield* Effect.forEach(spy.calls, (call) => call.handle.isRunning)).not.toContain(true)
      const count = spy.calls.length
      yield* time.adjust("2 hours")
      expect(spy.calls).toHaveLength(count)
    }).pipe(Effect.scoped, Effect.provide(Config.defaultLayer)),
  )
}, 20_000)

// [TP-R12-12] Runtime cancellation must settle the enablement child before releasing the repository lock.
test("runtime cancellation waits for a suspended enablement child to finalize", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pool = Resources.make()
      const resource = { gitdir: "/tmp/example/snapshot", worktree: "/tmp/example/worktree" }
      const runtime = yield* scope
      const started = yield* Deferred.make<void>()
      const finalizing = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const order: string[] = []
      yield* pool.acquire(
        resource,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(finalizing, undefined)
              yield* Deferred.await(finish)
              order.push("finalized")
            }),
          ),
        ),
      )
      const sweep = yield* pool
        .sweep(() =>
          Effect.sync(() => {
            order.push("gc")
          }),
        )
        .pipe(Effect.forkIn(runtime))
      yield* Deferred.await(started)
      const closing = yield* Scope.close(runtime, Exit.void).pipe(Effect.forkScoped)
      yield* Deferred.await(finalizing)
      const next = yield* pool
        .locked(
          resource,
          Effect.sync(() => {
            order.push("next")
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(order).toEqual([])
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(closing)
      yield* Fiber.join(next)
      const exit = yield* Fiber.await(sweep)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(order).toEqual(["finalized", "next"])
    }).pipe(Effect.scoped),
  ))

// [TP-R12-12] A delayed caller must resolve the current entry instead of keeping a retired lock.
test("resource entries retain queued operations and reborrow one lock until settlement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pool = Resources.make()
      const resource = { gitdir: "/tmp/example/snapshot", worktree: "/tmp/example/worktree" }
      const first = yield* scope
      yield* pool.acquire(resource, Effect.succeed(true)).pipe(Effect.provideService(Scope.Scope, first))
      const order: string[] = []
      const stale = pool.locked(
        resource,
        Effect.sync(() => {
          order.push("stale")
        }),
      )
      yield* Scope.close(first, Exit.void)
      const second = yield* scope
      yield* pool.acquire(resource, Effect.succeed(true)).pipe(Effect.provideService(Scope.Scope, second))
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const running = yield* pool
        .locked(
          resource,
          Effect.gen(function* () {
            order.push("start")
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            order.push("end")
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const queued = yield* stale.pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Scope.close(second, Exit.void)
      expect(order).toEqual(["start"])
      const third = yield* scope
      yield* pool.acquire(resource, Effect.succeed(true)).pipe(Effect.provideService(Scope.Scope, third))
      const borrowed = yield* pool
        .locked(
          resource,
          Effect.sync(() => {
            order.push("borrowed")
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(order).toEqual(["start"])
      yield* Scope.close(third, Exit.void)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      yield* Fiber.join(queued)
      yield* Fiber.join(borrowed)
      expect(order).toEqual(["start", "end", "stale", "borrowed"])
      expect(Exit.isFailure(yield* pool.locked(resource, Effect.fail("test failure")).pipe(Effect.exit))).toBe(true)
      const cancelled = yield* pool.locked(resource, Effect.never).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const waiting = yield* pool.locked(resource, Effect.void).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      yield* Fiber.interrupt(cancelled)
      yield* pool.locked(
        resource,
        Effect.sync(() => {
          order.push("recovered")
        }),
      )
      expect(order.at(-1)).toBe("recovered")
      const last = yield* scope
      const checking = yield* Deferred.make<void>()
      const checked = yield* Deferred.make<boolean>()
      yield* pool
        .acquire(resource, Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(checked))))
        .pipe(Effect.provideService(Scope.Scope, last))
      const sweep = yield* pool
        .sweep(() =>
          Effect.sync(() => {
            order.push("gc")
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(checking)
      yield* Scope.close(last, Exit.void)
      yield* Deferred.succeed(checked, true)
      yield* Fiber.join(sweep)
      expect(order).not.toContain("gc")
      const errors = yield* scope
      const healthy = { gitdir: "/tmp/example/healthy", worktree: "/tmp/example/other" }
      yield* pool
        .acquire(resource, Effect.die("invalid configuration"))
        .pipe(Effect.provideService(Scope.Scope, errors))
      yield* pool.acquire(resource, Effect.succeed(true)).pipe(Effect.provideService(Scope.Scope, errors))
      yield* pool.acquire(healthy, Effect.succeed(true)).pipe(Effect.provideService(Scope.Scope, errors))
      const cleaned: string[] = []
      yield* pool.sweep((value) =>
        Effect.sync(() => {
          cleaned.push(value.gitdir)
        }),
      )
      expect(cleaned).toEqual([resource.gitdir, healthy.gitdir])
      yield* Scope.close(errors, Exit.void)
    }).pipe(Effect.scoped),
  ))

const scope = Effect.gen(function* () {
  const value = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(value, Exit.void))
  return value
})

// [TP-R12-12] Runtime ownership prevents one cleanup timer per caller directory.
test("one runtime schedules snapshot GC once for multiple directories", async () => {
  await using tmp = await tmpdir({ git: true })
  await using other = await tmpdir({ git: true })
  await using plain = await tmpdir({ outsideGit: true, config: { snapshot: true } })
  await fs.writeFile(path.join(other.path, "other.txt"), "other content")
  const spy = observe()
  const a = path.join(tmp.path, "a")
  const b = path.join(tmp.path, "b")
  await fs.mkdir(a)
  await fs.mkdir(b)
  await fs.writeFile(path.join(a, "one.txt"), "one")
  await fs.writeFile(path.join(b, "two.txt"), "two")
  await Effect.runPromise(
    Effect.gen(function* () {
      const time = yield* clock
      yield* Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        expect(yield* snapshot.track().pipe(provideInstance(a))).toBeTruthy()
        expect(yield* snapshot.track().pipe(provideInstance(b))).toBeTruthy()
        const hash = yield* snapshot.track().pipe(provideInstance(other.path))
        expect(hash).toBeTruthy()
        expect(yield* snapshot.track().pipe(provideInstance(plain.path))).toBeUndefined()
        yield* Effect.yieldNow
        expect(time.sleeps.filter((ms) => ms === 60_000)).toHaveLength(1)
        const ctx = yield* instance(a)
        expect(ctx.worktree).toBe(tmp.path)
        yield* time.adjust("1 minute")
        yield* wait(() => time.sleeps.filter((ms) => ms === 3_600_000).length === 1)
        const gc = spy.calls.filter((call) => call.command.args.includes("gc"))
        expect(new Set(gc.map((call) => call.command.options.cwd))).toEqual(new Set([tmp.path, other.path]))
        expect(gc.map((call) => call.code)).toEqual([0, 0])
        const store = gitdir(yield* instance(other.path))
        expect(yield* Effect.promise(() => $`git --git-dir ${store} show ${`${hash}:other.txt`}`.text())).toBe(
          "other content",
        )
      }).pipe(Effect.provide(snapshotLayer(spy.layer)), Effect.provideService(Clock.Clock, time))
      expect(yield* Effect.forEach(spy.calls, (call) => call.handle.isRunning)).not.toContain(true)
    }).pipe(Effect.scoped),
  )
}, 20_000)

// [TP-R12-12] GC follows live configuration leases without borrowing the first directory.
test("runtime GC uses the physical tree and preserves caller enablement across disposal and reload", async () => {
  await using tmp = await tmpdir({ git: true })
  const a = path.join(tmp.path, "disabled")
  const b = path.join(tmp.path, "enabled")
  await fs.mkdir(a)
  await fs.mkdir(b)
  await fs.writeFile(path.join(a, "mimocode.json"), JSON.stringify({ snapshot: false }))
  await fs.writeFile(path.join(a, "hidden.txt"), "disabled content")
  await fs.writeFile(path.join(b, "mimocode.json"), JSON.stringify({ snapshot: true }))
  await fs.writeFile(path.join(b, "kept.txt"), "enabled content")
  const spy = observe()
  await Effect.runPromise(
    Effect.gen(function* () {
      const time = yield* clock
      yield* Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        expect(yield* snapshot.track().pipe(provideInstance(a))).toBeUndefined()
        const hash = yield* snapshot.track().pipe(provideInstance(b))
        expect(hash).toMatch(/^[0-9a-f]{40}$/)
        const store = gitdir(yield* instance(b))
        const show = (ref: string) => Effect.promise(() => $`git --git-dir ${store} show ${ref}`.text())
        expect(yield* show(`${hash}:enabled/kept.txt`)).toBe("enabled content")
        expect(
          yield* Effect.promise(() => $`git --git-dir ${store} ls-tree -r --name-only ${hash}`.text()),
        ).not.toContain("disabled/")
        yield* snapshot.cleanup().pipe(provideInstance(a))
        expect(spy.calls.filter((call) => call.command.args.includes("gc"))).toHaveLength(0)
        yield* snapshot.cleanup().pipe(provideInstance(b))
        expect(spy.calls.filter((call) => call.command.args.includes("gc"))[0].command.options.cwd).toBe(b)
        const gc = () => spy.calls.filter((call) => call.command.args.includes("gc"))
        yield* time.adjust("59 seconds")
        expect(gc()).toHaveLength(1)
        yield* time.adjust("1 second")
        yield* wait(() => time.sleeps.filter((ms) => ms === 3_600_000).length === 1)
        expect(gc()).toHaveLength(2)
        expect(gc()[1].command.options.cwd).toBe(tmp.path)
        expect(gc()[1].command.args).toEqual(["--git-dir", store, "--work-tree", tmp.path, "gc", "--prune=7.days"])
        expect(gc()[1].code).toBe(0)
        yield* Effect.promise(() => Instance.disposeDirectory(a))
        yield* Effect.promise(() => fs.rm(a, { recursive: true }))
        yield* time.adjust("1 hour")
        yield* wait(() => time.sleeps.filter((ms) => ms === 3_600_000).length === 2)
        expect(gc()).toHaveLength(3)
        expect(gc()[2].code).toBe(0)
        yield* Effect.promise(() => fs.writeFile(path.join(b, "mimocode.json"), JSON.stringify({ snapshot: false })))
        expect(yield* snapshot.track().pipe(provideInstance(b))).toBeTruthy()
        yield* Effect.promise(() => Instance.reload({ directory: b }))
        yield* snapshot.init().pipe(provideInstance(b))
        yield* time.adjust("1 hour")
        yield* wait(() => time.sleeps.filter((ms) => ms === 3_600_000).length === 3)
        expect(gc()).toHaveLength(3)
        expect(yield* snapshot.track().pipe(provideInstance(b))).toBeUndefined()
        yield* Effect.promise(() => Instance.disposeDirectory(b))
        yield* time.adjust("1 hour")
        yield* wait(() => time.sleeps.filter((ms) => ms === 3_600_000).length === 4)
        expect(gc()).toHaveLength(3)
        expect(yield* show(`${hash}:enabled/kept.txt`)).toBe("enabled content")
        yield* Effect.promise(() => fs.writeFile(path.join(b, "mimocode.json"), JSON.stringify({ snapshot: true })))
        expect(yield* snapshot.track().pipe(provideInstance(b))).toBeTruthy()
        yield* time.adjust("1 hour")
        yield* wait(() => time.sleeps.filter((ms) => ms === 3_600_000).length === 5)
        expect(gc()).toHaveLength(4)
        expect(time.sleeps.filter((ms) => ms === 60_000)).toHaveLength(1)
      }).pipe(Effect.provide(snapshotLayer(spy.layer)), Effect.provideService(Clock.Clock, time))
      expect(yield* Effect.forEach(spy.calls, (call) => call.handle.isRunning)).not.toContain(true)
      const count = spy.calls.length
      yield* time.adjust("2 hours")
      expect(spy.calls).toHaveLength(count)
    }).pipe(Effect.scoped),
  )
}, 20_000)
