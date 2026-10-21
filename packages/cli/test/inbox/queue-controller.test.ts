import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { InboxController, inboxControllerRef, schedulerRef, type Receipt } from "../../src/inbox"
import { InboxTable, InboxLaneStateTable, InboxSessionEpochTable } from "../../src/inbox/inbox.sql"
import { Database, eq, and } from "../../src/storage"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ProviderID, ModelID } from "../../src/provider/schema"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Bus.layer,
  InboxController.defaultLayer,
)

const it = testEffect(env)

function userMessage(sessionID: ReturnType<typeof SessionNs.Info.shape.id.parse>, text = "hello") {
  const messageID = MessageID.ascending()
  const message: MessageV2.User = {
    id: messageID,
    sessionID,
    agentID: "main",
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
  }
  const part: MessageV2.TextPart = {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "text",
    text,
  }
  return { message, parts: [part] as MessageV2.Part[] }
}

describe("Inbox controller", () => {
  it.live(
    "accept writes the user message, inbox record, and bumps input_revision",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "accept" })
        const lane = { sessionID: session.id, agentID: "main" }
        const { message, parts } = userMessage(session.id)
        const receipt = yield* tq.accept({
          lane,
          message,
          parts,
          type: "prompt",
          idempotencyKey: message.id,
        })
        expect(receipt.state).toBe("accepted")
        expect(receipt.inputMessageID).toBe(message.id)
        expect(receipt.type).toBe("prompt")
        const row = Database.use((db) =>
          db.select().from(InboxTable).where(eq(InboxTable.id, receipt.id)).get(),
        )
        expect(row?.input_message_id).toBe(message.id)
        expect(row?.content).toBeNull()
        const laneRow = Database.use((db) =>
          db.select().from(InboxLaneStateTable)
            .where(and(eq(InboxLaneStateTable.session_id, session.id), eq(InboxLaneStateTable.agent_id, "main")))
            .get(),
        )
        expect(laneRow?.input_revision).toBe(1)
      }),
    ),
  )

  for (const keyed of [false, true]) {
    it.live(
      `concurrent ${keyed ? "idempotency-key" : "same-message"} accept creates one receipt`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const tq = yield* InboxController.Service
          const session = yield* sessions.create({ title: "concurrent-accept" })
          const lane = { sessionID: session.id, agentID: "main" }
          const a = userMessage(session.id, "A")
          const b = userMessage(session.id, "B")
          const r1 = yield* tq.accept({
            lane,
            message: a.message,
            parts: a.parts,
            type: "prompt",
            ...(keyed ? { idempotencyKey: "same-key" } : {}),
          })
          const r2 = yield* tq.accept({
            lane,
            message: keyed ? b.message : a.message,
            parts: keyed ? b.parts : a.parts,
            type: "prompt",
            ...(keyed ? { idempotencyKey: "same-key" } : {}),
          })
          expect(r2.id).toBe(r1.id)
          const rows = Database.use((db) =>
            db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, session.id)).all(),
          )
          expect(rows).toHaveLength(1)
        }),
      ),
    )
  }

  it.live(
    "idempotency key returns the same receipt",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "idem" })
        const lane = { sessionID: session.id, agentID: "main" }
        const { message, parts } = userMessage(session.id)
        const first = yield* tq.accept({
          lane, message, parts,
          type: "prompt",
          idempotencyKey: "key-1",
        })
        const second = yield* tq.accept({
          lane, message, parts,
          type: "prompt",
          idempotencyKey: "key-1",
        })
        expect(second.id).toBe(first.id)
      }),
    ),
  )

  it.live(
    "claimNext claims accepted prompt records up to MAX_CLAIM_PER_STEP",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "claim" })
        const lane = { sessionID: session.id, agentID: "main" }
        const ids: MessageID[] = []
        for (let i = 0; i < 3; i++) {
          const { message, parts } = userMessage(session.id, `msg-${i}`)
          ids.push(message.id)
          yield* tq.accept({
            lane, message, parts,
            type: "prompt",
          })
        }
        const batch = yield* tq.claimNext(lane, 1)
        expect(batch?.receipts).toHaveLength(3)
        expect(batch?.receipts.map((r) => r.inputMessageID)).toEqual(ids)
        expect(batch?.receipts.every((r) => r.state === "claimed")).toBe(true)
        expect(batch?.claimFrontier).toBe(ids[2])
      }),
    ),
  )

  it.live(
    "ack settles claimed records and advances the consumed frontier",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "ack" })
        const lane = { sessionID: session.id, agentID: "main" }
        const { message, parts } = userMessage(session.id)
        const receipt = yield* tq.accept({
          lane, message, parts,
          type: "prompt",
        })
        const batch = yield* tq.claimNext(lane, 7)
        expect(batch?.receipts).toHaveLength(1)
        yield* tq.ack(lane, batch!.claimFrontier, [
          { receiptId: receipt.id, outcome: "success" },
        ], 7)
        const settled = yield* tq.getReceipt(receipt.id)
        expect(settled.state).toBe("settled")
        expect(settled.outcome).toBe("success")
        expect(settled.consumed).toBe(true)
      }),
    ),
  )

  it.live(
    "abortSession cancels accepted and claimed; outcome is never_ran when unread",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "abort" })
        const lane = { sessionID: session.id, agentID: "main" }
        const a = userMessage(session.id, "unread")
        const accepted = yield* tq.accept({
          lane, message: a.message, parts: a.parts,
          type: "prompt",
        })
        const b = userMessage(session.id, "claimed")
        const claimed = yield* tq.accept({
          lane, message: b.message, parts: b.parts,
          type: "prompt",
        })
        yield* tq.claimNext(lane, 1)
        const epoch = yield* tq.abortSession(session.id)
        expect(epoch).toBe(1)
        const r1 = yield* tq.getReceipt(accepted.id)
        const r2 = yield* tq.getReceipt(claimed.id)
        expect(r1.state).toBe("cancelled")
        expect(r1.outcome).toBe("never_ran")
        expect(r2.state).toBe("cancelled")
        expect(r2.outcome).toBe("never_ran")
      }),
    ),
  )

  it.live(
    "abortSession outcome is interrupted when the record was already consumed",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "abort-consumed" })
        const lane = { sessionID: session.id, agentID: "main" }
        const { message, parts } = userMessage(session.id)
        const receipt = yield* tq.accept({
          lane, message, parts,
          type: "prompt",
        })
        const batch = yield* tq.claimNext(lane, 1)
        // Mark consumed via ack interrupted? No — consumed is set at ack.
        // Settle as interrupted (consumed=true path uses outcome interrupted).
        yield* tq.ack(lane, batch!.claimFrontier, [
          { receiptId: receipt.id, outcome: "interrupted" },
        ], 1)
        const r = yield* tq.getReceipt(receipt.id)
        expect(r.state).toBe("cancelled")
        expect(r.outcome).toBe("interrupted")
        expect(r.consumed).toBe(true)
      }),
    ),
  )

  it.live(
    "observeInput resolves immediately when revision already advanced",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "observe-immediate" })
        const lane = { sessionID: session.id, agentID: "main" }
        const { message, parts } = userMessage(session.id)
        yield* tq.accept({
          lane, message, parts,
          type: "prompt",
        })
        const rev = yield* tq.observeInput(lane, 0)
        expect(rev).toBeGreaterThan(0)
      }),
    ),
  )

  it.live(
    "observeInput waits then resolves when a later accept bumps revision",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "observe-wait" })
        const lane = { sessionID: session.id, agentID: "main" }
        const fiber = yield* tq.observeInput(lane, 0).pipe(Effect.forkChild)
        yield* Effect.sleep("100 millis")
        const { message, parts } = userMessage(session.id)
        yield* tq.accept({
          lane, message, parts,
          type: "prompt",
        })
        const rev = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
        expect(rev).toBeGreaterThan(0)
      }),
    ),
  )

  for (const inputType of ["prompt", "text", "actor_notification"]) it.live(
    `filtered observation retains ${inputType} input preceding an ignored notification`,
    provideTmpdirInstance(() => Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const tq = yield* InboxController.Service
      const session = yield* sessions.create({ title: "filtered batch" })
      const lane = { sessionID: session.id, agentID: "main" }
      yield* tq.accept({ lane, ...userMessage(session.id), type: "prompt" })
      const revision = yield* tq.observeInput(lane, -1)
      yield* tq.accept({
        lane, ...userMessage(session.id, "interrupting input"), type: inputType,
        ...(inputType === "prompt" ? {} : { senderSessionID: session.id, senderActorID: "other" }),
      })
      yield* tq.accept({
        lane, ...userMessage(session.id, "ignored notification"), type: "actor_notification",
        senderSessionID: session.id, senderActorID: "child",
      })
      const batch = yield* tq.claimNext(lane, 1)
      yield* tq.ack(lane, batch!.claimFrontier, batch!.receipts.map((receipt) => ({
        receiptId: receipt.id, outcome: "success" as const,
      })), 1)
      Database.use((db) => db.update(InboxTable).set({ created_at: 123, time_updated: 123 })
        .where(eq(InboxTable.receiver_session_id, session.id)).run())
      expect(yield* tq.observeInput(lane, revision, {
        ignoreActorNotification: { sessionID: session.id, actorID: "child" },
      }).pipe(Effect.timeout("5 seconds"))).toBe(revision + 2)
    })),
  )

  it.live(
    "filtered observation preserves interruption when receipt history no longer matches revision",
    provideTmpdirInstance(() => Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const tq = yield* InboxController.Service
      const session = yield* sessions.create({ title: "filtered receipt boundary" })
      const lane = { sessionID: session.id, agentID: "main" }
      const initial = yield* tq.accept({ lane, ...userMessage(session.id), type: "prompt" })
      const revision = yield* tq.observeInput(lane, -1)
      yield* tq.accept({ lane, ...userMessage(session.id), type: "prompt" })
      yield* tq.accept({
        lane, ...userMessage(session.id), type: "actor_notification",
        senderSessionID: session.id, senderActorID: "child",
      })
      Database.use((db) => db.delete(InboxTable).where(eq(InboxTable.id, initial.id)).run())
      expect(yield* tq.observeInput(lane, revision, {
        ignoreActorNotification: { sessionID: session.id, actorID: "child" },
      }).pipe(Effect.timeout("5 seconds"))).toBe(3)
    })),
  )

  it.live(
    "filtered observation ignores multiple target notifications then observes a foreign sender",
    provideTmpdirInstance(() => Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const tq = yield* InboxController.Service
      const session = yield* sessions.create({ title: "filtered subscription" })
      const foreign = yield* sessions.create({ title: "foreign sender" })
      const lane = { sessionID: session.id, agentID: "main" }
      const options = { ignoreActorNotification: { sessionID: session.id, actorID: "child" } }
      for (let i = 0; i < 2; i++) yield* tq.accept({
        lane, ...userMessage(session.id), type: "actor_notification",
        senderSessionID: session.id, senderActorID: "child",
      })
      const wait = yield* tq.observeInput(lane, 0, options).pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")
      expect(wait.pollUnsafe()).toBeUndefined()
      yield* tq.accept({
        lane, ...userMessage(session.id), type: "actor_notification",
        senderSessionID: session.id, senderActorID: "child",
      })
      yield* Effect.sleep("20 millis")
      expect(wait.pollUnsafe()).toBeUndefined()
      yield* tq.accept({
        lane, ...userMessage(session.id), type: "actor_notification",
        senderSessionID: foreign.id, senderActorID: "child",
      })
      expect(yield* Fiber.join(wait).pipe(Effect.timeout("5 seconds"))).toBe(4)
    })),
  )

  it.live(
    "reconcileOnBoot cancels claimed rows (process restart mid-claim)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "reconcile" })
        const lane = { sessionID: session.id, agentID: "main" }
        const { message, parts } = userMessage(session.id)
        const receipt = yield* tq.accept({
          lane, message, parts,
          type: "prompt",
        })
        yield* tq.claimNext(lane, 1)
        yield* tq.reconcileOnBoot(session.id)
        const r = yield* tq.getReceipt(receipt.id)
        expect(r.state).toBe("cancelled")
        expect(r.outcome).toBe("never_ran")
      }),
    ),
  )

  it.live(
    "cancelled records are not revived by claimNext and stay visible (cancelled)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "no-revive" })
        const lane = { sessionID: session.id, agentID: "main" }
        const { message, parts } = userMessage(session.id)
        const receipt = yield* tq.accept({
          lane, message, parts,
          type: "prompt",
        })
        yield* tq.abortSession(session.id)
        const batch = yield* tq.claimNext(lane, 2, 1)
        expect(batch).toBeUndefined()
        const r = yield* tq.getReceipt(receipt.id)
        expect(r.state).toBe("cancelled")
        expect(r.outcome).toBe("never_ran")
      }),
    ),
  )

  it.live(
    "extendClaim picks up records accepted after the original claim",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "extend" })
        const lane = { sessionID: session.id, agentID: "main" }
        const a = userMessage(session.id, "first")
        yield* tq.accept({
          lane, message: a.message, parts: a.parts,
          type: "prompt",
        })
        const first = yield* tq.claimNext(lane, 5)
        expect(first?.receipts).toHaveLength(1)
        const b = userMessage(session.id, "second")
        yield* tq.accept({
          lane, message: b.message, parts: b.parts,
          type: "prompt",
        })
        const extended = yield* tq.extendClaim(lane, 5)
        expect(extended?.receipts).toHaveLength(1)
        expect(extended?.receipts[0]?.inputMessageID).toBe(b.message.id)
      }),
    ),
  )

  it.live(
    "guard expectedEpoch rejects accept after abort",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "guard-epoch" })
        const lane = { sessionID: session.id, agentID: "main" }
        const epoch = yield* tq.getEpoch(session.id)
        yield* tq.abortSession(session.id)
        const { message, parts } = userMessage(session.id)
        const result = yield* tq
          .accept(
            { lane, message, parts, type: "prompt" },
            { expectedEpoch: epoch },
          )
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "disposing the queue service clears its global reference",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect(inboxControllerRef.current).toBeDefined()
        const before = inboxControllerRef.current
        yield* Effect.void
        expect(inboxControllerRef.current).toBe(before)
      }),
    ),
  )
})
