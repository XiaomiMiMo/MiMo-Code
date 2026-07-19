import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import type { Permission as PermissionType } from "../../src/permission"

// Read lazily by the permission service at ask() time. Short timeout so the
// real-clock test resolves quickly.
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

describe("skip-all forced-ask timeout (real clock)", () => {
  test("auto-rejects a forced-ask after the timeout with actionable feedback", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          yield* perm.setSkipAll(true)

          const start = Date.now()
          const result = yield* perm.ask(buildRequest()).pipe(Effect.exit)
          const elapsed = Date.now() - start

          expect(result._tag).toBe("Failure")
          // Fired after the ~300ms timeout, not instantly.
          expect(elapsed).toBeGreaterThanOrEqual(250)
          const err = result._tag === "Failure" ? String(result.cause) : ""
          expect(err).toContain("auto-rejected")
          expect((yield* perm.list()).length).toBe(0)
        }).pipe(Effect.provide(env), Effect.runPromise),
    })
  }, 10000)

  test("no timeout when skip-all is off (stays pending)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          // skip-all off: ask must still be pending well past the timeout window.
          const fiber = yield* perm.ask(buildRequest()).pipe(Effect.exit, Effect.forkScoped)
          yield* Effect.promise(() => Bun.sleep(600))
          const pending = yield* perm.list()
          expect(pending.length).toBe(1)
          // Interrupt the still-blocked ask so the scope can close cleanly.
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(env), Effect.scoped, Effect.runPromise),
    })
  }, 10000)
})
