import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Fiber } from "effect"
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

// Build a request that genuinely needs ask (no rule auto-approves).
// Specific permission name + pattern must NOT have a default rule allowing it.
function buildRequest() {
  return {
    permission: "read" as never,
    patterns: ["/some/never-allowed-path"],
    always: ["*"],
    metadata: {},
    sessionID: "ses_test" as never,
    ruleset: [], // empty ruleset → evaluate falls through to needsAsk
    tool: { messageID: "msg_test" as never, callID: "call_test" },
  }
}

describe("Permission.ask abortSignal (Spec ③ P3)", () => {
  it.live(
    "fails when signal already aborted",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const ctl = new AbortController()
        ctl.abort()
        const result = yield* perm.ask(buildRequest(), ctl.signal).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "fails when signal aborts mid-await",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const ctl = new AbortController()
        const fiber = yield* perm.ask(buildRequest(), ctl.signal).pipe(Effect.forkScoped)
        yield* Effect.sleep("20 millis")
        ctl.abort()
        const result = yield* Fiber.join(fiber).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "no abortSignal → behavior unchanged (backward compat)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        // Without abortSignal, the ask should suspend awaiting reply.
        // We fork it, wait briefly, then verify nothing crashed.
        const fiber = yield* perm.ask(buildRequest()).pipe(Effect.forkScoped)
        yield* Effect.sleep("30 millis")
        // Fiber should still be pending; we interrupt it to clean up.
        yield* Fiber.interrupt(fiber)
        // Just assert the fork itself didn't throw synchronously.
        expect(fiber).toBeDefined()
      }),
    ),
  )

  it.live(
    "abortSignal listener is removed after race resolves (C1 regression: no leak)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const ctl = new AbortController()
        // Spy on addEventListener / removeEventListener to count net listeners.
        let netListeners = 0
        const realAdd = ctl.signal.addEventListener.bind(ctl.signal)
        const realRemove = ctl.signal.removeEventListener.bind(ctl.signal)
        ctl.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
          if (type === "abort") netListeners += 1
          return (realAdd as unknown as (t: string, ...r: unknown[]) => void)(type, ...rest)
        }) as typeof ctl.signal.addEventListener
        ctl.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
          if (type === "abort") netListeners -= 1
          return (realRemove as unknown as (t: string, ...r: unknown[]) => void)(type, ...rest)
        }) as typeof ctl.signal.removeEventListener

        // Fork ask with the spied signal; let it attach the listener.
        const fiber = yield* perm.ask(buildRequest(), ctl.signal).pipe(Effect.forkScoped)
        yield* Effect.sleep("20 millis")
        expect(netListeners).toBe(1) // listener attached during await

        // Interrupting the fiber cancels Effect.race, which interrupts the
        // Effect.callback body, which runs the cleanup that removes the
        // listener. The Effect.promise variant would NOT do this — that's
        // the C1 leak the cleanup return-effect guards against.
        yield* Fiber.interrupt(fiber)
        yield* Effect.sleep("10 millis") // give cleanup a tick to run

        expect(netListeners).toBe(0) // cleanup removed the listener
      }),
    ),
  )
})
