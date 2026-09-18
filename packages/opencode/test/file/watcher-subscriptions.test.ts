import { describe, expect } from "bun:test"
import * as Native from "@parcel/watcher"
import type ParcelWatcher from "@parcel/watcher"
import { Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import fs from "node:fs/promises"
import path from "node:path"
import { WatcherSubscriptions } from "../../src/file/watcher-subscriptions"
import { FileWatcher } from "../../src/file/watcher"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)
const owner = () => Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
const event: ParcelWatcher.Event = { type: "update", path: "/tmp/example/file.txt" }
const tick = () => Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

// engine-runtime: [TP-R12-11]
describe("WatcherSubscriptions", () => {
  it.live("coalesces pending subscriptions and keeps each lease even when callbacks are identical", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const a = yield* owner()
      const b = yield* owner()
      const ready = Promise.withResolvers<ParcelWatcher.AsyncSubscription>()
      const started = Promise.withResolvers<void>()
      let native: ParcelWatcher.SubscribeCallback = () => {}
      let starts = 0
      let stops = 0
      let events = 0
      const callback = () => events++
      const pool = new WatcherSubscriptions((_dir, callback) => {
        starts++
        native = callback
        started.resolve()
        return ready.promise
      })
      const first = yield* pool
        .watch(dir, ["b", "a", "a"], "fs-events", callback)
        .pipe(Effect.provideService(Scope.Scope, a), Effect.forkScoped)
      yield* Effect.promise(() => started.promise)
      const second = yield* pool
        .watch(dir, ["a", "b"], "fs-events", callback)
        .pipe(Effect.provideService(Scope.Scope, b), Effect.forkScoped)
      yield* Effect.gen(function* () {
        for (;;) {
          const before = events
          native(null, [event])
          if (events - before === 2) break
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.timeout("2 seconds"))
      expect(starts).toBe(1)
      events = 0
      ready.resolve({
        unsubscribe: async () => {
          stops++
        },
      })
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(starts).toBe(1)
      native(null, [event])
      expect(events).toBe(2)
      yield* Scope.close(a, Exit.void)
      native(null, [event])
      expect(events).toBe(3)
      expect(stops).toBe(0)
      yield* Scope.close(b, Exit.void)
      native(null, [event])
      expect(events).toBe(3)
      expect(stops).toBe(1)
    }),
  )

  for (const mode of ["cancel", "timeout"] as const) {
    it.effect(`closes a late native result after ${mode} without delivering it`, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const scope = yield* owner()
        const started = Promise.withResolvers<void>()
        const ready = Promise.withResolvers<ParcelWatcher.AsyncSubscription>()
        const stopped = Promise.withResolvers<void>()
        let native: ParcelWatcher.SubscribeCallback = () => {}
        let events = 0
        const pool = new WatcherSubscriptions((_dir, callback) => {
          native = callback
          started.resolve()
          return ready.promise
        })
        const fiber = yield* pool
          .watch(dir, [], "fs-events", () => events++)
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.forkScoped)
        yield* Effect.promise(() => started.promise)
        if (mode === "cancel") yield* Fiber.interrupt(fiber)
        if (mode === "timeout") {
          yield* TestClock.adjust("10 seconds")
          yield* Fiber.join(fiber)
        }
        native(null, [event])
        expect(events).toBe(0)
        yield* Scope.close(scope, Exit.void)
        ready.resolve({ unsubscribe: async () => stopped.resolve() })
        yield* Effect.promise(() => stopped.promise)
        native(null, [event])
        expect(events).toBe(0)
      }),
    )
  }

  it.live("waits for closing before reacquiring and does not remove a replacement entry", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const a = yield* owner()
      const b = yield* owner()
      const c = yield* owner()
      const closing = Promise.withResolvers<void>()
      const closed = Promise.withResolvers<void>()
      let starts = 0
      let stops = 0
      const pool = new WatcherSubscriptions(async () => {
        starts++
        return {
          unsubscribe: async () => {
            stops++
            if (stops !== 1) return
            closing.resolve()
            await closed.promise
          },
        }
      })
      yield* pool.watch(dir, [], "fs-events", () => {}).pipe(Effect.provideService(Scope.Scope, a))
      const release = yield* Scope.close(a, Exit.void).pipe(Effect.forkScoped)
      yield* Effect.promise(() => closing.promise)
      const acquire = yield* pool
        .watch(dir, [], "fs-events", () => {})
        .pipe(Effect.provideService(Scope.Scope, b), Effect.forkScoped)
      yield* tick()
      expect(starts).toBe(1)
      closed.resolve()
      yield* Fiber.join(release)
      yield* Fiber.join(acquire)
      yield* pool.watch(dir, [], "fs-events", () => {}).pipe(Effect.provideService(Scope.Scope, c))
      expect(starts).toBe(2)
      yield* Scope.close(b, Exit.void)
      expect(stops).toBe(1)
      yield* Scope.close(c, Exit.void)
      expect(stops).toBe(2)
    }),
  )

  it.live("separates backend and ignore identities and retries a failed subscribe", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      let starts = 0
      const pool = new WatcherSubscriptions(async () => {
        if (++starts === 1) throw new Error("subscription failed")
        return { unsubscribe: async () => {} }
      })
      yield* pool.watch(dir, [], "fs-events", () => {})
      yield* pool.watch(dir, [], "fs-events", () => {})
      yield* pool.watch(dir, ["ignored"], "fs-events", () => {})
      yield* pool.watch(dir, [], "inotify", () => {})
      yield* pool.watch(other, [], "fs-events", () => {})
      expect(starts).toBe(5)
    }),
  )

  it.live("does not replace a native subscription whose unsubscribe failed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const a = yield* owner()
      let starts = 0
      const pool = new WatcherSubscriptions(async () => {
        starts++
        return {
          unsubscribe: async () => {
            throw new Error("unsubscribe failed")
          },
        }
      })
      yield* pool.watch(dir, [], "fs-events", () => {}).pipe(Effect.provideService(Scope.Scope, a))
      yield* Scope.close(a, Exit.void)
      yield* pool.watch(dir, [], "fs-events", () => {})
      expect(starts).toBe(1)
    }),
  )
})

const describeNative = FileWatcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip
const backend = process.platform === "darwin" ? "fs-events" : process.platform === "win32" ? "windows" : "inotify"

// engine-runtime: [TP-R12-11]
describeNative("WatcherSubscriptions native lifecycle", () => {
  it.live("shares a physical directory and delivers real changes after one owner closes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const aliases = yield* tmpdirScoped()
      const alias = path.join(aliases, "linked")
      yield* Effect.promise(() => fs.symlink(dir, alias, "junction"))
      const a = yield* owner()
      const b = yield* owner()
      let starts = 0
      let stops = 0
      const pool = new WatcherSubscriptions(async (...args) => {
        starts++
        const subscription = await Native.subscribe(...args)
        return {
          unsubscribe: async () => {
            await subscription.unsubscribe()
            stops++
          },
        }
      })
      const first: string[] = []
      const second: string[] = []
      yield* Effect.all(
        [
          pool
            .watch(dir, [], backend, (_error, events) => first.push(...events.map((event) => event.path)))
            .pipe(Effect.provideService(Scope.Scope, a)),
          pool
            .watch(alias, [], backend, (_error, events) => second.push(...events.map((event) => event.path)))
            .pipe(Effect.provideService(Scope.Scope, b)),
        ],
        { concurrency: "unbounded" },
      )
      expect(starts).toBe(1)
      const wait = (predicate: () => boolean) =>
        Effect.gen(function* () {
          while (!predicate()) yield* Effect.sleep("10 millis")
        }).pipe(Effect.timeout("5 seconds"))
      const initial = path.join(dir, "initial.txt")
      yield* Effect.promise(() => fs.writeFile(initial, "both"))
      yield* wait(() => first.includes(initial) && second.includes(initial))
      yield* Scope.close(a, Exit.void)
      expect(stops).toBe(0)
      const later = path.join(dir, "later.txt")
      yield* Effect.promise(() => fs.writeFile(later, "second only"))
      yield* wait(() => second.includes(later))
      expect(first).not.toContain(later)
      yield* Scope.close(b, Exit.void)
      expect(stops).toBe(1)
      const c = yield* owner()
      yield* pool.watch(dir, [], backend, () => {}).pipe(Effect.provideService(Scope.Scope, c))
      expect(starts).toBe(2)
      yield* Scope.close(c, Exit.void)
      expect(stops).toBe(2)
    }),
  )
})
