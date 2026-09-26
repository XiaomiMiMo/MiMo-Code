import { afterEach, beforeEach, describe, expect, mock, spyOn } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import { Flag } from "../../src/flag/flag"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageTable, SessionTable } from "../../src/session/session.sql"
import { Database, eq, NotFoundError } from "../../src/storage"
import { SyncEvent } from "../../src/sync"
import { EventTable } from "../../src/sync/event.sql"
import { TurnQueue } from "../../src/turn-queue"
import { schedulerRef } from "../../src/turn-queue/scheduler"
import * as QueueSync from "../../src/turn-queue/sync"
import { TurnReceiptTable } from "../../src/turn-queue/turn-queue.sql"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const originalFlag = Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES
const originalScheduler = schedulerRef.current
beforeEach(() => {
  Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = true
  schedulerRef.current = undefined
})
afterEach(async () => {
  Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = originalFlag
  schedulerRef.current = originalScheduler
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer, Bus.layer, TurnQueue.defaultLayer))

function events(sessionID: SessionID): SyncEvent.SerializedEvent[] {
  return Database.use((db) => db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).orderBy(EventTable.seq).all())
    .map((row) => ({ id: row.id!, aggregateID: row.aggregate_id, type: row.type, seq: row.seq, data: row.data }))
}

function latestDelta(sessionID: SessionID) {
  const event = events(sessionID).at(-1)!
  expect(event.type).toBe("session.turn_queue.delta.1")
  return QueueSync.DeltaSchema.parse(event.data)
}

function rebuild(sessionID: SessionID) {
  const expected = QueueSync.capture(sessionID)
  const history = events(sessionID)
  Database.transaction((db) => {
    db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    SyncEvent.remove(sessionID)
  })
  const kick = mock(() => Effect.void)
  schedulerRef.current = { kick }
  expect(SyncEvent.replayAll(history)).toBe(sessionID)
  expect(QueueSync.capture(sessionID)).toEqual(expected)
  SyncEvent.replayAll(history)
  expect(QueueSync.capture(sessionID)).toEqual(expected)
  expect(kick).not.toHaveBeenCalled()
  expect(events(sessionID)).toEqual(history)
}

function receipt(sessionID: SessionID, id = "receipt"): QueueSync.Snapshot["receipts"][number] {
  return {
    id, session_id: sessionID, agent_id: "main", state: "accepted",
    intent: { kind: "prompt", messageID: MessageID.ascending() }, epoch: 0,
    run_id: null, claim_frontier: null, consumed: false, suspended: false,
    outcome: null, message_id: null, delivery_message_id: null, error: null,
    idempotency_key: "", time_created: 1, time_updated: 1,
  }
}

function empty(sessionID: SessionID): QueueSync.Snapshot {
  return { version: 1, sessionID, receipts: [], lanes: [], epoch: null, bootstrap: null }
}

describe("turn queue sync transport", () => {
  it.live("replays actual controller deltas without whole-queue snapshots or scheduler execution", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const tq = yield* TurnQueue.Service
    const session = yield* sessions.create({ title: "delta lifecycle" })
    const lane = { sessionID: session.id, agentID: "main" }
    const first = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
    expect(latestDelta(session.id).lanes?.[0].input_revision).toBe(1)
    const claimed = yield* tq.claimNext(lane, 42)
    expect(claimed?.receipts.map((r) => r.id)).toEqual([first.id])
    expect(latestDelta(session.id).receipts?.map((r) => r.id)).toEqual([first.id])
    const second = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
    const admission = events(session.id).at(-2)!
    expect(QueueSync.DeltaSchema.parse(admission.data).receipts?.map((r) => r.id)).toEqual([second.id])
    const extended = yield* tq.extendClaim(lane, 42)
    expect(extended?.receipts.map((r) => r.id)).toEqual([second.id])
    expect(latestDelta(session.id).receipts?.map((r) => r.id)).toEqual([second.id])
    const delivery = MessageID.ascending()
    Database.transaction((db) => {
      const rows = db.update(TurnReceiptTable).set({ delivery_message_id: delivery })
        .where(eq(TurnReceiptTable.id, first.id)).returning().all()
      QueueSync.record({ sessionID: session.id, receipts: rows })
    })
    expect(latestDelta(session.id).receipts?.[0].delivery_message_id).toBe(delivery)
    yield* tq.ack(lane, extended!.claimFrontier, [
      { receiptId: first.id, outcome: "success", messageId: delivery },
      { receiptId: second.id, outcome: "assistant_error", error: "provider error" },
    ], 42)
    const ack = latestDelta(session.id)
    expect(ack.receipts).toHaveLength(2)
    expect(ack.lanes?.[0].consumed_frontier).toBe(extended!.claimFrontier)
    expect(ack.lanes?.[0].input_revision).toBe(2)
    const wake = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "a" } })
    const merged = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "z" } })
    expect(merged.id).toBe(wake.id)
    expect(latestDelta(session.id).receipts).toHaveLength(1)
    expect(latestDelta(session.id).receipts?.[0].intent).toEqual({ kind: "wake", receiverActorID: "main", inboxWatermark: "z" })
    yield* tq.abortSession(session.id, "keep-suspended")
    const aborted = latestDelta(session.id)
    expect(aborted.epoch?.epoch).toBe(1)
    expect(aborted.receipts?.map((r) => r.id)).toEqual([wake.id])
    expect(aborted.receipts?.[0].suspended).toBe(true)
    expect(events(session.id).filter((e) => e.type === "session.turn_queue.snapshot.1")).toEqual([])
    rebuild(session.id)
  })))

  it.live("replays boot cancellation, wake replacement, and ready-message crash-gap recovery", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const tq = yield* TurnQueue.Service
    const session = yield* sessions.create({ title: "recovery delta" })
    const lane = { sessionID: session.id, agentID: "main" }
    const wake = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "z" } })
    yield* tq.claimNext(lane, 7)
    const pending = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "a" } })
    const actorLane = { ...lane, agentID: "actor" }
    const actorWake = yield* tq.admit({ lane: actorLane, intent: { kind: "wake", receiverActorID: "actor", inboxWatermark: "b" } })
    yield* tq.claimNext(actorLane, 8)
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID, sessionID: session.id, role: "user", agent: "build", agentID: "main",
      time: { created: 1 }, model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      queueAdmission: { epoch: 0, ready: true, dispatch: false },
    })
    yield* tq.reconcileOnBoot(session.id)
    const delta = latestDelta(session.id)
    expect(delta.bootstrap?.completed).toBe(true)
    expect(delta.lanes?.[0].input_revision).toBe(1)
    expect(delta.receipts?.find((r) => r.id === wake.id)?.state).toBe("cancelled")
    expect(delta.receipts?.find((r) => r.id === pending.id)?.intent).toEqual({ kind: "wake", receiverActorID: "main", inboxWatermark: "z" })
    expect(delta.receipts?.some((r) => r.intent.kind === "prompt" && r.intent.messageID === messageID && r.state === "accepted")).toBe(true)
    expect(delta.receipts?.find((r) => r.id === actorWake.id)?.state).toBe("cancelled")
    expect(delta.receipts?.some((r) => r.id !== actorWake.id && r.agent_id === "actor" && r.state === "accepted")).toBe(true)
    rebuild(session.id)
  })))

  it.live("replays frozen legacy adoption and completion without re-running bootstrap", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const tq = yield* TurnQueue.Service
    const session = yield* sessions.create({ title: "legacy delta" })
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({ id: messageID, sessionID: session.id, agentID: "main", role: "user", agent: "build", time: { created: 1 }, model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") } })
    yield* sessions.updatePart({ id: PartID.ascending(), messageID, sessionID: session.id, type: "text", text: "legacy external input" })
    Database.transaction(() => QueueSync.record({ sessionID: session.id, bootstrap: {
      session_id: session.id, message_ids: [messageID], completed: false, time_updated: 1,
    } }))
    yield* tq.reconcileOnBoot(session.id)
    const delta = latestDelta(session.id)
    expect(delta.receipts).toHaveLength(1)
    expect(delta.receipts?.[0].intent).toEqual({ kind: "prompt", messageID })
    expect(delta.lanes?.[0].input_revision).toBe(1)
    expect(delta.bootstrap).toMatchObject({ message_ids: [messageID], completed: true })
    rebuild(session.id)
  })))

  for (const operation of ["admit", "claim", "extend", "ack", "abort", "reconcile"] as const) {
    it.live(`${operation} rechecks caller ownership at its mutation transaction`, provideTmpdirInstance(() => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tq = yield* TurnQueue.Service
      const session = yield* sessions.create({ title: `ownership ${operation}` })
      const lane = { sessionID: session.id, agentID: "main" }
      const first = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
      const claim = operation === "ack" || operation === "extend" ? yield* tq.claimNext(lane, 1) : undefined
      if (operation === "extend") yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
      const before = QueueSync.capture(session.id)
      const history = events(session.id)
      const transaction = Database.transaction
      let moved = false
      const cut = spyOn(Database, "transaction").mockImplementation((callback, options) => {
        if (!moved) {
          moved = true
          Database.use((db) => db.update(SessionTable).set({ directory: "/another-executor" }).where(eq(SessionTable.id, session.id)).run())
        }
        return transaction(callback, options)
      })
      try {
        const action = operation === "admit" ? tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
          : operation === "claim" ? tq.claimNext(lane, 2)
          : operation === "extend" ? tq.extendClaim(lane, 1)
          : operation === "ack" ? tq.ack(lane, claim?.claimFrontier, [{ receiptId: first.id, outcome: "success" }], 1)
          : operation === "abort" ? tq.abortSession(session.id)
          : tq.reconcileOnBoot(session.id)
        const exit = yield* action.pipe(Effect.exit)
        expect(moved).toBe(true)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(QueueSync.capture(session.id)).toEqual(before)
        expect(events(session.id)).toEqual(history)
      } finally {
        cut.mockRestore()
      }
    })))
  }

  it.live("mirror projectors restore data even when this instance does not own execution", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "mirror only" })
    Database.use((db) => db.update(SessionTable).set({ directory: "/remote-owner" }).where(eq(SessionTable.id, session.id)).run())
    const row = receipt(session.id, "mirror-receipt")
    const kick = mock(() => Effect.void)
    schedulerRef.current = { kick }
    SyncEvent.run(QueueSync.Event.Delta, { sessionID: session.id, receipts: [row] })
    expect(QueueSync.capture(session.id).receipts).toEqual([row])
    SyncEvent.run(QueueSync.Event.Snapshot, empty(session.id))
    expect(QueueSync.capture(session.id)).toEqual(empty(session.id))
    expect(kick).not.toHaveBeenCalled()
  })))

  it.live("snapshot exact replacement clears nullable tables, preserves other sessions, and is idempotent", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "snapshot" })
    const other = yield* sessions.create({ title: "unrelated" })
    const initial = { ...empty(session.id), receipts: [receipt(session.id, "snapshot-a")],
      lanes: [{ session_id: session.id, agent_id: "main", input_revision: 9, consumed_frontier: null, time_updated: 1 }],
      epoch: { session_id: session.id, epoch: 3, time_updated: 1 },
      bootstrap: { session_id: session.id, message_ids: [], completed: true, time_updated: 1 },
    }
    Database.transaction((db) => {
      QueueSync.applySnapshot(initial, db)
      QueueSync.applySnapshot({ ...empty(other.id), receipts: [receipt(other.id, "snapshot-other")] }, db)
    })
    const unrelated = QueueSync.capture(other.id)
    const captured = QueueSync.snapshot(session.id)
    expect(captured).toEqual(initial)
    expect(events(session.id).at(-1)?.type).toBe("session.turn_queue.snapshot.1")
    const replacement = { ...empty(session.id), receipts: [receipt(session.id, "snapshot-b")] }
    const kick = mock(() => Effect.void)
    schedulerRef.current = { kick }
    SyncEvent.run(QueueSync.Event.Snapshot, replacement)
    SyncEvent.run(QueueSync.Event.Snapshot, replacement)
    expect(QueueSync.capture(session.id)).toEqual(replacement)
    expect(QueueSync.capture(other.id)).toEqual(unrelated)
    expect(kick).not.toHaveBeenCalled()
    rebuild(session.id)
  })))

  it.live("failed event recording rolls back source SQL and sequence without publishing", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const tq = yield* TurnQueue.Service
    const session = yield* sessions.create({ title: "atomic delta" })
    const before = events(session.id)
    const emitted = spyOn(GlobalBus, "emit")
    const run = SyncEvent.run
    const failure = spyOn(SyncEvent, "run").mockImplementation((definition, data, options) => {
      run(definition, data, options)
      if (definition.type === QueueSync.Event.Delta.type) throw new Error("event log failure")
    })
    try {
      const result = yield* tq.admit({ lane: { sessionID: session.id, agentID: "main" }, intent: { kind: "prompt", messageID: MessageID.ascending() } }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(QueueSync.capture(session.id)).toEqual(empty(session.id))
      expect(events(session.id)).toEqual(before)
      expect(emitted.mock.calls.filter((call) => JSON.stringify(call).includes("session.turn_queue.delta"))).toEqual([])
    } finally {
      failure.mockRestore()
      emitted.mockRestore()
    }
  })))

  it.live("deletion deltas delete before upsert and reject foreign IDs atomically", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "delete delta" })
    const other = yield* sessions.create({ title: "foreign delete" })
    const own = receipt(session.id, "delete-own")
    const foreign = receipt(other.id, "delete-foreign")
    Database.transaction(() => {
      QueueSync.record({ sessionID: session.id, receipts: [own] })
      QueueSync.record({ sessionID: other.id, receipts: [foreign] })
    })
    const changed = { ...own, state: "cancelled" as const }
    Database.transaction(() => QueueSync.record({ sessionID: session.id, deletedReceiptIDs: [own.id], receipts: [changed] }))
    expect(QueueSync.capture(session.id).receipts).toEqual([changed])
    const before = events(session.id)
    expect(() => Database.transaction(() => QueueSync.record({ sessionID: session.id, deletedReceiptIDs: [own.id, foreign.id] }))).toThrow(QueueSync.QueueValidationError)
    expect(QueueSync.capture(session.id).receipts).toEqual([changed])
    expect(QueueSync.capture(other.id).receipts).toEqual([foreign])
    expect(events(session.id)).toEqual(before)
    Database.transaction(() => QueueSync.record({ sessionID: session.id, deletedReceiptIDs: [own.id, "missing"] }))
    Database.transaction(() => QueueSync.record({ sessionID: session.id, deletedReceiptIDs: [own.id, "missing"] }))
    expect(QueueSync.capture(session.id).receipts).toEqual([])
    rebuild(session.id)
  })))

  it.live("rejects malformed schema, missing sessions, foreign rows, and foreign receipt IDs before replacement", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "validation" })
    const other = yield* sessions.create({ title: "foreign validation" })
    const own = receipt(session.id, "valid-owned")
    const foreign = receipt(other.id, "valid-foreign")
    Database.transaction(() => {
      QueueSync.record({ sessionID: session.id, receipts: [own] })
      QueueSync.record({ sessionID: other.id, receipts: [foreign] })
    })
    const original = QueueSync.capture(session.id)
    const invalid: unknown[] = [
      { ...original, version: 2 },
      { ...original, version: undefined },
      { ...original, receipts: [{ ...own, intent: { kind: "prompt" } }] },
      { ...original, receipts: [{ ...own, intent: { kind: "unknown" } }] },
      { ...original, receipts: [foreign] },
      { ...original, receipts: [{ ...foreign, session_id: session.id }] },
      { ...original, receipts: [own, own] },
      { ...original, lanes: [{ session_id: other.id, agent_id: "main", consumed_frontier: null, input_revision: 0, time_updated: 1 }] },
      { ...original, epoch: { session_id: other.id, epoch: 0, time_updated: 1 } },
      { ...original, bootstrap: { session_id: other.id, message_ids: [], completed: true, time_updated: 1 } },
    ]
    for (const value of invalid) {
      expect(() => Database.transaction((db) => QueueSync.applySnapshot(value as QueueSync.Snapshot, db))).toThrow(QueueSync.QueueValidationError)
      expect(QueueSync.capture(session.id)).toEqual(original)
    }
    expect(() => Database.transaction((db) => QueueSync.applySnapshot(empty(SessionID.descending()), db))).toThrow(NotFoundError)
    expect(QueueSync.capture(other.id).receipts).toEqual([foreign])
  })))

  it.live("rejects foreign message references in every queue field but permits missing historical messages", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "message ownership" })
    const other = yield* sessions.create({ title: "foreign message" })
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({ id: messageID, sessionID: other.id, agentID: "main", role: "user", agent: "build", time: { created: 1 }, model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") } })
    const own = receipt(session.id, "refs-owned")
    const base = { ...empty(session.id), receipts: [own] }
    const candidates: QueueSync.Snapshot[] = [
      { ...base, receipts: [{ ...own, intent: { kind: "prompt", messageID } }] },
      { ...base, receipts: [{ ...own, intent: { kind: "resume", assistantID: messageID, plan: "user-resume" } }] },
      ...(["message_id", "delivery_message_id", "claim_frontier"] as const).map((field) => ({ ...base, receipts: [{ ...own, [field]: messageID }] })),
      { ...base, lanes: [{ session_id: session.id, agent_id: "main", consumed_frontier: messageID, input_revision: 0, time_updated: 1 }] },
      { ...base, bootstrap: { session_id: session.id, message_ids: [messageID], completed: true, time_updated: 1 } },
    ]
    for (const value of candidates) {
      expect(() => Database.transaction((db) => QueueSync.applySnapshot(value, db))).toThrow(QueueSync.QueueValidationError)
      expect(QueueSync.capture(session.id)).toEqual(empty(session.id))
    }
    Database.transaction((db) => db.delete(MessageTable).where(eq(MessageTable.id, messageID)).run())
    for (const value of candidates) {
      Database.transaction((db) => QueueSync.applySnapshot(value, db))
      expect(QueueSync.capture(session.id)).toEqual(value)
    }
  })))

  it.live("rejects same-session prompt lane mismatch without rejecting absent historical messages", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "lane ownership" })
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({ id: messageID, sessionID: session.id, agentID: "actor-other", role: "user", agent: "build", time: { created: 1 }, model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") } })
    const row = { ...receipt(session.id, "lane-owned"), intent: { kind: "prompt" as const, messageID } }
    expect(() => Database.transaction(() => QueueSync.record({ sessionID: session.id, receipts: [row] }))).toThrow(QueueSync.QueueValidationError)
    Database.transaction(() => QueueSync.record({ sessionID: session.id, receipts: [{ ...row, agent_id: "actor-other" }] }))
    expect(QueueSync.capture(session.id).receipts[0].agent_id).toBe("actor-other")
  })))
})
