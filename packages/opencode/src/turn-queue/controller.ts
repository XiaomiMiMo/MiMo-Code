import { Context, Deferred, Effect, Layer } from "effect"
import { ulid } from "ulid"
import { and, Database, eq, inArray, ne, or, sql } from "@/storage"
import { MessageTable, PartTable } from "@/session/session.sql"
import { Bus } from "@/bus"
import type { MessageID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util"
import { ReceiptUpdated } from "./events"
import {
  intentRank,
  isCoalescable,
  type AbortPolicy,
  type AdmitInput,
  type Intent,
  type Lane,
  type Receipt,
  type ReceiptOutcome,
  type ReceiptState,
} from "./schema"
import { TurnLaneStateTable, TurnLegacyBootstrapTable, TurnReceiptTable, TurnSessionEpochTable } from "./turn-queue.sql"
import { turnQueueRef } from "./turn-queue-ref"
import { schedulerRef } from "./scheduler"
import * as TurnQueueSync from "./sync"
import { ExecutionOwnership } from "@/session/execution-ownership"
import { EffectBridge } from "@/effect"

const log = Log.create({ service: "turn-queue" })

export class ReceiptNotFound extends Error {
  constructor(readonly receiptId: string) {
    super(`Receipt not found: ${receiptId}`)
  }
}

export interface AdmissionGuard {
  isCancelled?: () => boolean
  expectedEpoch?: number
}

export interface Interface {
  readonly admit: (input: AdmitInput, guard?: AdmissionGuard) => Effect.Effect<Receipt>
  readonly getReceipt: (receiptId: string) => Effect.Effect<Receipt, ReceiptNotFound>
  readonly listAccepted: (lane: Lane) => Effect.Effect<Receipt[]>
  readonly claimNext: (
    lane: Lane,
    runId: number,
    expectedEpoch?: number,
  ) => Effect.Effect<{ receipts: Receipt[]; claimFrontier: MessageID | undefined } | undefined>
  readonly ack: (
    lane: Lane,
    claimFrontier: MessageID | undefined,
    settled: Array<{ receiptId: string; outcome: ReceiptOutcome; messageId?: MessageID; error?: string }>,
    expectedRunId?: number,
  ) => Effect.Effect<void>
  readonly extendClaim: (
    lane: Lane,
    runId: number,
    expectedEpoch?: number,
  ) => Effect.Effect<{ receipts: Receipt[]; claimFrontier: MessageID | undefined } | undefined>
  readonly observeInput: (lane: Lane, afterRevision: number) => Effect.Effect<number>
  readonly abortSession: (sessionID: SessionID, policy?: AbortPolicy) => Effect.Effect<number>
  readonly getEpoch: (sessionID: SessionID) => Effect.Effect<number>
  readonly reconcileOnBoot: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TurnQueue") {}

function toReceipt(row: typeof TurnReceiptTable.$inferSelect): Receipt {
  return {
    id: row.id,
    lane: { sessionID: row.session_id, agentID: row.agent_id },
    state: row.state,
    intent: row.intent as Intent,
    epoch: row.epoch,
    runId: row.run_id ?? undefined,
    claimFrontier: row.claim_frontier ?? undefined,
    consumed: row.consumed,
    suspended: row.suspended,
    outcome: row.outcome ?? undefined,
    messageId: row.message_id ?? undefined,
    error: row.error ?? undefined,
    idempotencyKey: row.idempotency_key ? row.idempotency_key : undefined,
    time: { created: row.time_created, updated: row.time_updated },
  }
}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    /** Per-lane waiters for observeInput (in-process). */
    const inputWaiters = new Map<string, Set<Deferred.Deferred<number>>>()
    const reconciled = new Set<SessionID>()
    const waiterKey = (lane: Lane) => `${lane.sessionID}:${lane.agentID}`

    const bumpRevision = (lane: Lane, identity: ExecutionOwnership.Identity) =>
      Effect.gen(function* () {
        const now = Date.now()
        const row = yield* Effect.sync(() =>
          Database.transaction((db) => {
            ExecutionOwnership.assertOwnership(db, lane.sessionID, identity)
            const row = db.insert(TurnLaneStateTable)
              .values({
                session_id: lane.sessionID,
                agent_id: lane.agentID,
                input_revision: 1,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: [TurnLaneStateTable.session_id, TurnLaneStateTable.agent_id],
                set: {
                  input_revision: sql`${TurnLaneStateTable.input_revision} + 1`,
                  time_updated: now,
                },
              })
              .returning().get()!
            TurnQueueSync.record({ sessionID: lane.sessionID, lanes: [row] })
            return row
          }),
        )
        const rev = row?.input_revision ?? 0
        const waiters = inputWaiters.get(waiterKey(lane))
        if (waiters) {
          for (const d of [...waiters]) {
            waiters.delete(d)
            // Concurrent admits can race two bumps; skip already-completed waiters.
            const done = yield* Deferred.isDone(d)
            if (done) continue
            Deferred.doneUnsafe(d, Effect.succeed(rev))
          }
          if (waiters.size === 0) inputWaiters.delete(waiterKey(lane))
        }
        return rev
      })

    const getEpoch = Effect.fn("TurnQueue.getEpoch")(function* (sessionID: SessionID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(TurnSessionEpochTable).where(eq(TurnSessionEpochTable.session_id, sessionID)).get()),
      )
      return row?.epoch ?? 0
    })

    const loadLane = (lane: Lane) =>
      Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(TurnLaneStateTable)
            .where(and(eq(TurnLaneStateTable.session_id, lane.sessionID), eq(TurnLaneStateTable.agent_id, lane.agentID)))
            .get(),
        ),
      )

    const publish = (receipt: Receipt) =>
      bus
        .publish(ReceiptUpdated, {
          sessionID: receipt.lane.sessionID,
          receiptId: receipt.id,
          agentID: receipt.lane.agentID,
          state: receipt.state,
          ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
          ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
          epoch: receipt.epoch,
        })
        .pipe(Effect.ignore)

    const writeReceipt = (input: AdmitInput, state: ReceiptState, identity: ExecutionOwnership.Identity, guard?: AdmissionGuard) =>
      Effect.sync(() => Database.transaction((db) => {
        ExecutionOwnership.assertOwnership(db, input.lane.sessionID, identity)
        if (guard?.isCancelled?.()) return undefined
        const epoch = db.select().from(TurnSessionEpochTable)
          .where(eq(TurnSessionEpochTable.session_id, input.lane.sessionID)).get()?.epoch ?? 0
        if (guard?.expectedEpoch !== undefined && epoch !== guard.expectedEpoch) return undefined
        if (input.idempotencyKey) {
          const row = db.select().from(TurnReceiptTable).where(and(
            eq(TurnReceiptTable.session_id, input.lane.sessionID),
            eq(TurnReceiptTable.idempotency_key, input.idempotencyKey),
          )).get()
          if (row) return { row, kind: "existing" as const }
        }
        if (input.intent.kind === "prompt") {
          const row = db.select().from(TurnReceiptTable).where(and(
            eq(TurnReceiptTable.session_id, input.lane.sessionID),
            eq(TurnReceiptTable.agent_id, input.lane.agentID),
            sql`json_extract(${TurnReceiptTable.intent}, '$.kind') = 'prompt'`,
            sql`json_extract(${TurnReceiptTable.intent}, '$.messageID') = ${input.intent.messageID}`,
            or(
              and(eq(TurnReceiptTable.state, "settled"), eq(TurnReceiptTable.consumed, true)),
              and(
                inArray(TurnReceiptTable.state, ["accepted", "claimed"]),
                eq(TurnReceiptTable.epoch, epoch),
                eq(TurnReceiptTable.suspended, false),
              ),
            ),
          )).orderBy(sql`${TurnReceiptTable.consumed} desc`).get()
          if (row) return { row, kind: "existing" as const }
        }
        const now = Date.now()
        if (isCoalescable(input.intent)) {
          const eligible = and(
            eq(TurnReceiptTable.session_id, input.lane.sessionID),
            eq(TurnReceiptTable.agent_id, input.lane.agentID),
            eq(TurnReceiptTable.epoch, epoch),
            eq(TurnReceiptTable.state, "accepted"),
            eq(TurnReceiptTable.suspended, false),
            sql`json_extract(${TurnReceiptTable.intent}, '$.kind') = 'wake'`,
          )
          const wake = db.select().from(TurnReceiptTable).where(eligible).get()
          if (wake) {
            const previous = wake.intent as Extract<Intent, { kind: "wake" }>
            const intent = previous.inboxWatermark >= input.intent.inboxWatermark
              ? previous
              : { ...previous, inboxWatermark: input.intent.inboxWatermark }
            const row = db.update(TurnReceiptTable).set({ intent, time_updated: now })
              .where(and(eligible, eq(TurnReceiptTable.id, wake.id))).returning().get()!
            TurnQueueSync.record({ sessionID: input.lane.sessionID, receipts: [row] })
            return { row, kind: "coalesced" as const }
          }
        }
        const id = ulid()
        const row = db.insert(TurnReceiptTable)
          .values({
            id,
            session_id: input.lane.sessionID,
            agent_id: input.lane.agentID,
            state,
            intent: input.intent as unknown as Record<string, unknown>,
            epoch,
            idempotency_key: input.idempotencyKey ?? "",
            time_created: now,
            time_updated: now,
          })
          .returning().get()!
        TurnQueueSync.record({ sessionID: input.lane.sessionID, receipts: [row] })
        return { row, kind: "inserted" as const }
      }))

    const loadReceipt = (id: string) =>
      Effect.sync(() => Database.use((db) => db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.id, id)).get()))

    const getReceipt = Effect.fn("TurnQueue.getReceipt")(function* (receiptId: string) {
      const row = yield* loadReceipt(receiptId)
      if (!row) return yield* Effect.fail(new ReceiptNotFound(receiptId))
      return toReceipt(row)
    })

    /** Fire-and-forget schedule: Controller owns receipts; kick only starts a lease when idle. */
    const maybeKick = (lane: Lane) =>
      Effect.gen(function* () {
        const sched = schedulerRef.current
        if (!sched) return
        const bridge = yield* EffectBridge.make()
        void bridge.promise(sched.kick(lane)).catch(() => undefined)
      })

    const admit = Effect.fn("TurnQueue.admit")(function* (input: AdmitInput, guard?: AdmissionGuard) {
      const identity = yield* ExecutionOwnership.captureIdentity
      const isCancelled = guard ? () => {
        if (guard.isCancelled?.()) return true
        if (guard.expectedEpoch === undefined) return false
        const current = Database.use((db) => db.select().from(TurnSessionEpochTable)
          .where(eq(TurnSessionEpochTable.session_id, input.lane.sessionID)).get())
        return (current?.epoch ?? 0) !== guard.expectedEpoch
      } : undefined
      if (isCancelled?.()) return yield* Effect.interrupt

      const written = yield* writeReceipt(input, "accepted", identity, guard)
      if (written === undefined) return yield* Effect.interrupt
      const receipt = toReceipt(written.row)
      if (written.kind !== "inserted") {
        // Guarded dispatch stays with its caller; terminal receipt reuse cannot start another turn.
        if (!guard && (receipt.state === "accepted" || receipt.state === "claimed")) yield* maybeKick(input.lane)
        return receipt
      }
      // Steer revision is for user input only — wake/shell must not interrupt wait.
      if (input.intent.kind === "prompt") {
        yield* bumpRevision(input.lane, identity)
      }
      yield* publish(receipt)
      // Kick only for kinds that do not self-dispatch (resume/shell).
      // prompt() calls loop() itself; inbox wake calls loop(requireClaim).
      // Avoiding double-kick closes the claim race that steals the turn.
      if (input.intent.kind === "resume" || input.intent.kind === "shell") {
        yield* maybeKick(input.lane)
      }
      return receipt
    })

    const listAccepted = Effect.fn("TurnQueue.listAccepted")(function* (lane: Lane) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(TurnReceiptTable)
            .where(
              and(
                eq(TurnReceiptTable.session_id, lane.sessionID),
                eq(TurnReceiptTable.agent_id, lane.agentID),
                eq(TurnReceiptTable.state, "accepted"),
                eq(TurnReceiptTable.suspended, false),
              ),
            )
            .all(),
        ),
      )
      return rows.map(toReceipt).sort((a, b) => intentRank(a.intent) - intentRank(b.intent) || a.id.localeCompare(b.id))
    })

    const claim = (lane: Lane, runId: number, expectedEpoch: number | undefined, requireOwner: boolean) =>
      Effect.gen(function* () {
        const identity = yield* ExecutionOwnership.captureIdentity
        const batch = yield* Effect.sync(() => Database.transaction((db) => {
          ExecutionOwnership.assertOwnership(db, lane.sessionID, identity)
          const epoch = db.select().from(TurnSessionEpochTable)
            .where(eq(TurnSessionEpochTable.session_id, lane.sessionID)).get()?.epoch ?? 0
          if (expectedEpoch !== undefined && epoch !== expectedEpoch) return undefined
          const owned = db.select().from(TurnReceiptTable).where(and(
            eq(TurnReceiptTable.session_id, lane.sessionID),
            eq(TurnReceiptTable.agent_id, lane.agentID),
            eq(TurnReceiptTable.run_id, runId),
            eq(TurnReceiptTable.epoch, epoch),
            eq(TurnReceiptTable.state, "claimed"),
            eq(TurnReceiptTable.suspended, false),
          )).all()
          if (requireOwner && owned.length === 0) return undefined
          const frontier = db.select().from(TurnLaneStateTable).where(and(
            eq(TurnLaneStateTable.session_id, lane.sessionID),
            eq(TurnLaneStateTable.agent_id, lane.agentID),
          )).get()?.consumed_frontier ?? undefined
          const eligible = db.select().from(TurnReceiptTable).where(and(
            eq(TurnReceiptTable.session_id, lane.sessionID),
            eq(TurnReceiptTable.agent_id, lane.agentID),
            eq(TurnReceiptTable.state, "accepted"),
            eq(TurnReceiptTable.suspended, false),
            eq(TurnReceiptTable.epoch, epoch),
          )).all().map(toReceipt)
          if (eligible.length === 0) return undefined
          let claimFrontier = frontier
          for (const row of owned) {
            if (row.claim_frontier && (!claimFrontier || row.claim_frontier > claimFrontier)) claimFrontier = row.claim_frontier
          }
          for (const r of eligible) {
            if (r.intent.kind === "prompt" && (!claimFrontier || r.intent.messageID > claimFrontier)) claimFrontier = r.intent.messageID
          }
          const rows = db.update(TurnReceiptTable).set({
            state: "claimed",
            run_id: runId,
            claim_frontier: claimFrontier ?? null,
            time_updated: Date.now(),
          }).where(and(
            inArray(TurnReceiptTable.id, eligible.map((r) => r.id)),
            eq(TurnReceiptTable.state, "accepted"),
            eq(TurnReceiptTable.suspended, false),
            eq(TurnReceiptTable.epoch, epoch),
          )).returning().all()
          if (rows.length === 0) return undefined
          TurnQueueSync.record({ sessionID: lane.sessionID, receipts: rows })
          return {
            receipts: rows.map(toReceipt).sort((a, b) => intentRank(a.intent) - intentRank(b.intent) || a.id.localeCompare(b.id)),
            claimFrontier,
          }
        }))
        if (!batch) return undefined
        for (const receipt of batch.receipts) yield* publish(receipt)
        return batch
      })

    const claimNext = Effect.fn("TurnQueue.claimNext")(function* (lane: Lane, runId: number, expectedEpoch?: number) {
      return yield* claim(lane, runId, expectedEpoch, false)
    })

    const ack = Effect.fn("TurnQueue.ack")(function* (
      lane: Lane,
      claimFrontier: MessageID | undefined,
      settled: Array<{ receiptId: string; outcome: ReceiptOutcome; messageId?: MessageID; error?: string }>,
      expectedRunId?: number,
    ) {
      const identity = yield* ExecutionOwnership.captureIdentity
      const rows = yield* Effect.sync(() =>
        Database.transaction((db) => {
          ExecutionOwnership.assertOwnership(db, lane.sessionID, identity)
          const now = Date.now()
          const epoch = db
            .select()
            .from(TurnSessionEpochTable)
            .where(eq(TurnSessionEpochTable.session_id, lane.sessionID))
            .get()?.epoch ?? 0
          const rows = settled.flatMap((s) => {
            const state: ReceiptState = s.outcome === "success" || s.outcome === "assistant_error" ? "settled" : "cancelled"
            return db
              .update(TurnReceiptTable)
              .set({
                state,
                outcome: s.outcome,
                message_id: s.messageId ?? null,
                error: s.error ?? null,
                consumed: s.outcome !== "never_ran",
                time_updated: now,
              })
              .where(
                and(
                  eq(TurnReceiptTable.id, s.receiptId),
                  eq(TurnReceiptTable.session_id, lane.sessionID),
                  eq(TurnReceiptTable.agent_id, lane.agentID),
                  eq(TurnReceiptTable.epoch, epoch),
                  eq(TurnReceiptTable.state, "claimed"),
                  expectedRunId == null ? undefined : eq(TurnReceiptTable.run_id, expectedRunId),
                ),
              )
              .returning()
              .all()
          })
          const lanes: Array<typeof TurnLaneStateTable.$inferSelect> = []
          if (claimFrontier && rows.some((row) => row.consumed && row.claim_frontier && row.claim_frontier >= claimFrontier)) {
            const updatedLane = db.insert(TurnLaneStateTable)
              .values({
                session_id: lane.sessionID,
                agent_id: lane.agentID,
                consumed_frontier: claimFrontier,
                input_revision: 0,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: [TurnLaneStateTable.session_id, TurnLaneStateTable.agent_id],
                set: {
                  consumed_frontier: sql`max(coalesce(${TurnLaneStateTable.consumed_frontier}, ${claimFrontier}), ${claimFrontier})`,
                  time_updated: now,
                },
              })
              .returning().get()!
            lanes.push(updatedLane)
          }
          TurnQueueSync.record({ sessionID: lane.sessionID, receipts: rows, lanes })
          return rows
        }),
      )
      for (const row of rows) yield* publish(toReceipt(row))
    })

    const extendClaim = Effect.fn("TurnQueue.extendClaim")(function* (lane: Lane, runId: number, expectedEpoch?: number) {
      return yield* claim(lane, runId, expectedEpoch, true)
    })

    const observeInput = Effect.fn("TurnQueue.observeInput")(function* (lane: Lane, afterRevision: number) {
      const key = waiterKey(lane)
      const current = yield* loadLane(lane)
      const rev = current?.input_revision ?? 0
      if (rev > afterRevision) return rev

      const deferred = yield* Deferred.make<number>()
      let set = inputWaiters.get(key)
      if (!set) {
        set = new Set()
        inputWaiters.set(key, set)
      }
      // Check-subscribe-recheck: close the gap between load and subscribe so a
      // concurrent bumpRevision cannot be missed (spec: no gap).
      set.add(deferred)
      const current2 = yield* loadLane(lane)
      const rev2 = current2?.input_revision ?? 0
      if (rev2 > afterRevision) {
        set.delete(deferred)
        return rev2
      }
      return yield* Deferred.await(deferred).pipe(
        Effect.ensuring(Effect.sync(() => set?.delete(deferred))),
      )
    })

    const abortSession = Effect.fn("TurnQueue.abortSession")(function* (sessionID: SessionID, policy: AbortPolicy = "drop") {
      const identity = yield* ExecutionOwnership.captureIdentity
      const now = Date.now()
      const nextEpoch = yield* Effect.sync(() =>
        Database.transaction((db) => {
          ExecutionOwnership.assertOwnership(db, sessionID, identity)
          const epochRow = db.insert(TurnSessionEpochTable)
            .values({ session_id: sessionID, epoch: 1, time_updated: now })
            .onConflictDoUpdate({
              target: TurnSessionEpochTable.session_id,
              set: { epoch: sql`${TurnSessionEpochTable.epoch} + 1`, time_updated: now },
            })
            .returning().get()!
          const nextEpoch = epochRow.epoch
          const receipts = db.update(TurnReceiptTable)
            .set({
              state: "cancelled",
              outcome: sql`CASE WHEN ${TurnReceiptTable.consumed} THEN 'interrupted' ELSE 'never_ran' END`,
              suspended: policy === "keep-suspended",
              time_updated: now,
            })
            .where(
              and(
                eq(TurnReceiptTable.session_id, sessionID),
                inArray(TurnReceiptTable.state, ["accepted", "claimed"]),
                ne(TurnReceiptTable.epoch, nextEpoch),
              ),
            )
            .returning().all()
          TurnQueueSync.record({ sessionID, receipts, epoch: epochRow })
          return nextEpoch
        }),
      )
      log.info("turn-queue abort", { sessionID, epoch: nextEpoch, policy })
      return nextEpoch
    })

    const reconcileOnBoot = Effect.fn("TurnQueue.reconcileOnBoot")(function* (sessionID: SessionID) {
      const identity = yield* ExecutionOwnership.captureIdentity
      const lanes = yield* Effect.sync(() => {
        Database.use((db) => ExecutionOwnership.assertOwnership(db, sessionID, identity))
        // No yield between checking recovery and committing it: another prompt may claim immediately afterwards.
        if (reconciled.has(sessionID)) return []
        const lanes = Database.transaction((db) => {
          ExecutionOwnership.assertOwnership(db, sessionID, identity)
          const receipts: Array<typeof TurnReceiptTable.$inferSelect> = []
          const laneRows: Array<typeof TurnLaneStateTable.$inferSelect> = []
          const epoch = db
            .select()
            .from(TurnSessionEpochTable)
            .where(eq(TurnSessionEpochTable.session_id, sessionID))
            .get()?.epoch ?? 0
          const now = Date.now()
          const stale = db.update(TurnReceiptTable)
            .set({ state: "cancelled", outcome: "never_ran", time_updated: now })
            .where(
              and(
                eq(TurnReceiptTable.session_id, sessionID),
                inArray(TurnReceiptTable.state, ["accepted", "claimed"]),
                ne(TurnReceiptTable.epoch, epoch),
              ),
            )
            .returning().all()
          receipts.push(...stale)
          // Preserve the crashed receipt's terminal result; only wakes get a new admission.
          const crashed = db.update(TurnReceiptTable)
            .set({ state: "cancelled", outcome: "never_ran", time_updated: now })
            .where(and(eq(TurnReceiptTable.session_id, sessionID), eq(TurnReceiptTable.state, "claimed")))
            .returning().all()
          receipts.push(...crashed)
          for (const row of crashed) {
            const intent = row.intent as Intent
            if (intent.kind !== "wake" || row.suspended || row.epoch !== epoch) continue
            const pending = db.select().from(TurnReceiptTable).where(and(
              eq(TurnReceiptTable.session_id, sessionID),
              eq(TurnReceiptTable.agent_id, row.agent_id),
              eq(TurnReceiptTable.state, "accepted"),
              eq(TurnReceiptTable.suspended, false),
              eq(TurnReceiptTable.epoch, epoch),
              sql`json_extract(${TurnReceiptTable.intent}, '$.kind') = 'wake'`,
            )).get()
            if (pending) {
              const previous = pending.intent as Extract<Intent, { kind: "wake" }>
              if (previous.inboxWatermark < intent.inboxWatermark) {
                const merged = db.update(TurnReceiptTable).set({ intent: { ...previous, inboxWatermark: intent.inboxWatermark }, time_updated: now })
                  .where(eq(TurnReceiptTable.id, pending.id)).returning().get()!
                receipts.push(merged)
              }
              continue
            }
            const replacement = db.insert(TurnReceiptTable).values({
              id: ulid(), session_id: sessionID, agent_id: row.agent_id,
              intent: row.intent, epoch, state: "accepted", time_created: now, time_updated: now,
            }).returning().get()!
            receipts.push(replacement)
          }
          const bootstrap = db.select().from(TurnLegacyBootstrapTable)
            .where(eq(TurnLegacyBootstrapTable.session_id, sessionID)).get()
          if (bootstrap && !bootstrap.completed) {
            const membership = sql`${MessageTable.id} in (select value from json_each(${JSON.stringify(bootstrap.message_ids)}))`
            const users = db.select({ id: MessageTable.id }).from(MessageTable).where(and(
              eq(MessageTable.session_id, sessionID),
              eq(MessageTable.agent_id, "main"),
              membership,
              sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
              sql`json_extract(${MessageTable.data}, '$.provenance') is null`,
              sql`exists (select 1 from ${PartTable}
                where ${PartTable.message_id} = ${MessageTable.id}
                  and (json_extract(${PartTable.data}, '$.type') in ('file', 'subtask')
                    or (json_extract(${PartTable.data}, '$.type') = 'text'
                      and coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
                      and coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
                      and trim(json_extract(${PartTable.data}, '$.text')) != '')))`,
            )).orderBy(MessageTable.id).all()
            const userIDs = new Set(users.map((user) => user.id))
            const responses = db.select().from(MessageTable).where(and(
              eq(MessageTable.session_id, sessionID),
              eq(MessageTable.agent_id, "main"),
              membership,
              sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            )).all().flatMap((message) => {
              if (message.data.role !== "assistant") return []
              const info = message.data as Omit<MessageV2.Assistant, "id" | "sessionID">
              if (!userIDs.has(info.parentID) || info.time.completed === undefined) return []
              if (info.finish !== "stop" && info.finish !== "other" && !info.error && info.structured === undefined) return []
              return [{ id: message.id, parentID: info.parentID, error: info.error }]
            }).sort((a, b) => a.parentID.localeCompare(b.parentID) || a.id.localeCompare(b.id))
            const existing = new Set(db.select().from(TurnReceiptTable).where(and(
              eq(TurnReceiptTable.session_id, sessionID),
              eq(TurnReceiptTable.agent_id, "main"),
            )).all().flatMap((row) => {
              const intent = row.intent as Intent
              return intent.kind === "prompt" ? [intent.messageID] : []
            }))
            let accepted = 0
            let frontier: MessageID | undefined
            for (const user of users) {
              if (existing.has(user.id)) continue
              // Prefix consumption is a legacy-only inference over the frozen pre-queue members.
              const response = responses.find((response) => response.parentID >= user.id)
              const adopted = db.insert(TurnReceiptTable).values({
                id: ulid(), session_id: sessionID, agent_id: "main", epoch,
                state: response ? "settled" : "accepted",
                intent: { kind: "prompt", messageID: user.id },
                consumed: !!response,
                claim_frontier: response ? user.id : null,
                message_id: response?.id,
                outcome: response ? response.error ? "assistant_error" : "success" : null,
                error: response?.error ? JSON.stringify(response.error) : null,
                time_created: now, time_updated: now,
              }).returning().get()!
              receipts.push(adopted)
              if (response) frontier = user.id
              else accepted++
            }
            if (accepted > 0 || frontier) {
              const updatedLane = db.insert(TurnLaneStateTable).values({
                session_id: sessionID, agent_id: "main", input_revision: accepted,
                consumed_frontier: frontier, time_updated: now,
              }).onConflictDoUpdate({
                target: [TurnLaneStateTable.session_id, TurnLaneStateTable.agent_id],
                set: {
                  input_revision: sql`${TurnLaneStateTable.input_revision} + ${accepted}`,
                  ...(frontier ? { consumed_frontier: sql`max(coalesce(${TurnLaneStateTable.consumed_frontier}, ${frontier}), ${frontier})` } : {}),
                  time_updated: now,
                },
              }).returning().get()!
              laneRows.push(updatedLane)
            }
          }
          const completedBootstrap = db.insert(TurnLegacyBootstrapTable).values({
            session_id: sessionID, message_ids: [], completed: true, time_updated: now,
          }).onConflictDoUpdate({
            target: TurnLegacyBootstrapTable.session_id,
            set: { completed: true, time_updated: now },
          }).returning().get()!
          const interruptedAdmissions = db.select({
            id: MessageTable.id,
            epoch: sql<number>`json_extract(${MessageTable.data}, '$.queueAdmission.epoch')`,
          }).from(MessageTable).where(and(
            eq(MessageTable.session_id, sessionID),
            eq(MessageTable.agent_id, "main"),
            sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
            sql`json_extract(${MessageTable.data}, '$.queueAdmission.ready') = 1`,
            sql`json_extract(${MessageTable.data}, '$.queueAdmission.epoch') <= ${epoch}`,
            sql`not exists (select 1 from ${TurnReceiptTable}
              where ${TurnReceiptTable.session_id} = ${MessageTable.session_id}
                and ${TurnReceiptTable.agent_id} = 'main'
                and json_extract(${TurnReceiptTable.intent}, '$.kind') = 'prompt'
                and json_extract(${TurnReceiptTable.intent}, '$.messageID') = ${MessageTable.id})`,
          )).all()
          let admitted = 0
          for (const message of interruptedAdmissions) {
            const current = message.epoch === epoch
            const recovered = db.insert(TurnReceiptTable).values({
              id: ulid(), session_id: sessionID, agent_id: "main", epoch: message.epoch,
              state: current ? "accepted" : "cancelled", outcome: current ? null : "never_ran",
              intent: { kind: "prompt", messageID: message.id }, time_created: now, time_updated: now,
            }).returning().get()!
            receipts.push(recovered)
            if (current) admitted++
          }
          if (admitted > 0) {
            const updatedLane = db.insert(TurnLaneStateTable).values({
              session_id: sessionID, agent_id: "main", input_revision: admitted, time_updated: now,
            }).onConflictDoUpdate({
              target: [TurnLaneStateTable.session_id, TurnLaneStateTable.agent_id],
              set: { input_revision: sql`${TurnLaneStateTable.input_revision} + ${admitted}`, time_updated: now },
            }).returning().get()!
            laneRows.push(updatedLane)
          }
          TurnQueueSync.record({ sessionID, receipts, lanes: laneRows, bootstrap: completedBootstrap })
          return db
            .select({
              session_id: TurnReceiptTable.session_id,
              agent_id: TurnReceiptTable.agent_id,
            })
            .from(TurnReceiptTable)
            .where(
              and(
                eq(TurnReceiptTable.session_id, sessionID),
                eq(TurnReceiptTable.state, "accepted"),
                eq(TurnReceiptTable.suspended, false),
                sql`not exists (select 1 from ${MessageTable}
                  where ${MessageTable.session_id} = ${TurnReceiptTable.session_id}
                    and ${MessageTable.agent_id} = ${TurnReceiptTable.agent_id}
                    and ${MessageTable.id} = json_extract(${TurnReceiptTable.intent}, '$.messageID')
                    and json_extract(${TurnReceiptTable.intent}, '$.kind') = 'prompt'
                    and json_extract(${MessageTable.data}, '$.queueAdmission.ready') = 1
                    and json_extract(${MessageTable.data}, '$.queueAdmission.dispatch') = 0)`,
              ),
            )
            .all()
        })
        reconciled.add(sessionID)
        return lanes
      })
      // Recovered and surviving accepted work still needs a lease.
      const seen = new Set<string>()
      for (const row of lanes) {
        const key = `${row.session_id}:${row.agent_id}`
        if (seen.has(key)) continue
        seen.add(key)
        yield* maybeKick({ sessionID: row.session_id, agentID: row.agent_id })
      }
    })

    const impl: Interface = {
      admit,
      getReceipt,
      listAccepted,
      claimNext,
      ack,
      extendClaim,
      observeInput,
      abortSession,
      getEpoch,
      reconcileOnBoot,
    }
    turnQueueRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (turnQueueRef.current === impl) turnQueueRef.current = undefined
      }),
    )
    return Service.of(impl)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.defaultLayer))

export * as TurnQueue from "./controller"
