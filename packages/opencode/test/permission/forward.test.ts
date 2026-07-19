import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Fiber } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { forwardRef } from "../../src/permission/permission-forward-ref"
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
    sessionID: "ses_child" as never,
    ruleset: [],
    tool: { messageID: "msg_test" as never, callID: "call_test" },
    ...extra,
  }
}

describe("Permission.ask forward mode", () => {
  it.live(
    "a delegation grant for the child auto-resolves allow without a human",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        forwardRef.setGrant("ses_parent", "ses_child")
        const perm = yield* Permission.Service
        // With a grant, the forwarded ask resolves (allow) immediately — no hang.
        const result = yield* perm
          .ask(buildRequest({ forward: { parentSessionID: "ses_parent" } }))
          .pipe(Effect.exit)
        expect(result._tag).toBe("Success")
        forwardRef.clearGrantsForParent("ses_parent")
      }),
    ),
  )

  it.live(
    "an 'all' grant auto-resolves any child of that parent",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        forwardRef.setGrant("ses_parent2", "*")
        const perm = yield* Permission.Service
        const result = yield* perm
          .ask(buildRequest({ sessionID: "ses_whatever" as never, forward: { parentSessionID: "ses_parent2" } }))
          .pipe(Effect.exit)
        expect(result._tag).toBe("Success")
        forwardRef.clearGrantsForParent("ses_parent2")
      }),
    ),
  )

  it.live(
    "without a grant, the forward is recorded pending and a reply resolves+clears it (dedup)",
    provideTmpdirInstance(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          // Run the forwarded ask in the background (it would otherwise wait for a
          // reply / the deny-timeout). Give it a tick to register the pending row.
          const fiber = yield* perm
            .ask(buildRequest({ forward: { parentSessionID: "ses_parent3" } }))
            .pipe(Effect.forkScoped)
          yield* Effect.sleep("50 millis")
          const rec = forwardRef.findPendingByChild("ses_child")
          expect(rec?.requestID).toBeDefined()
          // Resolve it as if the user/orchestrator approved (the single convergent path).
          yield* perm.reply({ requestID: rec!.requestID as never, reply: "once" })
          const result = yield* Fiber.await(fiber)
          expect(result._tag).toBe("Success")
          // Dedup: the pending forward record is cleared (finalizer removePending).
          expect(forwardRef.findPendingByChild("ses_child")).toBeUndefined()
        }),
      ),
    ),
  )
})
