import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session as SessionNs } from "../../src/session"
import { MessageID } from "../../src/session/schema"
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
  TurnQueue.defaultLayer,
)

const it = testEffect(env)

describe("TurnQueue controller", () => {
  it.live(
    "admit prompt → claim → ack settles receipt and advances frontier",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "tq" })
        const lane = { sessionID: session.id, agentID: "main" }
        const mid = MessageID.ascending()
        const receipt = yield* tq.admit({
          lane,
          intent: { kind: "prompt", messageID: mid },
        })
        expect(receipt.state).toBe("accepted")
        expect(receipt.epoch).toBe(0)

        const claim = yield* tq.claimNext(lane, 1)
        expect(claim).toBeDefined()
        expect(claim!.receipts.map((r) => r.id)).toEqual([receipt.id])
        expect(claim!.claimFrontier).toBe(mid)

        yield* tq.ack(lane, mid, [{ receiptId: receipt.id, outcome: "success" }])
        const settled = yield* tq.getReceipt(receipt.id)
        expect(settled.state).toBe("settled")
        expect(settled.outcome).toBe("success")
        expect(settled.consumed).toBe(true)

        // Same message is not re-claimable after ack.
        const again = yield* tq.claimNext(lane, 2)
        expect(again).toBeUndefined()
      }),
    ),
  )

  it.live(
    "idempotency key returns the same receipt",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "idem" })
        const lane = { sessionID: session.id, agentID: "main" }
        const a = yield* tq.admit({
          lane,
          intent: { kind: "prompt", messageID: MessageID.ascending() },
          idempotencyKey: "k1",
        })
        const b = yield* tq.admit({
          lane,
          intent: { kind: "prompt", messageID: MessageID.ascending() },
          idempotencyKey: "k1",
        })
        expect(b.id).toBe(a.id)
      }),
    ),
  )

  it.live(
    "wake coalesces to max watermark; prompt does not coalesce",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "coalesce" })
        const lane = { sessionID: session.id, agentID: "main" }
        const w1 = yield* tq.admit({
          lane,
          intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "aaa" },
        })
        const w2 = yield* tq.admit({
          lane,
          intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "zzz" },
        })
        expect(w2.id).toBe(w1.id)
        expect((w2.intent as { inboxWatermark: string }).inboxWatermark).toBe("zzz")

        const p1 = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        const p2 = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        expect(p2.id).not.toBe(p1.id)
        expect((yield* tq.listAccepted(lane)).length).toBe(3) // 1 wake + 2 prompts
      }),
    ),
  )

  it.live(
    "abort cancels accepted; keep-suspended sets suspended not accepted",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "abort" })
        const lane = { sessionID: session.id, agentID: "main" }
        const r = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        const epoch = yield* tq.abortSession(session.id, "keep-suspended")
        expect(epoch).toBe(1)
        const after = yield* tq.getReceipt(r.id)
        expect(after.state).toBe("cancelled")
        expect(after.suspended).toBe(true)
        expect(after.outcome).toBe("never_ran")
        // Old-epoch work is not claimable.
        expect(yield* tq.claimNext(lane, 9)).toBeUndefined()
      }),
    ),
  )

  it.live(
    "observeInput resolves immediately when revision already advanced",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "steer" })
        const lane = { sessionID: session.id, agentID: "main" }
        yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        const rev = yield* tq.observeInput(lane, 0)
        expect(rev).toBeGreaterThan(0)
      }),
    ),
  )

  it.live(
    "observeInput waits then resolves when a later admit bumps revision",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "steer2" })
        const lane = { sessionID: session.id, agentID: "main" }
        const fiber = yield* tq.observeInput(lane, 0).pipe(Effect.forkChild)
        yield* Effect.sleep("20 millis")
        yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        const rev = yield* Fiber.join(fiber)
        expect(rev).toBeGreaterThan(0)
      }),
    ),
  )

  it.live(
    "reconcileOnBoot cancels claimed rows (process restart mid-claim)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "boot" })
        const lane = { sessionID: session.id, agentID: "main" }
        const r = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(lane, 1)
        yield* tq.reconcileOnBoot(session.id)
        const after = yield* tq.getReceipt(r.id)
        expect(after.state).toBe("cancelled")
        expect(after.outcome).toBe("never_ran")
      }),
    ),
  )

  it.live(
    "second admit for same live messageID returns the same receipt",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "dup-live" })
        const lane = { sessionID: session.id, agentID: "main" }
        const messageID = MessageID.ascending()
        const a = yield* tq.admit({ lane, intent: { kind: "prompt", messageID } })
        const b = yield* tq.admit({ lane, intent: { kind: "prompt", messageID } })
        expect(b.id).toBe(a.id)
        expect(b.state).toBe("accepted")
      }),
    ),
  )

  it.live(
    "idempotencyKey=messageID makes busy-path re-admit return the same receipt",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "idem-msg" })
        const lane = { sessionID: session.id, agentID: "main" }
        const messageID = MessageID.ascending()
        const a = yield* tq.admit({ lane, intent: { kind: "prompt", messageID }, idempotencyKey: messageID })
        const b = yield* tq.admit({ lane, intent: { kind: "prompt", messageID }, idempotencyKey: messageID })
        expect(b.id).toBe(a.id)
      }),
    ),
  )

  it.live(
    "re-admit after cancelled creates a new receipt for the same messageID",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "re-admit" })
        const lane = { sessionID: session.id, agentID: "main" }
        const messageID = MessageID.ascending()
        const first = yield* tq.admit({ lane, intent: { kind: "prompt", messageID } })
        yield* tq.abortSession(session.id, "drop")
        const second = yield* tq.admit({ lane, intent: { kind: "prompt", messageID } })
        expect(second.id).not.toBe(first.id)
        expect(second.state).toBe("accepted")
      }),
    ),
  )

  it.live(
    "observeInput resolves without gap when admit races subscribe",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "gap" })
        const lane = { sessionID: session.id, agentID: "main" }
        // Start observe, then admit immediately (no sleep) to stress check-subscribe-recheck.
        const fiber = yield* tq.observeInput(lane, 0).pipe(Effect.forkChild)
        yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        const rev = yield* Fiber.join(fiber)
        expect(rev).toBeGreaterThan(0)
      }),
    ),
  )
})
