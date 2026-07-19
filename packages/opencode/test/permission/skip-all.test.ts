import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

function buildRequest(extra?: Partial<Parameters<Permission.Interface["ask"]>[0]>) {
  return {
    permission: "edit" as never,
    patterns: ["/some/never-allowed-path"],
    always: ["*"],
    metadata: {},
    sessionID: "ses_test" as never,
    ruleset: [],
    tool: { messageID: "msg_test" as never, callID: "call_test" },
    ...extra,
  }
}

describe("Permission skip-all runtime toggle", () => {
  it.live(
    "defaults to off",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        expect(yield* perm.skipAll()).toBe(false)
      }),
    ),
  )

  it.live(
    "auto-allows an ask that would otherwise block",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setSkipAll(true)
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm.ask(buildRequest()).pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Success")
        expect(asked).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "explicit deny rules still win over skip-all",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setSkipAll(true)
        const result = yield* perm
          .ask(buildRequest({ ruleset: [{ permission: "edit", pattern: "*", action: "deny" }] }))
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "forced-ask permissions (bash_delete) still block under skip-all",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setSkipAll(true)
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        // interactive:false so the forced ask fails fast instead of blocking the test.
        const result = yield* perm
          .ask(buildRequest({ permission: "bash_delete" as never, interactive: false }))
          .pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "enabling skip-all flushes pending non-forced asks",
    provideTmpdirInstance(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          // Run a blocking ask in the background, wait for it to register.
          const fiber = yield* perm.ask(buildRequest()).pipe(Effect.forkScoped)
          while ((yield* perm.list()).length === 0) {
            yield* Effect.promise(() => Bun.sleep(10))
          }

          yield* perm.setSkipAll(true)
          const result = yield* Fiber.await(fiber)
          expect(result._tag).toBe("Success")
          expect((yield* perm.list()).length).toBe(0)
        }),
      ),
    ),
  )

  it.live(
    "disabling skip-all restores blocking behavior",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setSkipAll(true)
        yield* perm.setSkipAll(false)
        // interactive:false fails fast when it reaches the ask path — proving
        // the request was NOT auto-allowed.
        const result = yield* perm.ask(buildRequest({ interactive: false })).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )
})
