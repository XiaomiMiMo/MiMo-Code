import { Context, Deferred, Effect, Layer } from "effect"
import { ulid } from "ulid"
import { and, Database, eq, inArray, ne, or, sql } from "@/storage"
import { NotFoundError } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import { MessageV2 } from "@/session/message-v2"
import { Bus } from "@/bus"
import { SyncEvent } from "@/sync"
import type { MessageID, SessionID } from "@/session/schema"
import { Log } from "@/util"
import { ReceiptUpdated } from "./events"
import {
  MAX_CLAIM_PER_STEP,
  type AcceptInput,
  type Lane,
  type Receipt,
  type ReceiptOutcome,
  type ReceiptState,
} from "./schema"
import { InboxLaneStateTable, InboxSessionEpochTable, InboxTable } from "./inbox.sql"
import { inboxControllerRef } from "./controller-ref"
import { schedulerRef } from "./scheduler"
import * as InboxSync from "./sync"
import { ExecutionOwnership } from "@/session/execution-ownership"
import { EffectBridge } from "@/effect"
import { bindScopedRef } from "@/effect/scoped-ref"
import { Instance } from "@/project/instance"
import * as InstanceState from "@/effect/instance-state"

const log = Log.create({ service: "inbox" })

export class ReceiptNotFound extends Error {
  constructor(readonly receiptId: string) {
    super(`Receipt not found: ${receiptId}`)
  }
}

export interface AdmissionGuard {
  deferKick?: boolean
  isCancelled?: () => boolean
  expectedEpoch?: number
}

export interface Interface {
  readonly accept: (
    input: AcceptInput,
    guard?: AdmissionGuard,
  ) => Effect.Effect<Receipt>
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
    settled: Array<{ receiptId: string; outcome: ReceiptOutcome; error?: string }>,
    expectedRunId?: number,
  ) => Effect.Effect<void>
  readonly extendClaim: (
    lane: Lane,
    runId: number,
    expectedEpoch?: number,
    limit?: number,
  ) => Effect.Effect<{ receipts: Receipt[]; claimFrontier: MessageID | undefined } | undefined>
  readonly observeInput: (
    lane: Lane,
    afterRevision: number,
    options?: { ignoreActorNotification: { sessionID: SessionID; actorID: string } },
  ) => Effect.Effect<number>
  readonly withStop: <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly abortSession: (sessionID: SessionID) => Effect.Effect<number>
  readonly getEpoch: (sessionID: SessionID) => Effect.Effect<number>
  readonly reconcileOnBoot: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InboxController") {}

function toReceipt(row: typeof InboxTable.$inferSelect): Receipt {
  return {
    id: row.id,
    lane: { sessionID: row.receiver_session_id, agentID: row.receiver_actor_id },
    state: row.state,
    type: row.type,
    ...(row.sender_session_id ? { senderSessionID: row.sender_session_id } : {}),
    ...(row.sender_actor_id ? { senderActorID: row.sender_actor_id } : {}),
    epoch: row.epoch,
    runId: row.run_id ?? undefined,
    claimFrontier: row.claim_frontier ?? undefined,
    consumed: row.consumed,
    outcome: row.outcome ?? undefined,
    inputMessageID: row.input_message_id!,
    deliveryMessageID: row.delivery_message_id ?? undefined,
    error: row.error ?? undefined,
    idempotencyKey: row.idempotency_key ? row.idempotency_key : undefined,
    time: { created: row.created_at, updated: row.time_updated },
  }
}

// 仅认领已经完成消息写入的输入。
const promptOnly = sql`${InboxTable.input_message_id} is not null`

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    /** Per-lane waiters for observeInput (in-process). */
    const inputWaiters = new Map<string, Set<Deferred.Deferred<number>>>()
    const reconciled = new Set<SessionID>()
    const stopping = new Map<SessionID, number>()
    const cancelInputs = (db: Database.TxOrDb, sessionID: SessionID, now: number) =>
      db.update(InboxTable).set({
        state: "cancelled",
        outcome: sql`CASE WHEN ${InboxTable.consumed} THEN 'interrupted' ELSE 'never_ran' END`,
        time_updated: now,
      }).where(and(eq(InboxTable.receiver_session_id, sessionID),
        inArray(InboxTable.state, ["accepted", "claimed"]))).returning().all()
    const withStop = <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => stopping.set(sessionID, (stopping.get(sessionID) ?? 0) + 1)),
        () => work,
        () => Effect.gen(function* () {
          const remaining = stopping.get(sessionID)! - 1
          if (remaining > 0) {
            stopping.set(sessionID, remaining)
            return
          }
          const identity = yield* ExecutionOwnership.captureIdentity
          const rows = yield* Effect.sync(() => Database.transaction((db) => {
            ExecutionOwnership.assertOwnership(db, sessionID, identity)
            const rows = cancelInputs(db, sessionID, Date.now())
            InboxSync.record({ sessionID, receipts: rows })
            return rows
          }))
          for (const row of rows) yield* publish(toReceipt(row))
          stopping.delete(sessionID)
        }),
      )
    const waiterKey = (lane: Lane) => `${lane.sessionID}:${lane.agentID}`

    const getEpoch = Effect.fn("Inbox.getEpoch")(function* (sessionID: SessionID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(InboxSessionEpochTable).where(eq(InboxSessionEpochTable.session_id, sessionID)).get()),
      )
      return row?.epoch ?? 0
    })

    const publish = (receipt: Receipt) =>
      bus
        .publish(ReceiptUpdated, {
          sessionID: receipt.lane.sessionID,
          receiptId: receipt.id,
          agentID: receipt.lane.agentID,
          state: receipt.state,
          ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
          inputMessageID: String(receipt.inputMessageID),
          ...(receipt.deliveryMessageID ? { deliveryMessageID: String(receipt.deliveryMessageID) } : {}),
          epoch: receipt.epoch,
        })
        .pipe(Effect.ignore)

    /**
     * One transaction: persist the user message + parts, write the inbox
     * record, bump input_revision. Returns undefined when the admission
     * guard rejects the write.
     */
    const writeAccept = (input: AcceptInput, identity: ExecutionOwnership.Identity, guard?: AdmissionGuard) =>
      Effect.sync(() => Database.transaction((db) => {
        ExecutionOwnership.assertOwnership(db, input.lane.sessionID, identity)
        if (guard?.isCancelled?.()) return undefined
        const epoch = db.select().from(InboxSessionEpochTable)
          .where(eq(InboxSessionEpochTable.session_id, input.lane.sessionID)).get()?.epoch ?? 0
        if (guard?.expectedEpoch !== undefined && epoch !== guard.expectedEpoch) return undefined
        const legacy = input.legacyInboxID
          ? db.select().from(InboxTable).where(eq(InboxTable.id, input.legacyInboxID)).get()
          : undefined
        if (input.legacyInboxID && !legacy) throw new Error("Legacy inbox record missing")
        if (legacy?.input_message_id) return { row: legacy, kind: "existing" as const }
        const idempotencyKey = input.idempotencyKey ?? ""
        if (idempotencyKey) {
          const row = db.select().from(InboxTable).where(and(
            eq(InboxTable.receiver_session_id, input.lane.sessionID),
            eq(InboxTable.idempotency_key, idempotencyKey),
            promptOnly,
          )).get()
          if (row) return { row, kind: "existing" as const }
        }
        // Same-message live receipt: a second accept for one message returns it.
        const duplicate = db.select().from(InboxTable).where(and(
          eq(InboxTable.receiver_session_id, input.lane.sessionID),
          eq(InboxTable.receiver_actor_id, input.lane.agentID),
          eq(InboxTable.input_message_id, input.message.id),
          promptOnly,
          or(
            and(eq(InboxTable.state, "settled"), eq(InboxTable.consumed, true)),
            and(
              inArray(InboxTable.state, ["accepted", "claimed"]),
              eq(InboxTable.epoch, epoch),
            ),
          ),
        )).orderBy(sql`${InboxTable.consumed} desc`).get()
        if (duplicate) return { row: duplicate, kind: "existing" as const }

        const now = Date.now()
        // Persist the accepted user message + parts in the same transaction.
        if (input.message.role !== "user") throw new Error("Inbox.accept requires a user message")
        if (input.parts.some((part) => part.sessionID !== input.message.sessionID || part.messageID !== input.message.id))
          throw new Error("Inbox.accept parts must belong to the saved message")
        if (!db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.message.sessionID)).get())
          throw new NotFoundError({ message: `Session not found: ${input.message.sessionID}` })
        SyncEvent.run(MessageV2.Event.Updated, { sessionID: input.message.sessionID, info: input.message })
        for (const part of input.parts) {
          SyncEvent.run(MessageV2.Event.PartUpdated, {
            sessionID: part.sessionID,
            part: structuredClone(part),
            time: now,
          })
        }

        const id = input.legacyInboxID ?? ulid()
        const row = db.insert(InboxTable)
          .values({
            id,
            receiver_session_id: input.lane.sessionID,
            receiver_actor_id: input.lane.agentID,
            sender_session_id: input.senderSessionID ?? null,
            sender_actor_id: input.senderActorID ?? null,
            type: input.type,
            content: null,
            input_message_id: input.message.id,
            state: "accepted",
            epoch,
            idempotency_key: idempotencyKey,
            created_at: now,
            time_updated: now,
          })
          .onConflictDoUpdate({
            target: InboxTable.id,
            set: { content: null, input_message_id: input.message.id, time_updated: now },
          })
          .returning().get()!
        const laneRow = db.insert(InboxLaneStateTable)
          .values({
            session_id: input.lane.sessionID,
            agent_id: input.lane.agentID,
            input_revision: 1,
            time_updated: now,
          })
          .onConflictDoUpdate({
            target: [InboxLaneStateTable.session_id, InboxLaneStateTable.agent_id],
            set: {
              input_revision: sql`${InboxLaneStateTable.input_revision} + 1`,
              time_updated: now,
            },
          })
          .returning().get()!
        InboxSync.record({ sessionID: input.lane.sessionID, receipts: [row], lanes: [laneRow] })
        return { row, kind: "inserted" as const, revision: laneRow.input_revision }
      }))

    const loadReceipt = (id: string) =>
      Effect.sync(() => Database.use((db) => db.select().from(InboxTable).where(eq(InboxTable.id, id)).get()))

    const getReceipt = Effect.fn("Inbox.getReceipt")(function* (receiptId: string) {
      const row = yield* loadReceipt(receiptId)
      if (!row) return yield* Effect.fail(new ReceiptNotFound(receiptId))
      return toReceipt(row)
    })

    /** Fire-and-forget schedule: Controller owns receipts; kick only starts a lease when idle. */
    const maybeKick = (lane: Lane) =>
      Effect.gen(function* () {
        const sched = schedulerRef.current
        if (!sched || stopping.has(lane.sessionID)) return
        const bridge = yield* EffectBridge.make()
        const directory = yield* InstanceState.directory
        const guard = sched.guard ? yield* sched.guard(lane) : undefined
        yield* Effect.acquireUseRelease(
          Effect.sync(() => ({ release: Instance.claim(directory), transferred: false })),
          (owner) => Effect.sync(() => {
            const work = bridge.promise(sched.kick(lane, guard))
            owner.transferred = true
            void work.then(owner.release, owner.release)
          }),
          (owner) => owner.transferred ? Effect.void : Effect.sync(owner.release),
        ).pipe(Effect.uninterruptible)
      })

    const accept = Effect.fn("Inbox.accept")(function* (input: AcceptInput, guard?: AdmissionGuard) {
      const identity = yield* ExecutionOwnership.captureIdentity
      const isCancelled = guard ? () => {
        if (guard.isCancelled?.()) return true
        if (guard.expectedEpoch === undefined) return false
        const current = Database.use((db) => db.select().from(InboxSessionEpochTable)
          .where(eq(InboxSessionEpochTable.session_id, input.lane.sessionID)).get())
        return (current?.epoch ?? 0) !== guard.expectedEpoch
      } : undefined
      if (isCancelled?.()) return yield* Effect.interrupt

      const written = yield* writeAccept(input, identity, guard)
      if (written === undefined) return yield* Effect.interrupt
      const receipt = toReceipt(written.row)
      if (written.kind === "inserted") {
        // Wake observeInput waiters — any accept advances input_revision.
        const waiters = inputWaiters.get(waiterKey(input.lane))
        if (waiters) {
          const rev = Database.use((db) =>
            db.select().from(InboxLaneStateTable)
              .where(and(eq(InboxLaneStateTable.session_id, input.lane.sessionID), eq(InboxLaneStateTable.agent_id, input.lane.agentID)))
              .get(),
          )?.input_revision ?? 0
          for (const d of [...waiters]) {
            waiters.delete(d)
            const done = yield* Deferred.isDone(d)
            if (done) continue
            Deferred.doneUnsafe(d, Effect.succeed(rev))
          }
          if (waiters.size === 0) inputWaiters.delete(waiterKey(input.lane))
        }
        yield* publish(receipt)
        if (!guard?.deferKick && !input.legacyInboxID) yield* maybeKick(input.lane)
      } else if (!guard && !input.legacyInboxID && (receipt.state === "accepted" || receipt.state === "claimed")) {
        yield* maybeKick(input.lane)
      }
      return receipt
    })

    const listAccepted = Effect.fn("Inbox.listAccepted")(function* (lane: Lane) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(InboxTable)
            .where(
              and(
                eq(InboxTable.receiver_session_id, lane.sessionID),
                eq(InboxTable.receiver_actor_id, lane.agentID),
                eq(InboxTable.state, "accepted"),
                promptOnly,
              ),
            )
            .all(),
        ),
      )
      return rows.map(toReceipt).sort((a, b) => a.id.localeCompare(b.id))
    })

    const claim = (lane: Lane, runId: number, expectedEpoch: number | undefined, requireOwner: boolean, limit = MAX_CLAIM_PER_STEP) =>
      Effect.gen(function* () {
        if (limit === 0) return undefined
        const identity = yield* ExecutionOwnership.captureIdentity
        const batch = yield* Effect.sync(() => Database.transaction((db) => {
          ExecutionOwnership.assertOwnership(db, lane.sessionID, identity)
          if (stopping.has(lane.sessionID)) return undefined
          const epoch = db.select().from(InboxSessionEpochTable)
            .where(eq(InboxSessionEpochTable.session_id, lane.sessionID)).get()?.epoch ?? 0
          if (expectedEpoch !== undefined && epoch !== expectedEpoch) return undefined
          const owned = db.select().from(InboxTable).where(and(
            eq(InboxTable.receiver_session_id, lane.sessionID),
            eq(InboxTable.receiver_actor_id, lane.agentID),
            eq(InboxTable.run_id, runId),
            eq(InboxTable.epoch, epoch),
            eq(InboxTable.state, "claimed"),
            promptOnly,
          )).all()
          if (requireOwner && owned.length === 0) return undefined
          const frontier = db.select().from(InboxLaneStateTable).where(and(
            eq(InboxLaneStateTable.session_id, lane.sessionID),
            eq(InboxLaneStateTable.agent_id, lane.agentID),
          )).get()?.consumed_frontier ?? undefined
          const eligible = db.select().from(InboxTable).where(and(
            eq(InboxTable.receiver_session_id, lane.sessionID),
            eq(InboxTable.receiver_actor_id, lane.agentID),
            eq(InboxTable.state, "accepted"),
            promptOnly,
            eq(InboxTable.epoch, epoch),
          )).orderBy(InboxTable.id).limit(limit).all().map(toReceipt)
          if (eligible.length === 0) return undefined
          let claimFrontier = frontier
          for (const row of owned) {
            if (row.claim_frontier && (!claimFrontier || row.claim_frontier > claimFrontier)) claimFrontier = row.claim_frontier
          }
          for (const r of eligible) {
            if (!claimFrontier || r.inputMessageID > claimFrontier) claimFrontier = r.inputMessageID
          }
          const rows = db.update(InboxTable).set({
            state: "claimed",
            run_id: runId,
            claim_frontier: claimFrontier ?? null,
            time_updated: Date.now(),
          }).where(and(
            inArray(InboxTable.id, eligible.map((r) => r.id)),
            eq(InboxTable.state, "accepted"),
            promptOnly,
            eq(InboxTable.epoch, epoch),
          )).returning().all()
          if (rows.length === 0) return undefined
          InboxSync.record({ sessionID: lane.sessionID, receipts: rows })
          return {
            receipts: rows.map(toReceipt).sort((a, b) => a.id.localeCompare(b.id)),
            claimFrontier,
          }
        }))
        if (!batch) return undefined
        for (const receipt of batch.receipts) yield* publish(receipt)
        return batch
      })

    const claimNext = Effect.fn("Inbox.claimNext")(function* (lane: Lane, runId: number, expectedEpoch?: number) {
      return yield* claim(lane, runId, expectedEpoch, false)
    })

    const ack = Effect.fn("Inbox.ack")(function* (
      lane: Lane,
      claimFrontier: MessageID | undefined,
      settled: Array<{ receiptId: string; outcome: ReceiptOutcome; error?: string }>,
      expectedRunId?: number,
    ) {
      const identity = yield* ExecutionOwnership.captureIdentity
      const rows = yield* Effect.sync(() =>
        Database.transaction((db) => {
          ExecutionOwnership.assertOwnership(db, lane.sessionID, identity)
          const now = Date.now()
          const epoch = db
            .select()
            .from(InboxSessionEpochTable)
            .where(eq(InboxSessionEpochTable.session_id, lane.sessionID))
            .get()?.epoch ?? 0
          const rows = settled.flatMap((s) => {
            const state: ReceiptState = s.outcome === "success" || s.outcome === "assistant_error" ? "settled" : "cancelled"
            return db
              .update(InboxTable)
              .set({
                state,
                outcome: s.outcome,
                error: s.error ?? null,
                consumed: s.outcome !== "never_ran",
                time_updated: now,
              })
              .where(
                and(
                  eq(InboxTable.id, s.receiptId),
                  eq(InboxTable.receiver_session_id, lane.sessionID),
                  eq(InboxTable.receiver_actor_id, lane.agentID),
                  eq(InboxTable.epoch, epoch),
                  eq(InboxTable.state, "claimed"),
                  expectedRunId == null ? undefined : eq(InboxTable.run_id, expectedRunId),
                ),
              )
              .returning()
              .all()
          })
          const lanes: Array<typeof InboxLaneStateTable.$inferSelect> = []
          if (claimFrontier && rows.some((row) => row.consumed && row.claim_frontier && row.claim_frontier >= claimFrontier)) {
            const updatedLane = db.insert(InboxLaneStateTable)
              .values({
                session_id: lane.sessionID,
                agent_id: lane.agentID,
                consumed_frontier: claimFrontier,
                input_revision: 0,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: [InboxLaneStateTable.session_id, InboxLaneStateTable.agent_id],
                set: {
                  consumed_frontier: sql`max(coalesce(${InboxLaneStateTable.consumed_frontier}, ${claimFrontier}), ${claimFrontier})`,
                  time_updated: now,
                },
              })
              .returning().get()!
            lanes.push(updatedLane)
          }
          InboxSync.record({ sessionID: lane.sessionID, receipts: rows, lanes })
          return rows
        }),
      )
      for (const row of rows) yield* publish(toReceipt(row))
    })

    const extendClaim = Effect.fn("Inbox.extendClaim")(function* (lane: Lane, runId: number, expectedEpoch?: number, limit?: number) {
      return yield* claim(lane, runId, expectedEpoch, true, limit)
    })

    const observeInput = Effect.fn("Inbox.observeInput")(function* (
      lane: Lane,
      afterRevision: number,
      options?: { ignoreActorNotification: { sessionID: SessionID; actorID: string } },
    ) {
      const key = waiterKey(lane)
      const read = () => Effect.sync(() => Database.transaction((db) => {
        const revision = db.select().from(InboxLaneStateTable).where(and(
          eq(InboxLaneStateTable.session_id, lane.sessionID), eq(InboxLaneStateTable.agent_id, lane.agentID),
        )).get()?.input_revision ?? 0
        if (!options || afterRevision < 0 || revision <= afterRevision) return { revision, relevant: true }
        const admitted = and(
          eq(InboxTable.receiver_session_id, lane.sessionID), eq(InboxTable.receiver_actor_id, lane.agentID),
          promptOnly, sql`${InboxTable.idempotency_key} not like 'import-history:%'`,
        )
        const count = db.select({ count: sql<number>`count(*)` }).from(InboxTable).where(admitted).get()!.count
        if (count !== revision) return { revision, relevant: true }
        // rowid 保留受理顺序；revision 与 receipt 在同一事务写入，状态变化不影响输入边界。
        const rows = db.select().from(InboxTable).where(admitted)
          .orderBy(sql`${InboxTable}.rowid desc`).limit(revision - afterRevision).all()
        const source = options.ignoreActorNotification
        return { revision, relevant: rows.length < revision - afterRevision || rows.some((row) =>
          row.type !== "actor_notification" || row.sender_session_id !== source.sessionID || row.sender_actor_id !== source.actorID,
        ) }
      }))
      for (;;) {
        const current = yield* read()
        if (current.revision > afterRevision) {
          if (current.relevant) return current.revision
          afterRevision = current.revision
        }
        const deferred = yield* Deferred.make<number>()
        let set = inputWaiters.get(key)
        if (!set) {
          set = new Set()
          inputWaiters.set(key, set)
        }
        // 订阅前后读取 revision，避免遗漏并发受理。
        set.add(deferred)
        const next = yield* read()
        if (next.revision > afterRevision) {
          set.delete(deferred)
          if (next.relevant) return next.revision
          afterRevision = next.revision
          continue
        }
        yield* Deferred.await(deferred).pipe(
          Effect.ensuring(Effect.sync(() => set.delete(deferred))),
        )
      }
    })

    const abortSession = Effect.fn("Inbox.abortSession")(function* (sessionID: SessionID) {
      const identity = yield* ExecutionOwnership.captureIdentity
      const now = Date.now()
      const stopped = yield* Effect.sync(() =>
        Database.transaction((db) => {
          ExecutionOwnership.assertOwnership(db, sessionID, identity)
          const epochRow = db.insert(InboxSessionEpochTable)
            .values({ session_id: sessionID, epoch: 1, time_updated: now })
            .onConflictDoUpdate({
              target: InboxSessionEpochTable.session_id,
              set: { epoch: sql`${InboxSessionEpochTable.epoch} + 1`, time_updated: now },
            })
            .returning().get()!
          const nextEpoch = epochRow.epoch
          const receipts = cancelInputs(db, sessionID, now)
          InboxSync.record({ sessionID, receipts, epoch: epochRow })
          return { epoch: nextEpoch, receipts }
        }),
      )
      for (const row of stopped.receipts) yield* publish(toReceipt(row))
      log.info("inbox abort", { sessionID, epoch: stopped.epoch })
      return stopped.epoch
    })

    const reconcileOnBoot = Effect.fn("Inbox.reconcileOnBoot")(function* (sessionID: SessionID) {
      const identity = yield* ExecutionOwnership.captureIdentity
      const lanes = yield* Effect.sync(() => {
        Database.use((db) => ExecutionOwnership.assertOwnership(db, sessionID, identity))
        // No yield between checking recovery and committing it: another prompt may claim immediately afterwards.
        if (reconciled.has(sessionID)) return []
        const lanes = Database.transaction((db) => {
          ExecutionOwnership.assertOwnership(db, sessionID, identity)
          const receipts: Array<typeof InboxTable.$inferSelect> = []
          const laneRows: Array<typeof InboxLaneStateTable.$inferSelect> = []
          const epoch = db
            .select()
            .from(InboxSessionEpochTable)
            .where(eq(InboxSessionEpochTable.session_id, sessionID))
            .get()?.epoch ?? 0
          const now = Date.now()
          // Process restart mid-claim or stop fence: stale-epoch and crashed
          // claims settle as cancelled/never_ran. Messages stay visible.
          const stale = db.update(InboxTable)
            .set({ state: "cancelled", outcome: "never_ran", time_updated: now })
            .where(
              and(
                eq(InboxTable.receiver_session_id, sessionID),
                promptOnly,
                inArray(InboxTable.state, ["accepted", "claimed"]),
                ne(InboxTable.epoch, epoch),
              ),
            )
            .returning().all()
          receipts.push(...stale)
          const crashed = db.update(InboxTable)
            .set({ state: "cancelled", outcome: "never_ran", time_updated: now })
            .where(and(
              eq(InboxTable.receiver_session_id, sessionID),
              promptOnly,
              eq(InboxTable.state, "claimed"),
            ))
            .returning().all()
          receipts.push(...crashed)
          InboxSync.record({ sessionID, receipts, lanes: laneRows })
          return db
            .select({
              session_id: InboxTable.receiver_session_id,
              agent_id: InboxTable.receiver_actor_id,
            })
            .from(InboxTable)
            .where(
              and(
                eq(InboxTable.receiver_session_id, sessionID),
                eq(InboxTable.state, "accepted"),
                promptOnly,
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
      accept,
      getReceipt,
      listAccepted,
      claimNext,
      ack,
      extendClaim,
      observeInput,
      withStop,
      abortSession,
      getEpoch,
      reconcileOnBoot,
    }
    yield* bindScopedRef(inboxControllerRef, impl)
    return Service.of(impl)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.defaultLayer))
