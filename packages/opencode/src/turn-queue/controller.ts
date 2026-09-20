import { Context, Deferred, Effect, Layer } from "effect"
import { ulid } from "ulid"
import { and, Database, eq, inArray, ne, sql } from "@/storage"
import { Bus } from "@/bus"
import type { MessageID, SessionID } from "@/session/schema"
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
import { TurnLaneStateTable, TurnReceiptTable, TurnSessionEpochTable } from "./turn-queue.sql"
import { turnQueueRef } from "./turn-queue-ref"

const log = Log.create({ service: "turn-queue" })

export class ReceiptNotFound extends Error {
  constructor(readonly receiptId: string) {
    super(`Receipt not found: ${receiptId}`)
  }
}

export interface Interface {
  readonly admit: (input: AdmitInput) => Effect.Effect<Receipt>
  readonly getReceipt: (receiptId: string) => Effect.Effect<Receipt, ReceiptNotFound>
  readonly listAccepted: (lane: Lane) => Effect.Effect<Receipt[]>
  readonly claimNext: (
    lane: Lane,
    runId: number,
  ) => Effect.Effect<{ receipts: Receipt[]; claimFrontier: MessageID | undefined } | undefined>
  readonly ack: (
    lane: Lane,
    claimFrontier: MessageID | undefined,
    settled: Array<{ receiptId: string; outcome: ReceiptOutcome; messageId?: MessageID; error?: string }>,
  ) => Effect.Effect<void>
  readonly extendClaim: (
    lane: Lane,
    runId: number,
  ) => Effect.Effect<Receipt | undefined>
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
    const waiterKey = (lane: Lane) => `${lane.sessionID}:${lane.agentID}`

    const bumpRevision = (lane: Lane) =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* Effect.sync(() =>
          Database.use((db) => {
            db.insert(TurnLaneStateTable)
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
              .run()
          }),
        )
        const row = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(TurnLaneStateTable)
              .where(
                and(
                  eq(TurnLaneStateTable.session_id, lane.sessionID),
                  eq(TurnLaneStateTable.agent_id, lane.agentID),
                ),
              )
              .get(),
          ),
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

    const insertReceipt = (input: AdmitInput, epoch: number, state: ReceiptState = "accepted") =>
      Effect.sync(() => {
        const now = Date.now()
        const id = ulid()
        Database.use((db) =>
          db
            .insert(TurnReceiptTable)
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
            .run(),
        )
        return id
      })

    const loadReceipt = (id: string) =>
      Effect.sync(() => Database.use((db) => db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.id, id)).get()))

    const getReceipt = Effect.fn("TurnQueue.getReceipt")(function* (receiptId: string) {
      const row = yield* loadReceipt(receiptId)
      if (!row) return yield* Effect.fail(new ReceiptNotFound(receiptId))
      return toReceipt(row)
    })

    const admit = Effect.fn("TurnQueue.admit")(function* (input: AdmitInput) {
      const epoch = yield* getEpoch(input.lane.sessionID)

      if (input.idempotencyKey && input.idempotencyKey !== "") {
        const existing = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(TurnReceiptTable)
              .where(
                and(
                  eq(TurnReceiptTable.session_id, input.lane.sessionID),
                  sql`${TurnReceiptTable.idempotency_key} = ${input.idempotencyKey}`,
                ),
              )
              .get(),
          ),
        )
        if (existing) return toReceipt(existing)
      }

      // Same messageID must not get a second live receipt (design re-admit rule).
      if (input.intent.kind === "prompt") {
        const messageId = input.intent.messageID
        const live = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(TurnReceiptTable)
              .where(
                and(
                  eq(TurnReceiptTable.session_id, input.lane.sessionID),
                  eq(TurnReceiptTable.agent_id, input.lane.agentID),
                  sql`json_extract(${TurnReceiptTable.intent}, '$.kind') = 'prompt'`,
                  sql`json_extract(${TurnReceiptTable.intent}, '$.messageID') = ${messageId}`,
                  inArray(TurnReceiptTable.state, ["accepted", "claimed"]),
                ),
              )
              .get(),
          ),
        )
        if (live) return toReceipt(live)
      }

      // Wake coalesce: merge into an existing accepted wake on the same lane.
      if (isCoalescable(input.intent)) {
        const accepted = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(TurnReceiptTable)
              .where(
                and(
                  eq(TurnReceiptTable.session_id, input.lane.sessionID),
                  eq(TurnReceiptTable.agent_id, input.lane.agentID),
                  eq(TurnReceiptTable.state, "accepted"),
                  eq(TurnReceiptTable.suspended, false),
                ),
              )
              .all(),
          ),
        )
        const wake = accepted.find((r) => (r.intent as Intent).kind === "wake")
        if (wake) {
          const prev = wake.intent as Extract<Intent, { kind: "wake" }>
          const merged: Intent =
            prev.inboxWatermark >= input.intent.inboxWatermark
              ? prev
              : { ...prev, inboxWatermark: input.intent.inboxWatermark }
          const now = Date.now()
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .update(TurnReceiptTable)
                .set({ intent: merged as unknown as Record<string, unknown>, time_updated: now })
                .where(eq(TurnReceiptTable.id, wake.id))
                .run(),
            ),
          )
          const row = yield* loadReceipt(wake.id)
          return toReceipt(row!)
        }
      }

      const id = yield* insertReceipt(input, epoch, "accepted")
      // Steer revision is for user input only — wake/shell must not interrupt wait.
      if (input.intent.kind === "prompt") {
        yield* bumpRevision(input.lane)
      }
      const row = yield* loadReceipt(id)
      const receipt = toReceipt(row!)
      yield* publish(receipt)
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

    const claimNext = Effect.fn("TurnQueue.claimNext")(function* (lane: Lane, runId: number) {
      const epoch = yield* getEpoch(lane.sessionID)
      const laneState = yield* loadLane(lane)
      const frontier = laneState?.consumed_frontier ?? undefined
      const accepted = yield* listAccepted(lane)
      // Eligible prompt/ resume after frontier; wake/shell always eligible if accepted.
      const eligible = accepted.filter((r) => {
        if (r.epoch < epoch) return false
        if (r.intent.kind === "prompt") {
          if (!frontier) return true
          return r.intent.messageID > frontier
        }
        return true
      })
      if (eligible.length === 0) return undefined

      let claimFrontier: MessageID | undefined = frontier
      for (const r of eligible) {
        if (r.intent.kind === "prompt" && (!claimFrontier || r.intent.messageID > claimFrontier)) {
          claimFrontier = r.intent.messageID
        }
      }

      const now = Date.now()
      const ids = eligible.map((r) => r.id)
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(TurnReceiptTable)
            .set({
              state: "claimed",
              run_id: runId,
              epoch,
              claim_frontier: claimFrontier ?? null,
              time_updated: now,
            })
            .where(inArray(TurnReceiptTable.id, ids))
            .run(),
        ),
      )
      const claimed: Receipt[] = []
      for (const id of ids) {
        const row = yield* loadReceipt(id)
        if (row) {
          const receipt = toReceipt(row)
          claimed.push(receipt)
          yield* publish(receipt)
        }
      }
      return { receipts: claimed, claimFrontier }
    })

    const ack = Effect.fn("TurnQueue.ack")(function* (
      lane: Lane,
      claimFrontier: MessageID | undefined,
      settled: Array<{ receiptId: string; outcome: ReceiptOutcome; messageId?: MessageID; error?: string }>,
    ) {
      const now = Date.now()
      if (claimFrontier) {
        yield* Effect.sync(() =>
          Database.use((db) => {
            db.insert(TurnLaneStateTable)
              .values({
                session_id: lane.sessionID,
                agent_id: lane.agentID,
                consumed_frontier: claimFrontier,
                input_revision: 0,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: [TurnLaneStateTable.session_id, TurnLaneStateTable.agent_id],
                set: { consumed_frontier: claimFrontier, time_updated: now },
              })
              .run()
          }),
        )
      }
      for (const s of settled) {
        const state: ReceiptState = s.outcome === "success" || s.outcome === "assistant_error" ? "settled" : "cancelled"
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(TurnReceiptTable)
              .set({
                state,
                outcome: s.outcome,
                message_id: s.messageId ?? null,
                error: s.error ?? null,
                consumed: s.outcome !== "never_ran",
                time_updated: now,
              })
              .where(eq(TurnReceiptTable.id, s.receiptId))
              .run(),
          ),
        )
        const row = yield* loadReceipt(s.receiptId)
        if (row) yield* publish(toReceipt(row))
      }
    })

    const extendClaim = Effect.fn("TurnQueue.extendClaim")(function* (lane: Lane, runId: number) {
      const claim = yield* claimNext(lane, runId)
      return claim?.receipts[0]
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
      const now = Date.now()
      const nextEpoch = (yield* getEpoch(sessionID)) + 1
      yield* Effect.sync(() =>
        Database.use((db) => {
          db.insert(TurnSessionEpochTable)
            .values({ session_id: sessionID, epoch: nextEpoch, time_updated: now })
            .onConflictDoUpdate({
              target: TurnSessionEpochTable.session_id,
              set: { epoch: nextEpoch, time_updated: now },
            })
            .run()
          db.update(TurnReceiptTable)
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
            .run()
        }),
      )
      log.info("turn-queue abort", { sessionID, epoch: nextEpoch, policy })
      return nextEpoch
    })

    const reconcileOnBoot = Effect.fn("TurnQueue.reconcileOnBoot")(function* (sessionID: SessionID) {
      const epoch = yield* getEpoch(sessionID)
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(TurnReceiptTable)
            .set({
              state: "cancelled",
              outcome: "never_ran",
              time_updated: now,
            })
            .where(
              and(
                eq(TurnReceiptTable.session_id, sessionID),
                inArray(TurnReceiptTable.state, ["accepted", "claimed"]),
                ne(TurnReceiptTable.epoch, epoch),
              ),
            )
            .run(),
        ),
      )
      // claimed without live run → never_ran (process died mid-claim)
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(TurnReceiptTable)
            .set({ state: "cancelled", outcome: "never_ran", time_updated: now })
            .where(and(eq(TurnReceiptTable.session_id, sessionID), eq(TurnReceiptTable.state, "claimed")))
            .run(),
        ),
      )
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
    return Service.of(impl)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.defaultLayer))

export * as TurnQueue from "./controller"
