import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Storage } from "../../src/storage"
import { Snapshot } from "../../src/snapshot"
import { Session as SessionNs } from "../../src/session"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

// Snapshot stub records every (from, to) pair diffFull is called with.
// summarize feeds it the from/to anchors derived from step-start /
// step-finish parts in `all`. If summarize ever pulls a non-main slice,
// the captured anchors include subagent snapshot ids — which is exactly
// the regression we want to catch.
const captured: Array<{ from: string; to: string }> = []

const snapshotStub = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    init: () => Effect.void,
    cleanup: () => Effect.void,
    track: () => Effect.succeed(undefined),
    patch: () => Effect.succeed({ hash: "", files: [] }),
    restore: () => Effect.void,
    revert: () => Effect.void,
    diff: () => Effect.succeed(""),
    diffFull: (from, to) =>
      Effect.sync(() => {
        captured.push({ from, to })
        return []
      }),
  }),
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionSummary.layer.pipe(
    Layer.provide(SessionNs.defaultLayer),
    Layer.provide(snapshotStub),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

const it = testEffect(env)

describe("SessionSummary.summarize main-slice contract", () => {
  it.live(
    "computeDiff anchors come only from main-slice step-finish parts",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        captured.length = 0

        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        // Main user → main asst (step-start "snap-main-from", step-finish "snap-main-to").
        const userID = MessageID.ascending()
        yield* ssn.updateMessage({
          id: userID,
          role: "user" as const,
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: userID,
          sessionID: info.id,
          type: "text",
          text: "do thing",
        })
        const mainAsstID = MessageID.ascending()
        yield* ssn.updateMessage({
          id: mainAsstID,
          role: "assistant" as const,
          sessionID: info.id,
          agentID: "main",
          agent: "build",
          mode: "primary",
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: userID,
          time: { created: Date.now() + 1, completed: Date.now() + 2 },
          finish: "end_turn",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          path: { cwd: "/", root: "/" },
          cost: 0,
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: mainAsstID,
          sessionID: info.id,
          type: "step-start",
          snapshot: "snap-main-from",
        } as never)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: mainAsstID,
          sessionID: info.id,
          type: "step-finish",
          snapshot: "snap-main-to",
        } as never)

        // Subagent on the SAME sessionID with its own step-finish anchor.
        // Under the buggy unfiltered path, this snapshot ID would land in
        // `to` and become the captured `diffFull` argument.
        const subUserID = MessageID.ascending()
        yield* ssn.updateMessage({
          id: subUserID,
          role: "user" as const,
          sessionID: info.id,
          agentID: "explore-1",
          agent: "explore",
          model: ref,
          time: { created: Date.now() + 3 },
        })
        const subAsstID = MessageID.ascending()
        yield* ssn.updateMessage({
          id: subAsstID,
          role: "assistant" as const,
          sessionID: info.id,
          agentID: "explore-1",
          agent: "explore",
          mode: "default",
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: subUserID,
          time: { created: Date.now() + 4, completed: Date.now() + 5 },
          finish: "end_turn",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          path: { cwd: "/", root: "/" },
          cost: 0,
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: subAsstID,
          sessionID: info.id,
          type: "step-finish",
          snapshot: "snap-sub-to",
        } as never)

        const summary = yield* SessionSummary.Service
        yield* summary.summarize({ sessionID: info.id, messageID: userID })

        // Every captured (from, to) anchor must come from the MAIN slice.
        // Under the buggy unfiltered path, `to` would advance to "snap-sub-to"
        // because the subagent's step-finish appears later in wall-clock order.
        for (const call of captured) {
          expect(call.from).toBe("snap-main-from")
          expect(call.to).toBe("snap-main-to")
          expect(call.to).not.toBe("snap-sub-to")
        }
        // At least one diffFull call should have happened (session-level diff).
        expect(captured.length).toBeGreaterThan(0)
      }),
    ),
  )
})
