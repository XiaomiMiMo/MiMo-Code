import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { WorkspaceID } from "../../src/control-plane/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { Database, eq, sql } from "../../src/storage"
import { SyncEvent } from "../../src/sync"
import { EventTable } from "../../src/sync/event.sql"
import { installRestore, RestoreConflict } from "../../src/sync/restore"
import { schedulerRef } from "../../src/turn-queue/scheduler"
import * as QueueSync from "../../src/turn-queue/sync"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(() => Instance.disposeAll())

function envelope(template: Session.Info, withLanes: boolean) {
  const sessionID = SessionID.descending()
  const workspaceID = WorkspaceID.ascending()
  const events: SyncEvent.SerializedEvent[] = [{
    id: `${sessionID}-event-0`, aggregateID: sessionID, seq: 0, type: "session.created.1",
    data: JSON.parse(JSON.stringify({ sessionID, info: { ...template, id: sessionID, workspaceID } })),
  }]
  const queueSnapshot: QueueSync.Snapshot = {
    version: 1,
    sessionID,
    receipts: ["z", "a"].map((key, index) => ({
      id: `${sessionID}-${key}`, session_id: sessionID, agent_id: key,
      state: "accepted", intent: { kind: "shell", command: `command-${key}`, cwd: template.directory },
      epoch: 0, run_id: null, claim_frontier: null, consumed: false, suspended: false,
      outcome: null, message_id: null, delivery_message_id: null, error: null,
      idempotency_key: `${sessionID}-${key}`, time_created: 100 + index, time_updated: 200 + index,
    })),
    lanes: withLanes ? ["z", "a"].map((agent_id, index) => ({
      session_id: sessionID, agent_id, consumed_frontier: null, input_revision: index + 3, time_updated: 300 + index,
    })) : [],
    epoch: null,
    bootstrap: null,
  }
  return { events, queueSnapshot, finalSeq: 0, workspaceID, isIdle: () => true }
}

const changes = () => Database.use((db) => db.get<{ changes: number }>(sql`select total_changes() as changes`)!.changes)

describe("restore snapshot ordering", () => {
  for (const withLanes of [false, true]) {
    it.live(`an unchanged unsorted envelope retries without writes, publication, or dispatch (lanes=${withLanes})`, provideTmpdirInstance(() => Effect.gen(function* () {
      const template = yield* (yield* Session.Service).create({})
      const input = envelope(template, withLanes)
      const unchanged = structuredClone(input.queueSnapshot)
      const sessionID = input.queueSnapshot.sessionID
      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => {
        if (event.payload.syncEvent?.aggregateID === sessionID || event.payload.properties?.sessionID === sessionID) events.push(event)
      }
      const previous = schedulerRef.current
      let dispatched = 0
      schedulerRef.current = { kick: () => Effect.sync(() => { dispatched++ }) }
      GlobalBus.on("event", listener)
      try {
        expect(yield* Effect.sync(() => installRestore(input))).toBe(sessionID)
        const saved = QueueSync.capture(sessionID)
        expect(saved.receipts.map((receipt) => receipt.id)).toEqual([`${sessionID}-a`, `${sessionID}-z`])
        expect(saved.lanes.map((lane) => lane.agent_id)).toEqual(withLanes ? ["a", "z"] : [])
        const before = changes()
        expect(yield* Effect.sync(() => installRestore(input))).toBe(sessionID)
        expect(changes()).toBe(before)
        expect(QueueSync.capture(sessionID)).toEqual(saved)
        expect(input.queueSnapshot).toEqual(unchanged)
        expect(Database.use((db) => db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all())).toHaveLength(1)
        yield* Effect.yieldNow
        expect(events).toEqual([])
        expect(dispatched).toBe(0)
      } finally {
        GlobalBus.off("event", listener)
        schedulerRef.current = previous
      }
    })), 30000)
  }

  it.live("order-independent comparison still rejects changes to receipt, lane, epoch, and bootstrap fields", provideTmpdirInstance(() => Effect.gen(function* () {
    const template = yield* (yield* Session.Service).create({})
    const input = envelope(template, true)
    const sessionID = input.queueSnapshot.sessionID
    input.queueSnapshot.epoch = { session_id: sessionID, epoch: 0, time_updated: 42 }
    input.queueSnapshot.bootstrap = { session_id: sessionID, message_ids: [], completed: true, time_updated: 43 }
    yield* Effect.sync(() => installRestore(input))
    const saved = QueueSync.capture(sessionID)
    const mutations: Array<(snapshot: QueueSync.Snapshot) => void> = [
      (snapshot) => { snapshot.receipts[0].intent = { kind: "shell", command: "different-command" } },
      (snapshot) => { snapshot.receipts[0].time_updated++ },
      (snapshot) => { snapshot.lanes[0].input_revision++ },
      (snapshot) => { snapshot.epoch!.time_updated++ },
      (snapshot) => { snapshot.bootstrap!.completed = false },
    ]
    for (const mutate of mutations) {
      const snapshot = structuredClone(input.queueSnapshot)
      mutate(snapshot)
      const before = changes()
      expect(() => installRestore({ ...input, queueSnapshot: snapshot })).toThrow(RestoreConflict)
      expect(changes()).toBe(before)
      expect(QueueSync.capture(sessionID)).toEqual(saved)
    }
    expect(installRestore(input)).toBe(sessionID)
  })), 30000)
})
