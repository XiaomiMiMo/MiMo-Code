import { afterEach, describe, expect, spyOn } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { TurnQueue, turnQueueRef } from "../../src/turn-queue"
import type { Receipt } from "../../src/turn-queue/schema"
import { Database, eq } from "../../src/storage"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { TurnLaneStateTable, TurnLegacyBootstrapTable, TurnReceiptTable, TurnSessionEpochTable } from "../../src/turn-queue/turn-queue.sql"
import { schedulerRef } from "../../src/turn-queue/scheduler"
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

function freezeLegacy(sessionID: typeof MessageTable.$inferSelect.session_id) {
  Database.use((db) => db.insert(TurnLegacyBootstrapTable).values({
    session_id: sessionID,
    message_ids: db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all().map((row) => row.id),
    completed: false,
    time_updated: Date.now(),
  }).run())
}

describe("TurnQueue controller", () => {
  for (const keyed of [false, true]) {
    it.live(
      `concurrent ${keyed ? "idempotency-key" : "same-message"} admissions create one receipt and one input revision`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const tq = yield* TurnQueue.Service
          const session = yield* sessions.create({ title: "concurrent-admit" })
          const lane = { sessionID: session.id, agentID: "main" }
          const input = { lane, intent: { kind: "prompt" as const, messageID: MessageID.ascending() }, ...(keyed ? { idempotencyKey: "same-key" } : {}) }
          const use = Database.use
          const transaction = Database.transaction
          let competing: Receipt | undefined
          let entered = false
          const interfere = () => {
            if (entered) return
            entered = true
            competing = Effect.runSync(tq.admit(keyed ? { ...input, intent: { kind: "prompt", messageID: MessageID.ascending() } } : input))
          }
          const readCut = spyOn(Database, "use").mockImplementation((callback) => {
            const result = use(callback)
            if (result === undefined) interfere()
            return result
          })
          const transactionCut = spyOn(Database, "transaction").mockImplementation((callback, options) => {
            interfere()
            return transaction(callback, options)
          })
          try {
            const receipt = yield* tq.admit(input)
            expect(competing).toBeDefined()
            expect(receipt.id).toBe(competing!.id)
            expect((yield* tq.listAccepted(lane)).map((r) => r.id)).toEqual([receipt.id])
            expect(yield* tq.observeInput(lane, -1)).toBe(1)
          } finally {
            readCut.mockRestore()
            transactionCut.mockRestore()
          }
        }),
      ),
    )
  }

  for (const guarded of [false, true]) {
    it.live(
      `same-message reuse rechecks abort before ${guarded ? "guarded" : "ordinary"} admission`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const tq = yield* TurnQueue.Service
          const session = yield* sessions.create({ title: "reuse-after-abort" })
          const lane = { sessionID: session.id, agentID: "main" }
          const input = { lane, intent: { kind: "prompt" as const, messageID: MessageID.ascending() } }
          const original = yield* tq.admit(input)
          const use = Database.use
          const transaction = Database.transaction
          let aborted = false
          const abort = () => {
            if (aborted) return
            aborted = true
            Effect.runSync(tq.abortSession(session.id))
          }
          const readCut = spyOn(Database, "use").mockImplementation((callback) => {
            const result = use(callback)
            if (result && typeof result === "object" && "id" in result && result.id === original.id) abort()
            return result
          })
          const transactionCut = spyOn(Database, "transaction").mockImplementation((callback, options) => {
            abort()
            return transaction(callback, options)
          })
          try {
            const result = yield* tq.admit(input, guarded ? { expectedEpoch: 0 } : undefined).pipe(Effect.exit)
            expect(aborted).toBe(true)
            if (guarded) {
              expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
              expect(yield* tq.listAccepted(lane)).toEqual([])
            } else {
              expect(Exit.isSuccess(result)).toBe(true)
              if (Exit.isSuccess(result)) {
                expect(result.value.id).not.toBe(original.id)
                expect(result.value.epoch).toBe(1)
                expect(result.value.state).toBe("accepted")
              }
            }
            expect((yield* tq.getReceipt(original.id)).state).toBe("cancelled")
          } finally {
            readCut.mockRestore()
            transactionCut.mockRestore()
          }
        }),
      ),
    )
  }

  for (const transition of ["abort", "settle", "watermark"] as const) {
    it.live(
      `wake coalescing rechecks its candidate after concurrent ${transition}`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const tq = yield* TurnQueue.Service
          const session = yield* sessions.create({ title: `wake-coalesce-${transition}` })
          const lane = { sessionID: session.id, agentID: "main" }
          const original = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "a" } })
          const use = Database.use
          const transaction = Database.transaction
          let interrupted = false
          let previous: Receipt | undefined
          const interfere = () => {
            if (interrupted) return
            interrupted = true
            Effect.runSync(Effect.gen(function* () {
              if (transition === "abort") yield* tq.abortSession(session.id)
              if (transition === "settle") {
                const claim = yield* tq.claimNext(lane, 1)
                expect(claim?.receipts.map((r) => r.id)).toEqual([original.id])
                yield* tq.ack(lane, claim?.claimFrontier, [{ receiptId: original.id, outcome: "success" }], 1)
              }
              if (transition === "watermark") yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "z" } })
              previous = yield* tq.getReceipt(original.id)
            }))
          }
          const readCut = spyOn(Database, "use").mockImplementation((callback) => {
            const result = use(callback)
            if (Array.isArray(result) && result.some((row) => row.id === original.id && row.state === "accepted")) interfere()
            return result
          })
          const transactionCut = spyOn(Database, "transaction").mockImplementation((callback, options) => {
            // Atomic admission has no snapshot gap; put the competing commit before it instead.
            interfere()
            return transaction(callback, options)
          })
          try {
            const next = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "m" } })
            expect(interrupted).toBe(true)
            expect(next.state).toBe("accepted")
            expect(next.epoch).toBe(transition === "abort" ? 1 : 0)
            expect(next.intent).toEqual({ kind: "wake", receiverActorID: "main", inboxWatermark: transition === "watermark" ? "z" : "m" })
            if (transition === "watermark") {
              expect(next.id).toBe(original.id)
            } else {
              expect(next.id).not.toBe(original.id)
              expect(yield* tq.getReceipt(original.id)).toEqual(previous!)
            }
            expect((yield* tq.listAccepted(lane)).map((r) => r.id)).toEqual([next.id])
            expect((yield* tq.claimNext(lane, 2, next.epoch))?.receipts.map((r) => r.id)).toEqual([next.id])
          } finally {
            readCut.mockRestore()
            transactionCut.mockRestore()
          }
        }),
      ),
    )
  }

  it.live(
    "late admission below the consumed high-water mark still claims and settles without lowering it",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "late-admission-hole" })
        const lane = { sessionID: session.id, agentID: "main" }
        const u1 = MessageID.ascending()
        const u2 = MessageID.ascending()
        const second = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: u2 } })
        const firstClaim = yield* tq.claimNext(lane, 1)
        yield* tq.ack(lane, firstClaim?.claimFrontier, [{ receiptId: second.id, outcome: "success" }], 1)
        const first = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: u1 } })
        const lateClaim = yield* tq.claimNext(lane, 2)
        expect(lateClaim?.receipts.map((r) => r.id)).toEqual([first.id])
        expect(lateClaim?.claimFrontier).toBe(u2)
        yield* tq.ack(lane, lateClaim?.claimFrontier, [{ receiptId: first.id, outcome: "success" }], 2)
        expect((yield* tq.getReceipt(first.id)).state).toBe("settled")
        expect((yield* tq.getReceipt(first.id)).consumed).toBe(true)
        expect(yield* Effect.sync(() => Database.use((db) => db.select().from(TurnLaneStateTable)
          .where(eq(TurnLaneStateTable.session_id, session.id)).get()?.consumed_frontier))).toBe(u2)
      }),
    ),
  )

  it.live(
    "wake merge ignores suspended and noncurrent candidates and keeps expired guards rejected",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "wake-candidate-fences" })
        yield* tq.abortSession(session.id)
        for (const kind of ["suspended", "old-epoch", "future-epoch"] as const) {
          const lane = { sessionID: session.id, agentID: kind }
          const old = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: kind, inboxWatermark: "z" } })
          yield* Effect.sync(() => Database.use((db) => db.update(TurnReceiptTable)
            .set(kind === "suspended" ? { suspended: true } : { epoch: kind === "old-epoch" ? 0 : 2 })
            .where(eq(TurnReceiptTable.id, old.id)).run()))
          const before = yield* tq.getReceipt(old.id)
          const next = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: kind, inboxWatermark: "m" } }, { expectedEpoch: 1 })
          expect(next.id).not.toBe(old.id)
          expect(next.epoch).toBe(1)
          expect(next.state).toBe("accepted")
          expect(yield* tq.getReceipt(old.id)).toEqual(before)
        }
        const lane = { sessionID: session.id, agentID: "main" }
        const old = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "a" } })
        const transaction = Database.transaction
        let aborted = false
        const cut = spyOn(Database, "transaction").mockImplementation((callback, options) => {
          if (!aborted) {
            aborted = true
            Effect.runSync(tq.abortSession(session.id))
          }
          return transaction(callback, options)
        })
        try {
          const result = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "m" } }, { expectedEpoch: 1 }).pipe(Effect.exit)
          expect(aborted).toBe(true)
          expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
          expect((yield* tq.getReceipt(old.id)).intent).toEqual(old.intent)
          expect(yield* tq.listAccepted(lane)).toEqual([])
        } finally {
          cut.mockRestore()
        }
      }),
    ),
  )

  it.live(
    "ordinary admission reads its epoch atomically at insertion after a concurrent abort",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        for (const kind of ["prompt", "wake"] as const) {
          const session = yield* sessions.create({ title: `admit-epoch-${kind}` })
          const lane = { sessionID: session.id, agentID: "main" }
          const use = Database.use
          const transaction = Database.transaction
          let aborted = false
          const abort = () => {
            if (aborted) return
            aborted = true
            Effect.runSync(tq.abortSession(session.id))
          }
          const cut = spyOn(Database, "use").mockImplementation((callback) => {
            const result = use(callback)
            abort()
            return result
          })
          const transactionCut = spyOn(Database, "transaction").mockImplementation((callback, options) => {
            abort()
            return transaction(callback, options)
          })
          try {
            const receipt = yield* tq.admit({
              lane,
              intent: kind === "prompt" ? { kind, messageID: MessageID.ascending() } : { kind, receiverActorID: "main", inboxWatermark: "a" },
            })
            expect(aborted).toBe(true)
            expect(receipt.state).toBe("accepted")
            expect(receipt.epoch).toBe(1)
            expect((yield* tq.claimNext(lane, 1, 1))?.receipts.map((r) => r.id)).toEqual([receipt.id])
          } finally {
            cut.mockRestore()
            transactionCut.mockRestore()
          }
        }
      }),
    ),
  )

  it.live(
    "guarded admission cannot upgrade an expired expected epoch at insertion",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "admit-expired-guard" })
        const lane = { sessionID: session.id, agentID: "main" }
        const use = Database.use
        let aborted = false
        const cut = spyOn(Database, "use").mockImplementation((callback) => {
          const result = use(callback)
          if (!aborted) {
            aborted = true
            Effect.runSync(tq.abortSession(session.id))
          }
          return result
        })
        try {
          const result = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } }, { expectedEpoch: 0 }).pipe(Effect.exit)
          expect(aborted).toBe(true)
          expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
          expect(yield* tq.listAccepted(lane)).toEqual([])
          expect(yield* Effect.sync(() => use((db) => db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.session_id, session.id)).all()))).toEqual([])
        } finally {
          cut.mockRestore()
        }
      }),
    ),
  )

  it.live(
    "claim cannot revive a receipt when abort lands after the accepted snapshot",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "claim-abort-cut" })
        const lane = { sessionID: session.id, agentID: "main" }
        const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        const use = Database.use
        let aborted = false
        const abort = () => {
          aborted = true
          Effect.runSync(tq.abortSession(session.id))
        }
        const cut = spyOn(Database, "use").mockImplementation((callback) => {
          const result = use(callback)
          if (!aborted && Array.isArray(result) && result.some((row) => row.id === receipt.id && row.state === "accepted")) abort()
          return result
        })
        try {
          yield* tq.claimNext(lane, 1)
          // An atomic claim has no externally visible accepted-snapshot boundary.
          if (!aborted) abort()
          expect((yield* tq.getReceipt(receipt.id)).state).toBe("cancelled")
          expect(yield* tq.getEpoch(session.id)).toBe(1)
        } finally {
          cut.mockRestore()
        }
      }),
    ),
  )

  it.live(
    "claim cannot steal a receipt claimed by another run after the accepted snapshot",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "claim-owner-cut" })
        const lane = { sessionID: session.id, agentID: "main" }
        const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        const use = Database.use
        let competingClaim = false
        const cut = spyOn(Database, "use").mockImplementation((callback) => {
          const result = use(callback)
          if (!competingClaim && Array.isArray(result) && result.some((row) => row.id === receipt.id && row.state === "accepted")) {
            competingClaim = true
            use((db) => db.update(TurnReceiptTable).set({ state: "claimed", run_id: 2 }).where(eq(TurnReceiptTable.id, receipt.id)).run())
          }
          return result
        })
        try {
          const first = yield* tq.claimNext(lane, 1)
          if (competingClaim) {
            expect(first).toBeUndefined()
            expect((yield* tq.getReceipt(receipt.id)).runId).toBe(2)
          } else {
            expect(first?.receipts.map((r) => r.id)).toEqual([receipt.id])
            expect(yield* tq.claimNext(lane, 2)).toBeUndefined()
            expect((yield* tq.getReceipt(receipt.id)).runId).toBe(1)
          }
        } finally {
          cut.mockRestore()
        }
      }),
    ),
  )

  it.live(
    "expected epoch fences delayed initial claims and extensions even when run IDs repeat",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "claim-expected-epoch" })
        const lane = { sessionID: session.id, agentID: "main" }
        const epoch = yield* tq.getEpoch(session.id)
        yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(lane, 1, epoch)
        yield* tq.abortSession(session.id)
        const next = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        expect(yield* tq.claimNext(lane, 1, epoch)).toBeUndefined()
        expect((yield* tq.getReceipt(next.id)).state).toBe("accepted")
        yield* tq.claimNext(lane, 1, epoch + 1)
        const pending = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        expect(yield* tq.extendClaim(lane, 1, epoch)).toBeUndefined()
        expect((yield* tq.getReceipt(pending.id)).state).toBe("accepted")
        expect((yield* tq.extendClaim(lane, 1, epoch + 1))?.receipts.map((r) => r.id)).toEqual([pending.id])
        yield* tq.ack(lane, undefined, [next, pending].map((r) => ({ receiptId: r.id, outcome: "success" })), 1)
        const after = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        expect(yield* tq.extendClaim(lane, 1, epoch + 1)).toBeUndefined()
        expect((yield* tq.getReceipt(after.id)).state).toBe("accepted")
      }),
    ),
  )

  it.live(
    "claim requires exact current epoch and extension never lowers its frontier",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "claim-frontier-epoch" })
        const lane = { sessionID: session.id, agentID: "main" }
        const future = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* Effect.sync(() => Database.use((db) => db.update(TurnReceiptTable).set({ epoch: 1 })
          .where(eq(TurnReceiptTable.id, future.id)).run()))
        expect(yield* tq.claimNext(lane, 1)).toBeUndefined()
        const olderID = MessageID.ascending()
        const frontier = MessageID.ascending()
        yield* tq.admit({ lane, intent: { kind: "prompt", messageID: frontier } })
        yield* tq.claimNext(lane, 1)
        const older = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: olderID } })
        expect((yield* tq.extendClaim(lane, 1))?.claimFrontier).toBe(frontier)
        const wake = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "a" } })
        expect((yield* tq.extendClaim(lane, 1))?.claimFrontier).toBe(frontier)
        expect((yield* tq.getReceipt(older.id)).claimFrontier).toBe(frontier)
        expect((yield* tq.getReceipt(wake.id)).claimFrontier).toBe(frontier)
        expect((yield* tq.getReceipt(future.id)).state).toBe("accepted")
      }),
    ),
  )

  it.live(
    "extend requires a live same-lane owner and cannot cross abort epochs",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "extend-owner" })
        const lane = { sessionID: session.id, agentID: "main" }
        yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(lane, 1)
        const pending = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        expect(yield* tq.extendClaim(lane, 2)).toBeUndefined()
        const child = { ...lane, agentID: "child" }
        const childReceipt = yield* tq.admit({ lane: child, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        expect(yield* tq.extendClaim(child, 1)).toBeUndefined()
        expect((yield* tq.getReceipt(pending.id)).state).toBe("accepted")
        expect((yield* tq.getReceipt(childReceipt.id)).state).toBe("accepted")
        yield* tq.abortSession(session.id)
        const next = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        expect(yield* tq.extendClaim(lane, 1)).toBeUndefined()
        expect((yield* tq.getReceipt(next.id)).state).toBe("accepted")
      }),
    ),
  )

  it.live(
    "boot excludes hook, inbox, internal and empty users but repairs external text and attachment input",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "boot-external-only" })
        const lane = { sessionID: session.id, agentID: "main" }
        const kinds = ["hook", "inbox", "compaction", "ignored", "empty", "no-parts", "text", "file"] as const
        const messages = kinds.map((kind) => ({ kind, id: MessageID.ascending() }))
        yield* Effect.sync(() => Database.use((db) => {
          for (const message of messages) {
            const user = {
              role: "user" as const, time: { created: Date.now() }, agent: "build",
              model: { providerID: "test" as never, modelID: "test" as never },
              ...(message.kind === "hook" ? { provenance: { machine: "cron" } } : {}),
            }
            db.insert(MessageTable).values({ id: message.id, session_id: session.id, agent_id: "main", data: user }).run()
            if (message.kind === "no-parts") continue
            const data = message.kind === "file"
              ? { type: "file" as const, mime: "image/png", url: "data:image/png;base64,AA==" }
              : message.kind === "compaction" ? { type: "compaction" as const, auto: true }
              : { type: "text" as const, text: message.kind === "empty" ? "  " : "input", synthetic: message.kind === "inbox", ignored: message.kind === "ignored" }
            db.insert(PartTable).values({ id: PartID.ascending(), session_id: session.id, message_id: message.id, data }).run()
          }
        }))
        freezeLegacy(session.id)
        yield* tq.reconcileOnBoot(session.id)
        expect((yield* tq.listAccepted(lane)).map((r) => r.intent).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
          .toEqual(messages.filter((m) => m.kind === "text" || m.kind === "file").map((m) => ({ kind: "prompt", messageID: m.id })))
      }),
    ),
  )

  it.live(
    "boot does not replay legacy answered users without a receipt frontier or mistake assistant IDs for user boundaries",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "boot-legacy-history" })
        const lane = { sessionID: session.id, agentID: "main" }
        const earlier = MessageID.ascending()
        const answered = MessageID.ascending()
        const pending = MessageID.ascending()
        yield* Effect.sync(() => Database.use((db) => {
          for (const id of [earlier, answered, pending]) {
            const user = { role: "user" as const, time: { created: Date.now() }, agent: "build", model: { providerID: "test" as never, modelID: "test" as never } }
            db.insert(MessageTable).values({ id, session_id: session.id, agent_id: "main", data: user }).run()
            const text = { type: "text" as const, text: "external input" }
            db.insert(PartTable).values({ id: PartID.ascending(), session_id: session.id, message_id: id, data: text }).run()
          }
          for (const agentID of ["main", "child"]) {
            const assistant = {
              role: "assistant" as const, time: { created: Date.now(), completed: Date.now() }, parentID: agentID === "main" ? answered : pending,
              modelID: "test" as never, providerID: "test" as never, mode: "build", agent: "build", path: { cwd: "/tmp", root: "/tmp" },
              cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
            }
            db.insert(MessageTable).values({ id: MessageID.ascending(), session_id: session.id, agent_id: agentID, data: assistant }).run()
          }
        }))
        freezeLegacy(session.id)
        yield* tq.reconcileOnBoot(session.id)
        expect((yield* tq.listAccepted(lane)).map((r) => r.intent)).toEqual([{ kind: "prompt", messageID: pending }])
      }),
    ),
  )

  it.live(
    "boot repairs orphan main users once without reactivating terminal or pre-frontier messages",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "boot-orphans" })
        const lane = { sessionID: session.id, agentID: "main" }
        const past = MessageID.ascending()
        const cancelled = MessageID.ascending()
        const orphan = MessageID.ascending()
        const child = MessageID.ascending()
        yield* Effect.sync(() => Database.use((db) => {
          db.insert(MessageTable).values([past, cancelled, orphan, child].map((id) => ({
            id, session_id: session.id, agent_id: id === child ? "child" : "main",
            data: { role: "user" as const, time: { created: Date.now() }, agent: "build", model: { providerID: "test" as never, modelID: "test" as never } },
          }))).run()
          db.insert(PartTable).values([past, cancelled, orphan, child].map((message_id) => ({
            id: PartID.ascending(), session_id: session.id, message_id, data: { type: "text" as const, text: "external input" },
          }))).run()
          db.insert(TurnLaneStateTable).values({ session_id: session.id, agent_id: "main", consumed_frontier: past, time_updated: Date.now() }).run()
          const response = {
            role: "assistant" as const, time: { created: Date.now(), completed: Date.now() }, parentID: past,
            modelID: "test" as never, providerID: "test" as never, mode: "build", agent: "build", path: { cwd: "/tmp", root: "/tmp" },
            cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
          }
          db.insert(MessageTable).values({ id: MessageID.ascending(), session_id: session.id, agent_id: "main", data: response }).run()
        }))
        freezeLegacy(session.id)
        const old = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: cancelled } })
        yield* tq.abortSession(session.id, "keep-suspended")
        const kicks: string[] = []
        const scheduler = schedulerRef.current
        schedulerRef.current = { kick: (lane) => Effect.sync(() => { kicks.push(lane.agentID) }) }
        try {
          yield* tq.reconcileOnBoot(session.id)
          yield* tq.reconcileOnBoot(session.id)
          const accepted = yield* tq.listAccepted(lane)
          expect(accepted.map((r) => r.intent)).toEqual([{ kind: "prompt", messageID: orphan }])
          expect(accepted[0].epoch).toBe(1)
          expect((yield* tq.getReceipt(old.id)).state).toBe("cancelled")
          expect((yield* tq.listAccepted({ ...lane, agentID: "child" }))).toEqual([])
          expect(yield* tq.observeInput(lane, -1)).toBe(2)
          expect(kicks).toEqual(["main"])
          yield* Effect.gen(function* () {
            const restarted = yield* TurnQueue.Service
            yield* restarted.reconcileOnBoot(session.id)
            expect((yield* restarted.listAccepted(lane)).map((r) => r.id)).toEqual(accepted.map((r) => r.id))
          }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
        } finally {
          schedulerRef.current = scheduler
        }
      }),
    ),
  )

  it.live(
    "boot creates one replacement for a crashed wake but never for suspended or fenced wakes",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "boot-wake-replacement" })
        yield* tq.abortSession(session.id)
        const receipts: Receipt[] = []
        for (const agentID of ["main", "suspended", "fenced"]) {
          const lane = { sessionID: session.id, agentID }
          const receipt = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: agentID, inboxWatermark: "a" } })
          yield* tq.claimNext(lane, 1)
          receipts.push(receipt)
        }
        yield* Effect.sync(() => Database.use((db) => {
          db.update(TurnReceiptTable).set({ suspended: true }).where(eq(TurnReceiptTable.id, receipts[1].id)).run()
          db.update(TurnReceiptTable).set({ epoch: 0 }).where(eq(TurnReceiptTable.id, receipts[2].id)).run()
        }))
        yield* tq.reconcileOnBoot(session.id)
        const accepted = yield* tq.listAccepted(receipts[0].lane)
        expect(accepted).toHaveLength(1)
        expect(accepted[0].id).not.toBe(receipts[0].id)
        expect(accepted[0].intent).toEqual(receipts[0].intent)
        expect(accepted[0].runId).toBeUndefined()
        for (const receipt of receipts) {
          expect((yield* tq.getReceipt(receipt.id)).state).toBe("cancelled")
          expect((yield* tq.getReceipt(receipt.id)).outcome).toBe("never_ran")
        }
        for (const receipt of receipts.slice(1)) expect(yield* tq.listAccepted(receipt.lane)).toEqual([])
        yield* Effect.gen(function* () {
          const restarted = yield* TurnQueue.Service
          yield* restarted.reconcileOnBoot(session.id)
          expect(yield* restarted.listAccepted(receipts[0].lane)).toEqual(accepted)
        }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
      }),
    ),
  )

  it.live(
    "boot cancels crashed claims and requeues only current-epoch unsuspended wake once",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "boot-wakes" })
        const lane = { sessionID: session.id, agentID: "main" }
        const staleLane = { ...lane, agentID: "stale" }
        const stale = yield* tq.admit({ lane: staleLane, intent: { kind: "wake", receiverActorID: "stale", inboxWatermark: "old" } })
        yield* tq.claimNext(staleLane, 1)
        yield* tq.abortSession(session.id)
        const wake = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "z" } })
        const prompt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(lane, 2)
        const pendingWake = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "a" } })
        yield* tq.reconcileOnBoot(session.id)
        expect((yield* tq.getReceipt(wake.id)).state).toBe("cancelled")
        expect((yield* tq.getReceipt(prompt.id)).state).toBe("cancelled")
        expect((yield* tq.getReceipt(stale.id)).state).toBe("cancelled")
        const accepted = yield* tq.listAccepted(lane)
        expect(accepted).toHaveLength(1)
        expect(accepted[0].id).toBe(pendingWake.id)
        expect(accepted[0].intent).toEqual({ kind: "wake", receiverActorID: "main", inboxWatermark: "z" })
        expect(yield* tq.listAccepted(staleLane)).toEqual([])
        yield* tq.reconcileOnBoot(session.id)
        expect(yield* tq.listAccepted(lane)).toEqual(accepted)
      }),
    ),
  )

  it.live(
    "disposing the queue service clears its global reference to the closed bus and restores the live owner",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const session = yield* sessions.create({ title: "queue-scope" })
        const owner = yield* TurnQueue.Service
        yield* Effect.gen(function* () {
          const tq = yield* TurnQueue.Service
          expect(turnQueueRef.current).toBe(tq)
          yield* tq.admit({
            lane: { sessionID: session.id, agentID: "main" },
            intent: { kind: "prompt", messageID: MessageID.ascending() },
          })
        }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
        expect(turnQueueRef.current).toBe(owner)
        const lane = { sessionID: session.id, agentID: "main" }
        const receipt = yield* turnQueueRef.current!.admit({
          lane,
          intent: { kind: "prompt", messageID: MessageID.ascending() },
        })
        const claim = yield* turnQueueRef.current!.claimNext(lane, 1)
        expect(claim?.receipts.map((item) => item.id)).toContain(receipt.id)
        yield* turnQueueRef.current!.ack(lane, claim?.claimFrontier,
          claim!.receipts.map((item) => ({ receiptId: item.id, outcome: "success" as const })), 1)
        expect((yield* owner.getReceipt(receipt.id)).state).toBe("settled")
      }),
    ),
  )

  it.live(
    "disposing an older queue service preserves the newer owner without restoring expired references",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const owner = yield* TurnQueue.Service
        const firstReady = yield* Deferred.make<TurnQueue.Interface>()
        const first = yield* Effect.gen(function* () {
          const tq = yield* TurnQueue.Service
          yield* Deferred.succeed(firstReady, tq)
          yield* Effect.never
        }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)), Effect.forkChild)
        const firstQueue = yield* Deferred.await(firstReady)
        expect(turnQueueRef.current).toBe(firstQueue)
        const secondReady = yield* Deferred.make<TurnQueue.Interface>()
        const second = yield* Effect.gen(function* () {
          const tq = yield* TurnQueue.Service
          yield* Deferred.succeed(secondReady, tq)
          yield* Effect.never
        }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)), Effect.forkChild)
        const secondQueue = yield* Deferred.await(secondReady)
        expect(secondQueue).not.toBe(firstQueue)
        expect(turnQueueRef.current).toBe(secondQueue)
        yield* Fiber.interrupt(first)
        expect(turnQueueRef.current).toBe(secondQueue)
        yield* Fiber.interrupt(second)
        expect(turnQueueRef.current).toBe(owner)
        const sessions = yield* SessionNs.Service
        const session = yield* sessions.create({ title: "surviving-queue-owner" })
        const receipt = yield* turnQueueRef.current!.admit({
          lane: { sessionID: session.id, agentID: "main" },
          intent: { kind: "prompt", messageID: MessageID.ascending() },
        })
        expect((yield* owner.getReceipt(receipt.id)).state).toBe("accepted")
      }),
    ),
  )

  it.live(
    "disposing a queue scope preserves an external override to a live controller",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const owner = yield* TurnQueue.Service
        const sessions = yield* SessionNs.Service
        const session = yield* sessions.create({ title: "queue-override" })
        yield* Effect.gen(function* () {
          const temporary = yield* TurnQueue.Service
          expect(turnQueueRef.current).toBe(temporary)
          turnQueueRef.current = owner
        }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
        expect(turnQueueRef.current).toBe(owner)
        const lane = { sessionID: session.id, agentID: "main" }
        const receipt = yield* turnQueueRef.current!.admit({
          lane,
          intent: { kind: "prompt", messageID: MessageID.ascending() },
        })
        expect((yield* turnQueueRef.current!.claimNext(lane, 1))?.receipts.map((item) => item.id)).toEqual([receipt.id])
      }),
    ),
  )

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
    "concurrent boot recovery completes once per session before live claims",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "boot-concurrent" })
        const stale = yield* tq.admit({
          lane: { sessionID: session.id, agentID: "stale" },
          intent: { kind: "prompt", messageID: MessageID.ascending() },
        })
        yield* tq.claimNext(stale.lane, 1)
        const live = yield* Effect.all(
          Array.from({ length: 16 }, (_, i) => Effect.gen(function* () {
            yield* tq.reconcileOnBoot(session.id)
            expect((yield* tq.getReceipt(stale.id)).state).toBe("cancelled")
            const lane = { sessionID: session.id, agentID: `agent-${i}` }
            const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
            yield* tq.claimNext(lane, i + 2)
            return receipt
          })),
          { concurrency: "unbounded" },
        )
        yield* tq.reconcileOnBoot(session.id)
        for (const receipt of live) expect((yield* tq.getReceipt(receipt.id)).state).toBe("claimed")

        const other = yield* sessions.create({ title: "boot-other" })
        const lane = { sessionID: other.id, agentID: "main" }
        const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(lane, 1)
        yield* tq.reconcileOnBoot(other.id)
        expect((yield* tq.getReceipt(receipt.id)).state).toBe("cancelled")
      }),
    ),
  )

  it.live(
    "ack rejects unclaimed receipts, foreign lanes and sessions, and mismatched runs without advancing frontier",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "ack-fences" })
        const other = yield* sessions.create({ title: "ack-other" })
        const lane = { sessionID: session.id, agentID: "main" }
        const child = { sessionID: session.id, agentID: "child" }
        const foreign = { sessionID: other.id, agentID: "main" }
        const wrongRun = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(lane, 7)
        const childReceipt = yield* tq.admit({ lane: child, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(child, 1)
        const foreignReceipt = yield* tq.admit({ lane: foreign, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(foreign, 1)
        const mid = MessageID.ascending()
        const accepted = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: mid } })
        const before = yield* Effect.all([wrongRun, childReceipt, foreignReceipt, accepted].map((r) => tq.getReceipt(r.id)))
        yield* tq.ack(lane, mid, before.map((r) => ({ receiptId: r.id, outcome: "success" })), 1)
        yield* tq.ack(lane, mid, [], 1)
        for (const receipt of before) expect(yield* tq.getReceipt(receipt.id)).toEqual(receipt)
        expect((yield* tq.claimNext(lane, 8))?.receipts.map((r) => r.id)).toEqual([accepted.id])
        yield* tq.ack(lane, before[0].claimFrontier, [{ receiptId: wrongRun.id, outcome: "success" }], 7)
        expect((yield* tq.getReceipt(wrongRun.id)).state).toBe("settled")
      }),
    ),
  )

  it.live(
    "late ack after abort cannot revive a cancelled receipt or consume re-admitted input",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "ack-abort" })
        const lane = { sessionID: session.id, agentID: "main" }
        const mid = MessageID.ascending()
        const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: mid } })
        yield* tq.claimNext(lane, 1)
        yield* tq.abortSession(session.id)
        const cancelled = yield* tq.getReceipt(receipt.id)
        yield* tq.ack(lane, mid, [{ receiptId: receipt.id, outcome: "success", messageId: mid }], 1)
        expect(yield* tq.getReceipt(receipt.id)).toEqual(cancelled)
        const retry = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: mid } })
        expect((yield* tq.claimNext(lane, 2))?.receipts.map((r) => r.id)).toEqual([retry.id])
      }),
    ),
  )

  it.live(
    "ack requires the current epoch even when a receipt remains claimed",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "ack-epoch" })
        const lane = { sessionID: session.id, agentID: "main" }
        const mid = MessageID.ascending()
        const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: mid } })
        yield* tq.claimNext(lane, 1)
        const claimed = yield* tq.getReceipt(receipt.id)
        yield* Effect.sync(() => Database.use((db) => db.insert(TurnSessionEpochTable)
          .values({ session_id: session.id, epoch: 1, time_updated: Date.now() }).run()))
        yield* tq.ack(lane, mid, [{ receiptId: receipt.id, outcome: "success" }], 1)
        expect(yield* tq.getReceipt(receipt.id)).toEqual(claimed)
      }),
    ),
  )

  it.live(
    "out-of-order acks keep the consumed frontier monotonic and duplicate acks cannot change outcomes",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "ack-monotonic" })
        const lane = { sessionID: session.id, agentID: "main" }
        const firstID = MessageID.ascending()
        const first = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: firstID } })
        yield* tq.claimNext(lane, 1)
        const lastID = MessageID.ascending()
        const last = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: lastID } })
        yield* tq.claimNext(lane, 2)
        yield* tq.ack(lane, lastID, [{ receiptId: last.id, outcome: "success" }], 2)
        yield* tq.ack(lane, firstID, [{ receiptId: first.id, outcome: "success" }], 1)
        const settled = yield* tq.getReceipt(last.id)
        yield* tq.ack(lane, lastID, [{ receiptId: last.id, outcome: "never_ran" }], 2)
        expect(yield* tq.getReceipt(last.id)).toEqual(settled)
        const duplicate = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: lastID } })
        expect(duplicate).toEqual(settled)
        expect(yield* tq.observeInput(lane, -1)).toBe(2)
        expect(yield* tq.listAccepted(lane)).toEqual([])
        expect(yield* Effect.sync(() => Database.use((db) => db.select().from(TurnReceiptTable)
          .where(eq(TurnReceiptTable.session_id, session.id)).all().length))).toBe(2)
        expect(yield* tq.claimNext(lane, 3)).toBeUndefined()
      }),
    ),
  )

  it.live(
    "same-epoch cancelled receipts cannot be revived and never-ran acks do not advance frontier",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "ack-cancelled" })
        const lane = { sessionID: session.id, agentID: "main" }
        const mid = MessageID.ascending()
        const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: mid } })
        yield* tq.claimNext(lane, 1)
        yield* tq.ack(lane, mid, [{ receiptId: receipt.id, outcome: "never_ran" }], 1)
        const cancelled = yield* tq.getReceipt(receipt.id)
        yield* tq.ack(lane, mid, [{ receiptId: receipt.id, outcome: "success" }], 1)
        expect(yield* tq.getReceipt(receipt.id)).toEqual(cancelled)
        const retry = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: mid } })
        expect((yield* tq.claimNext(lane, 2))?.receipts.map((r) => r.id)).toEqual([retry.id])
      }),
    ),
  )

  it.live(
    "extendClaim returns the entire batch and frontier so every extended receipt can settle",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const session = yield* sessions.create({ title: "extend-batch" })
        const lane = { sessionID: session.id, agentID: "main" }
        yield* tq.reconcileOnBoot(session.id)
        const initial = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        yield* tq.claimNext(lane, 1)
        yield* tq.reconcileOnBoot(session.id)
        const first = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: MessageID.ascending() } })
        const lastID = MessageID.ascending()
        const last = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: lastID } })
        const wake = yield* tq.admit({ lane, intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "inbox-1" } })
        const extended = yield* tq.extendClaim(lane, 1)
        expect(extended?.receipts.map((r) => r.id).sort()).toEqual([first.id, last.id, wake.id].sort())
        expect(extended?.claimFrontier).toBe(lastID)
        for (const receipt of extended!.receipts) {
          expect(receipt.state).toBe("claimed")
          expect(receipt.runId).toBe(1)
        }
        expect(yield* tq.extendClaim(lane, 1)).toBeUndefined()
        yield* tq.ack(lane, extended!.claimFrontier,
          [initial, ...extended!.receipts].map((r) => ({ receiptId: r.id, outcome: "success" })), 1)
        for (const receipt of [initial, first, last, wake]) expect((yield* tq.getReceipt(receipt.id)).state).toBe("settled")
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
