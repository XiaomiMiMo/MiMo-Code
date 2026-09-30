import { afterEach, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, ManagedRuntime, Context } from "effect"
import { InstanceState } from "../../src/effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { Bus } from "../../src/bus"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { testEffect } from "../lib/effect"
import "../../src/server/projectors"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

async function access<A, E>(state: InstanceState.InstanceState<A, E>, dir: string) {
  return Instance.provide({
    directory: dir,
    fn: () => Effect.runPromise(InstanceState.get(state)),
  })
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("InstanceState.bind prefers the fiber instance over another ALS instance", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()
  const correct = await Instance.provide({ directory: one.path, fn: () => Instance.current })
  const wrong = await Instance.provide({ directory: two.path, fn: () => Instance.current })
  const bound = Instance.restore(wrong, () =>
    Effect.runSync(
      Effect.sync(() => InstanceState.bind((suffix: string) => `${Instance.directory}/${suffix}`)).pipe(
        Effect.provideService(InstanceRef, correct),
      ),
    ),
  )

  expect(Instance.restore(wrong, () => bound("result"))).toBe(`${one.path}/result`)
  expect(bound("later")).toBe(`${one.path}/later`)
})

test("InstanceState.bind captures ALS when the fiber has no instance ref", async () => {
  await using tmp = await tmpdir()
  const bound = await Instance.provide({
    directory: tmp.path,
    fn: () => Effect.runSync(Effect.sync(() => InstanceState.bind(() => Instance.directory))),
  })
  expect(bound()).toBe(tmp.path)
})

test("InstanceState.bind captures the fiber instance without ALS", async () => {
  await using tmp = await tmpdir()
  const correct = await Instance.provide({ directory: tmp.path, fn: () => Instance.current })
  const bound = Effect.runSync(
    Effect.sync(() => InstanceState.bind(() => Instance.directory)).pipe(
      Effect.provideService(InstanceRef, correct),
    ),
  )
  expect(bound()).toBe(tmp.path)
})

test("InstanceState.bind preserves the function without either context", () => {
  const fn = (value: number) => value + 1
  expect(InstanceState.bind(fn)).toBe(fn)
  expect(Effect.runSync(Effect.sync(() => InstanceState.bind(fn)))).toBe(fn)
  expect(fn(2)).toBe(3)
})

it.live("SyncEvent routes message and part updates to the fiber instance despite another ALS instance", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const wrong = yield* InstanceState.context
      yield* provideTmpdirInstance((directory) =>
        Effect.gen(function* () {
          const correct = yield* InstanceState.context
          const session = yield* Session.Service
          const created = yield* session.create()
          const message: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: created.id,
            agentID: "main",
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          }
          const part: MessageV2.TextPart = {
            id: PartID.ascending(),
            messageID: message.id,
            sessionID: created.id,
            type: "text",
            text: "cross-instance message",
          }
          const routed: { directory: string; type: string }[] = []
          const global: { directory: string | undefined; type: string }[] = []
          const localDone = yield* Deferred.make<void>()
          const globalDone = yield* Deferred.make<void>()
          for (const instance of [wrong, correct]) {
            yield* Effect.acquireRelease(
              Effect.sync(() => Instance.restore(instance, () => Bus.subscribeAll((event) => {
                if (event.properties?.sessionID !== created.id) return
                if (!["message.updated", "message.part.updated"].includes(event.type)) return
                routed.push({ directory: instance.directory, type: event.type })
                if (routed.length === 2) Deferred.doneUnsafe(localDone, Effect.void)
              }))),
              (unsubscribe) => Effect.sync(unsubscribe),
            )
          }
          const onGlobal = (event: GlobalEvent) => {
            const payload = event.payload
            if (payload.type === "sync") {
              if (payload.syncEvent.aggregateID !== created.id) return
              if (!["message.updated.1", "message.part.updated.1"].includes(payload.syncEvent.type)) return
            } else {
              if (payload.properties?.sessionID !== created.id) return
              if (!["message.updated", "message.part.updated"].includes(payload.type)) return
            }
            global.push({ directory: event.directory, type: payload.type })
            if (global.length === 4) Deferred.doneUnsafe(globalDone, Effect.void)
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => GlobalBus.on("event", onGlobal)),
            () => Effect.sync(() => { GlobalBus.off("event", onGlobal) }),
          )

          yield* Effect.sync(() => Instance.restore(wrong, () => Effect.runSync(
            Effect.gen(function* () {
              yield* session.updateMessage(message)
              yield* session.updatePart(part)
            }).pipe(Effect.provideService(InstanceRef, correct)),
          )))
          yield* Deferred.await(localDone).pipe(Effect.timeout("2 seconds"))
          yield* Deferred.await(globalDone).pipe(Effect.timeout("2 seconds"))

          expect(MessageV2.get({ sessionID: created.id, messageID: message.id })).toEqual({ info: message, parts: [part] })
          expect(routed).toEqual([
            { directory, type: "message.updated" },
            { directory, type: "message.part.updated" },
          ])
          expect(global.map((event) => event.directory)).toEqual(Array(4).fill(directory))
          expect(global.map((event) => event.type).sort()).toEqual([
            "message.part.updated", "message.updated", "sync", "sync",
          ])
        }),
      )
    }),
  ),
)

it.live("InstanceState.bind captures Fiber context ahead of conflicting ALS for deferred callbacks", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const owner = yield* Effect.promise(() => Instance.provide({ directory: one, fn: () => Instance.current }))
    const stale = yield* Effect.promise(() => Instance.provide({ directory: two, fn: () => Instance.current }))
    const bound = yield* Effect.gen(function* () {
      expect(yield* InstanceState.context).toBe(owner)
      return Instance.restore(stale, () => {
        expect(Instance.current).toBe(stale)
        return InstanceState.bind(async (value: string) => {
          await Promise.resolve()
          return { context: Instance.current, value }
        })
      })
    }).pipe(Effect.provideService(InstanceRef, owner))

    const result = yield* Effect.promise(() =>
      Instance.restore(stale, () => {
        const pending = bound("deferred")
        expect(Instance.current).toBe(stale)
        return pending
      }),
    )
    expect(result).toEqual({ context: owner, value: "deferred" })
  }),
)

it.live("InstanceState.bind falls back to ALS when the Fiber has no InstanceRef", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const owner = yield* Effect.promise(() => Instance.provide({ directory: dir, fn: () => Instance.current }))
    const bound = Instance.restore(owner, () => InstanceState.bind(() => Instance.current))
    expect(bound()).toBe(owner)
  }),
)

it.live("InstanceState.bind captures Fiber context without ALS", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const owner = yield* Effect.promise(() => Instance.provide({ directory: dir, fn: () => Instance.current }))
    const bound = yield* Effect.sync(() => {
      expect(() => Instance.current).toThrow()
      return InstanceState.bind(() => Instance.current)
    }).pipe(Effect.provideService(InstanceRef, owner))
    expect(bound()).toBe(owner)
  }),
)

test("InstanceState.bind captures ALS outside an Effect Fiber", async () => {
  await using tmp = await tmpdir()
  const { owner, bound } = await Instance.provide({
    directory: tmp.path,
    fn: () => ({ owner: Instance.current, bound: InstanceState.bind(() => Instance.current) }),
  })
  expect(bound()).toBe(owner)
})

test("InstanceState.bind preserves callbacks without any instance context", () => {
  const fn = (value: string) => value
  expect(InstanceState.bind(fn)).toBe(fn)
  expect(InstanceState.bind(fn)("unbound")).toBe("unbound")
})

test("InstanceState caches values per directory", async () => {
  await using tmp = await tmpdir()
  let n = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* InstanceState.make(() => Effect.sync(() => ({ n: ++n })))

        const a = yield* Effect.promise(() => access(state, tmp.path))
        const b = yield* Effect.promise(() => access(state, tmp.path))

        expect(a).toBe(b)
        expect(n).toBe(1)
      }),
    ),
  )
})

test("InstanceState isolates directories", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()
  let n = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* InstanceState.make((dir) => Effect.sync(() => ({ dir, n: ++n })))

        const a = yield* Effect.promise(() => access(state, one.path))
        const b = yield* Effect.promise(() => access(state, two.path))
        const c = yield* Effect.promise(() => access(state, one.path))

        expect(a).toBe(c)
        expect(a).not.toBe(b)
        expect(n).toBe(2)
      }),
    ),
  )
})

test("InstanceState invalidates on reload", async () => {
  await using tmp = await tmpdir()
  const seen: string[] = []
  let n = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* InstanceState.make(() =>
          Effect.acquireRelease(
            Effect.sync(() => ({ n: ++n })),
            (value) =>
              Effect.sync(() => {
                seen.push(String(value.n))
              }),
          ),
        )

        const a = yield* Effect.promise(() => access(state, tmp.path))
        yield* Effect.promise(() => Instance.reload({ directory: tmp.path }))
        const b = yield* Effect.promise(() => access(state, tmp.path))

        expect(a).not.toBe(b)
        expect(seen).toEqual(["1"])
      }),
    ),
  )
})

test("InstanceState invalidates on disposeAll", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()
  const seen: string[] = []

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* InstanceState.make((ctx) =>
          Effect.acquireRelease(
            Effect.sync(() => ({ dir: ctx.directory })),
            (value) =>
              Effect.sync(() => {
                seen.push(value.dir)
              }),
          ),
        )

        yield* Effect.promise(() => access(state, one.path))
        yield* Effect.promise(() => access(state, two.path))
        yield* Effect.promise(() => Instance.disposeAll())

        expect(seen.sort()).toEqual([one.path, two.path].sort())
      }),
    ),
  )
})

test("InstanceState.get reads the current directory lazily", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()

  interface Api {
    readonly get: () => Effect.Effect<string>
  }

  class Test extends Context.Service<Test, Api>()("@test/InstanceStateLazy") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))
        const get = InstanceState.get(state)

        return Test.of({
          get: Effect.fn("Test.get")(function* () {
            return yield* get
          }),
        })
      }),
    )
  }

  const rt = ManagedRuntime.make(Test.layer)

  try {
    const a = await Instance.provide({
      directory: one.path,
      fn: () => rt.runPromise(Test.use((svc) => svc.get())),
    })
    const b = await Instance.provide({
      directory: two.path,
      fn: () => rt.runPromise(Test.use((svc) => svc.get())),
    })

    expect(a).toBe(one.path)
    expect(b).toBe(two.path)
  } finally {
    await rt.dispose()
  }
})

test("InstanceState preserves directory across async boundaries", async () => {
  await using one = await tmpdir({ git: true })
  await using two = await tmpdir({ git: true })
  await using three = await tmpdir({ git: true })

  interface Api {
    readonly get: () => Effect.Effect<{ directory: string; worktree: string; project: string }>
  }

  class Test extends Context.Service<Test, Api>()("@test/InstanceStateAsync") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        const state = yield* InstanceState.make((ctx) =>
          Effect.sync(() => ({
            directory: ctx.directory,
            worktree: ctx.worktree,
            project: ctx.project.id,
          })),
        )

        return Test.of({
          get: Effect.fn("Test.get")(function* () {
            yield* Effect.promise(() => Bun.sleep(1))
            yield* Effect.sleep(Duration.millis(1))
            for (let i = 0; i < 100; i++) {
              yield* Effect.yieldNow
            }
            for (let i = 0; i < 100; i++) {
              yield* Effect.promise(() => Promise.resolve())
            }
            yield* Effect.sleep(Duration.millis(2))
            yield* Effect.promise(() => Bun.sleep(1))
            return yield* InstanceState.get(state)
          }),
        })
      }),
    )
  }

  const rt = ManagedRuntime.make(Test.layer)

  try {
    const [a, b, c] = await Promise.all([
      Instance.provide({
        directory: one.path,
        fn: () => rt.runPromise(Test.use((svc) => svc.get())),
      }),
      Instance.provide({
        directory: two.path,
        fn: () => rt.runPromise(Test.use((svc) => svc.get())),
      }),
      Instance.provide({
        directory: three.path,
        fn: () => rt.runPromise(Test.use((svc) => svc.get())),
      }),
    ])

    expect(a).toEqual({ directory: one.path, worktree: one.path, project: a.project })
    expect(b).toEqual({ directory: two.path, worktree: two.path, project: b.project })
    expect(c).toEqual({ directory: three.path, worktree: three.path, project: c.project })
    expect(a.project).not.toBe(b.project)
    expect(a.project).not.toBe(c.project)
    expect(b.project).not.toBe(c.project)
  } finally {
    await rt.dispose()
  }
})

test("InstanceState survives high-contention concurrent access", async () => {
  const N = 20
  const dirs = await Promise.all(Array.from({ length: N }, () => tmpdir()))

  interface Api {
    readonly get: () => Effect.Effect<string>
  }

  class Test extends Context.Service<Test, Api>()("@test/HighContention") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

        return Test.of({
          get: Effect.fn("Test.get")(function* () {
            // Interleave many async hops to maximize chance of ALS corruption
            for (let i = 0; i < 10; i++) {
              yield* Effect.promise(() => Bun.sleep(Math.random() * 3))
              yield* Effect.yieldNow
              yield* Effect.promise(() => Promise.resolve())
            }
            return yield* InstanceState.get(state)
          }),
        })
      }),
    )
  }

  const rt = ManagedRuntime.make(Test.layer)

  try {
    const results = await Promise.all(
      dirs.map((d) =>
        Instance.provide({
          directory: d.path,
          fn: () => rt.runPromise(Test.use((svc) => svc.get())),
        }),
      ),
    )

    for (let i = 0; i < N; i++) {
      expect(results[i]).toBe(dirs[i].path)
    }
  } finally {
    await rt.dispose()
    for (const d of dirs) await d[Symbol.asyncDispose]()
  }
})

test("InstanceState correct after interleaved init and dispose", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()

  interface Api {
    readonly get: () => Effect.Effect<string>
  }

  class Test extends Context.Service<Test, Api>()("@test/InterleavedDispose") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        const state = yield* InstanceState.make((ctx) =>
          Effect.promise(async () => {
            await Bun.sleep(5) // slow init
            return ctx.directory
          }),
        )

        return Test.of({
          get: Effect.fn("Test.get")(function* () {
            return yield* InstanceState.get(state)
          }),
        })
      }),
    )
  }

  const rt = ManagedRuntime.make(Test.layer)

  try {
    // Init both directories
    const a = await Instance.provide({
      directory: one.path,
      fn: () => rt.runPromise(Test.use((svc) => svc.get())),
    })
    expect(a).toBe(one.path)

    // Dispose one directory, access the other concurrently
    const [, b] = await Promise.all([
      Instance.reload({ directory: one.path }),
      Instance.provide({
        directory: two.path,
        fn: () => rt.runPromise(Test.use((svc) => svc.get())),
      }),
    ])
    expect(b).toBe(two.path)

    // Re-access disposed directory - should get fresh state
    const c = await Instance.provide({
      directory: one.path,
      fn: () => rt.runPromise(Test.use((svc) => svc.get())),
    })
    expect(c).toBe(one.path)
  } finally {
    await rt.dispose()
  }
})

test("InstanceState mutation in one directory does not leak to another", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* InstanceState.make(() => Effect.sync(() => ({ count: 0 })))

        // Mutate state in directory one
        const s1 = yield* Effect.promise(() => access(state, one.path))
        s1.count = 42

        // Access directory two — should be independent
        const s2 = yield* Effect.promise(() => access(state, two.path))
        expect(s2.count).toBe(0)

        // Confirm directory one still has the mutation
        const s1again = yield* Effect.promise(() => access(state, one.path))
        expect(s1again.count).toBe(42)
        expect(s1again).toBe(s1) // same reference
      }),
    ),
  )
})

test("InstanceState dedupes concurrent lookups", async () => {
  await using tmp = await tmpdir()
  let n = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* InstanceState.make(() =>
          Effect.promise(async () => {
            n += 1
            await Bun.sleep(10)
            return { n }
          }),
        )

        const [a, b] = yield* Effect.promise(() => Promise.all([access(state, tmp.path), access(state, tmp.path)]))
        expect(a).toBe(b)
        expect(n).toBe(1)
      }),
    ),
  )
})

test("InstanceState survives deferred resume from the same instance context", async () => {
  await using tmp = await tmpdir({ git: true })

  interface Api {
    readonly get: (gate: Deferred.Deferred<void>) => Effect.Effect<string>
  }

  class Test extends Context.Service<Test, Api>()("@test/DeferredResume") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

        return Test.of({
          get: Effect.fn("Test.get")(function* (gate: Deferred.Deferred<void>) {
            yield* Deferred.await(gate)
            return yield* InstanceState.get(state)
          }),
        })
      }),
    )
  }

  const rt = ManagedRuntime.make(Test.layer)

  try {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const fiber = await Instance.provide({
      directory: tmp.path,
      fn: () => Promise.resolve(rt.runFork(Test.use((svc) => svc.get(gate)))),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () => Effect.runPromise(Deferred.succeed(gate, void 0)),
    })
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(tmp.path)
    }
  } finally {
    await rt.dispose()
  }
})

test("InstanceState survives deferred resume outside ALS when InstanceRef is set", async () => {
  await using tmp = await tmpdir({ git: true })

  interface Api {
    readonly get: (gate: Deferred.Deferred<void>) => Effect.Effect<string>
  }

  class Test extends Context.Service<Test, Api>()("@test/DeferredResumeOutside") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

        return Test.of({
          get: Effect.fn("Test.get")(function* (gate: Deferred.Deferred<void>) {
            yield* Deferred.await(gate)
            return yield* InstanceState.get(state)
          }),
        })
      }),
    )
  }

  const rt = ManagedRuntime.make(Test.layer)

  try {
    const gate = await Effect.runPromise(Deferred.make<void>())
    // Provide InstanceRef so the fiber carries the context even when
    // the deferred is resolved from outside Instance.provide ALS.
    const fiber = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Promise.resolve(
          rt.runFork(Test.use((svc) => svc.get(gate)).pipe(Effect.provideService(InstanceRef, Instance.current))),
        ),
    })

    // Resume from outside any Instance.provide — ALS is NOT set here
    await Effect.runPromise(Deferred.succeed(gate, void 0))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(tmp.path)
    }
  } finally {
    await rt.dispose()
  }
})
