import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Flag } from "../../src/flag/flag"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

const originalDangerouslySkipPermissions = Flag.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS

beforeEach(() => {
  Flag.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS = false
})

afterEach(async () => {
  Flag.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS = originalDangerouslySkipPermissions
  await Instance.disposeAll()
})

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 100; i++) {
      const list = yield* permission.list()
      if (list.length === count) return list
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`))
  })

describe.serial("Permission auto-approve-delete runtime toggle", () => {
  it.live(
    "defaults to off so irreversible deletes keep asking",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        expect(yield* perm.autoApproveDelete()).toBe(false)
      }),
    ),
  )

  it.live(
    "enables delete approval bypass in dangerous startup mode",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        Flag.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS = true
        const perm = yield* Permission.Service
        expect(yield* perm.autoApproveDelete()).toBe(true)
      }),
    ),
  )

  it.live(
    "reflects the value it was set to",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setAutoApproveDelete(true)
        expect(yield* perm.autoApproveDelete()).toBe(true)
        // Must be two-way: leaving it on after the caller drops back to a stricter
        // approval mode would keep deletes silently approved.
        yield* perm.setAutoApproveDelete(false)
        expect(yield* perm.autoApproveDelete()).toBe(false)
      }),
    ),
  )

  it.live(
    "auto-approves bash_delete only after explicit deny rules are checked",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setAutoApproveDelete(true)
        const request = {
          sessionID: "ses_test" as never,
          permission: "bash_delete" as never,
          patterns: ["rm important"],
          metadata: {},
          always: [],
          interactive: false,
        }

        const allowed = yield* perm.ask({ ...request, ruleset: [] }).pipe(Effect.exit)
        expect(allowed._tag).toBe("Success")

        const denied = yield* perm
          .ask({
            ...request,
            ruleset: [{ permission: "bash_delete", pattern: "*", action: "deny" }],
          })
          .pipe(Effect.exit)
        expect(denied._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "is independent of skip-all in both directions",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        // skip-all deliberately does NOT cover forced-ask permissions, so turning
        // it on must not imply the delete exemption.
        yield* perm.setSkipAll(true)
        expect(yield* perm.autoApproveDelete()).toBe(false)
        // ...and trusting deletes must not silently turn on blanket auto-allow.
        yield* perm.setSkipAll(false)
        yield* perm.setAutoApproveDelete(true)
        expect(yield* perm.skipAll()).toBe(false)
      }),
    ),
  )

  // The reason this state is instance-scoped rather than a process-global (e.g. an
  // env var): one server process serves many directories, each with its own
  // permission state. A global carrier would let a permissive directory silently
  // auto-approve `rm -rf` / `git reset --hard` in a strict one — the exact opposite
  // of what a per-directory approval mode promises.
  it.live("does not leak across the directories one process serves", () =>
    Effect.gen(function* () {
      const permissive = yield* tmpdirScoped()
      const strict = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setAutoApproveDelete(true)
        expect(yield* perm.autoApproveDelete()).toBe(true)
      }).pipe(provideInstance(permissive))

      yield* Effect.gen(function* () {
        const perm = yield* Permission.Service
        expect(yield* perm.autoApproveDelete()).toBe(false)
      }).pipe(provideInstance(strict))

      // And the permissive one keeps its own value — isolation, not last-write-wins.
      yield* Effect.gen(function* () {
        const perm = yield* Permission.Service
        expect(yield* perm.autoApproveDelete()).toBe(true)
      }).pipe(provideInstance(permissive))
    }),
  )

  it.live(
    "leaves an already-pending delete ask for a human",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const fiber = yield* perm
          .ask({
            sessionID: "ses_test" as never,
            permission: "bash_delete" as never,
            patterns: ["rm -rf important"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.exit, Effect.forkScoped)

        // Let the ask register as pending before flipping the exemption.
        yield* waitForPending(1)
        yield* perm.setAutoApproveDelete(true)
        yield* Effect.sleep("50 millis")

        // Unlike setSkipAll, enabling this does NOT flush waiting asks: the command
        // already in flight is irreversible, so it still needs an explicit answer.
        const pending = yield* perm.list()
        expect(pending.some((r) => r.permission === "bash_delete")).toBe(true)

        yield* perm.reply({ requestID: pending[0]!.id, reply: "reject" })
        yield* Fiber.await(fiber)
      }),
    ),
  )
})
