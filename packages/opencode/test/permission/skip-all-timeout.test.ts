import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import type { Permission as PermissionType } from "../../src/permission"

// Short timeout so the real-clock test resolves quickly.
process.env.MIMOCODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS = "300"

const { Bus } = await import("../../src/bus")
const CrossSpawnSpawner = await import("../../src/effect/cross-spawn-spawner")
const { Permission } = await import("../../src/permission")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Bus.layer)),
  Bus.layer,
  CrossSpawnSpawner.defaultLayer,
)

function buildRequest(extra?: Partial<Parameters<PermissionType.Interface["ask"]>[0]>) {
  return {
    permission: "bash_delete" as never,
    patterns: ["rm /tmp/some-file"],
    always: [],
    metadata: {},
    sessionID: "ses_test" as never,
    ruleset: [],
    tool: { messageID: "msg_test" as never, callID: "call_test" },
    ...extra,
  }
}

describe("permission ask timeout (real clock)", () => {
  test("env var MIMOCODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS sets initial timeout", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          // The env var is set at the top of this file (300ms).
          expect(yield* perm.permissionAskTimeout()).toBe(300)
        }).pipe(Effect.provide(env), Effect.runPromise),
    })
  }, 10000)

  test("auto-rejects after timeout even without skip-all", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          // skip-all is OFF, but timeout is set — timeout is orthogonal.
          yield* perm.setPermissionAskTimeout(300)

          const start = Date.now()
          const result = yield* perm.ask(buildRequest()).pipe(Effect.exit)
          const elapsed = Date.now() - start

          expect(result._tag).toBe("Failure")
          expect(elapsed).toBeGreaterThanOrEqual(250)
          const err = result._tag === "Failure" ? String(result.cause) : ""
          expect(err).toContain("auto-rejected")
          expect((yield* perm.list()).length).toBe(0)
        }).pipe(Effect.provide(env), Effect.runPromise),
    })
  }, 10000)

  test("timeout applies to normal asks (not just forced-ask)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          yield* perm.setPermissionAskTimeout(300)

          const start = Date.now()
          const result = yield* perm
            .ask(
              buildRequest({
                permission: "edit" as never,
                patterns: ["/some/path"],
              }),
            )
            .pipe(Effect.exit)
          const elapsed = Date.now() - start

          expect(result._tag).toBe("Failure")
          expect(elapsed).toBeGreaterThanOrEqual(250)
          const err = result._tag === "Failure" ? String(result.cause) : ""
          expect(err).toContain("auto-rejected")
        }).pipe(Effect.provide(env), Effect.runPromise),
    })
  }, 10000)

  test("no timeout when permissionAskTimeoutMs is null", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          // Explicitly clear the env-derived default.
          yield* perm.setPermissionAskTimeout(null)
          expect(yield* perm.permissionAskTimeout()).toBeNull()

          // ask must still be pending well past the old timeout window.
          const fiber = yield* perm.ask(buildRequest()).pipe(Effect.exit, Effect.forkScoped)
          yield* Effect.promise(() => Bun.sleep(600))
          const pending = yield* perm.list()
          expect(pending.length).toBe(1)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(env), Effect.scoped, Effect.runPromise),
    })
  }, 10000)

  test("skip-all + timeout: normal asks auto-allowed, forced-ask times out", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          yield* perm.setPermissionAskTimeout(300)
          yield* perm.setSkipAll(true)

          // Normal ask: auto-allowed by skip-all, never reaches timeout.
          const normalResult = yield* perm
            .ask(
              buildRequest({
                permission: "edit" as never,
                patterns: ["/some/path"],
              }),
            )
            .pipe(Effect.exit)
          expect(normalResult._tag).toBe("Success")

          // Forced-ask: skip-all doesn't cover it, timeout kicks in.
          const start = Date.now()
          const forcedResult = yield* perm.ask(buildRequest()).pipe(Effect.exit)
          const elapsed = Date.now() - start
          expect(forcedResult._tag).toBe("Failure")
          expect(elapsed).toBeGreaterThanOrEqual(250)
        }).pipe(Effect.provide(env), Effect.runPromise),
    })
  }, 10000)
})
