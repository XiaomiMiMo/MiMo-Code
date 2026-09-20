import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session as SessionNs } from "../../src/session"
import { SessionID, MessageID } from "../../src/session/schema"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { TurnQueue } from "../../src/turn-queue"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Bus.layer,
  ActorRegistry.defaultLayer,
  TurnQueue.defaultLayer,
  ActorWaiter.layer.pipe(
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionNs.defaultLayer),
  ),
)

const it = testEffect(env)

describe("turn-queue + actor wait steer", () => {
  it.live(
    "user admit on main lane interrupts a blocking wait without cancelling the actor",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service
        const tq = yield* TurnQueue.Service

        const parent = yield* sessions.create({ title: "steer-wait" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "explore-9",
          mode: "subagent",
          agent: "explore",
          description: "long",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(parent.id, "explore-9", { status: "running" })

        const waitFiber = yield* waiter
          .wait({ sessionID: parent.id, actor_id: "explore-9", timeout_ms: 5000 })
          .pipe(Effect.forkChild)
        yield* Effect.sleep("30 millis")
        yield* tq.admit({
          lane: { sessionID: parent.id, agentID: "main" },
          intent: { kind: "prompt", messageID: MessageID.ascending() },
        })
        const snap = yield* Fiber.join(waitFiber)
        expect(snap.status).toBe("interrupted")
        expect(snap.actor_id).toBe("explore-9")
        expect((yield* registry.get(parent.id, "explore-9"))?.status).toBe("running")
      }),
    ),
  )

  it.live(
    "prompt intent settles to success after ack with MessageID frontier",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const parent = yield* sessions.create({ title: "settle" })
        const lane = { sessionID: parent.id, agentID: "main" }
        const mid = MessageID.ascending()
        const r = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: mid } })
        const claim = yield* tq.claimNext(lane, 42)
        expect(claim?.claimFrontier).toBe(mid)
        yield* tq.ack(lane, mid, [
          { receiptId: r.id, outcome: "success", messageId: MessageID.ascending() },
        ])
        const after = yield* tq.getReceipt(r.id)
        expect(after.state).toBe("settled")
        expect(after.outcome).toBe("success")
        expect(after.runId).toBe(42)
      }),
    ),
  )
})
