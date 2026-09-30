import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
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

// A request that genuinely needs ask: empty ruleset → evaluate falls through to "ask".
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

describe("Permission.ask interactive flag", () => {
  it.live(
    "interactive:false denies immediately and publishes no Asked event",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm.ask(buildRequest({ interactive: false })).pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Failure")
        expect(asked).toBe(0)
        // pending must be empty — nothing left awaiting a reply
        const pending = yield* perm.list()
        expect(pending.length).toBe(0)
      }),
    ),
  )
})
