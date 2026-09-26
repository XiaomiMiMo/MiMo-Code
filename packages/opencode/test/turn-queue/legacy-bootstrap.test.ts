import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Effect, Exit, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { Database, eq, sql } from "../../src/storage"
import { TurnQueue } from "../../src/turn-queue/controller"
import { TurnLegacyBootstrapTable, TurnReceiptTable } from "../../src/turn-queue/turn-queue.sql"
import { schedulerRef } from "../../src/turn-queue/scheduler"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer, Bus.layer, TurnQueue.defaultLayer))

afterEach(async () => {
  await Instance.disposeAll()
})

function user(sessionID: SessionID, options: {
  id?: MessageID
  agentID?: string
  synthetic?: boolean
  ignored?: boolean
  hook?: boolean
  text?: string
  file?: boolean
  admission?: { epoch: number; ready: true; dispatch: boolean }
} = {}) {
  const id = options.id ?? MessageID.ascending()
  Database.use((db) => {
    const data = {
      role: "user" as const, time: { created: Date.now() }, agent: "build",
      model: { providerID: "test" as never, modelID: "test" as never },
      ...(options.hook ? { provenance: { machine: "cron" } } : {}),
      ...(options.admission ? { queueAdmission: options.admission } : {}),
    }
    db.insert(MessageTable).values({ id, session_id: sessionID, agent_id: options.agentID ?? "main", data }).run()
    const part = options.file
      ? { type: "file" as const, mime: "image/png", url: "data:image/png;base64,AA==" }
      : { type: "text" as const, text: options.text ?? "legacy input", synthetic: options.synthetic, ignored: options.ignored }
    db.insert(PartTable).values({ id: PartID.ascending(), session_id: sessionID, message_id: id, data: part }).run()
  })
  return id
}

function assistant(sessionID: SessionID, parentID: MessageID, error = false) {
  const id = MessageID.ascending()
  const data = {
    role: "assistant" as const, time: { created: Date.now(), completed: Date.now() }, parentID,
    modelID: "test" as never, providerID: "test" as never, mode: "build", agent: "build",
    path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...(error ? { error: { name: "MessageAbortedError" as const, data: { message: "interrupted" } } } : {}),
  }
  Database.use((db) => db.insert(MessageTable).values({ id, session_id: sessionID, agent_id: "main", data }).run())
  return id
}

function freeze(sessionID: SessionID) {
  Database.use((db) => db.insert(TurnLegacyBootstrapTable).values({
    session_id: sessionID,
    message_ids: db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all().map((row) => row.id),
    completed: false,
    time_updated: Date.now(),
  }).run())
}

function receipts(sessionID: SessionID) {
  return Database.use((db) => db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.session_id, sessionID)).all())
}

describe("one-time legacy bootstrap", () => {
  it.live("frozen batch prefixes become settled receipts; pending external members are accepted; holes stay excluded", provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const queue = yield* TurnQueue.Service
      const session = yield* sessions.create({ title: "legacy-frozen-batch" })
      const first = user(session.id)
      const reservedHole = MessageID.ascending()
      const lastAnswered = user(session.id)
      const pending = user(session.id)
      const attachment = user(session.id, { file: true })
      const retained = user(session.id)
      const response = assistant(session.id, lastAnswered)
      const internal = [
        user(session.id, { synthetic: true }),
        user(session.id, { hook: true }),
        user(session.id, { ignored: true }),
        user(session.id, { text: "  " }),
        user(session.id, { agentID: "child" }),
      ]
      const existing = yield* queue.admit({ lane: { sessionID: session.id, agentID: "main" }, intent: { kind: "prompt", messageID: retained } })
      Database.use((db) => db.update(TurnReceiptTable).set({ state: "cancelled", outcome: "never_ran" })
        .where(eq(TurnReceiptTable.id, existing.id)).run())
      const beforeExisting = receipts(session.id)[0]
      freeze(session.id)
      user(session.id, { id: reservedHole })
      const laterHole = user(session.id)
      assistant(session.id, laterHole)

      yield* queue.reconcileOnBoot(session.id)
      const rows = receipts(session.id)
      const forUser = (id: MessageID) => rows.find((row) => row.intent.kind === "prompt" && row.intent.messageID === id)
      for (const id of [first, lastAnswered]) {
        expect(forUser(id)).toMatchObject({ state: "settled", consumed: true, outcome: "success", message_id: response })
      }
      for (const id of [pending, attachment]) expect(forUser(id)).toMatchObject({ state: "accepted", consumed: false })
      for (const id of [reservedHole, laterHole, ...internal]) expect(forUser(id)).toBeUndefined()
      expect(forUser(retained)).toEqual(beforeExisting)
      expect(rows).toHaveLength(5)
      expect(Database.use((db) => db.select().from(TurnLegacyBootstrapTable)
        .where(eq(TurnLegacyBootstrapTable.session_id, session.id)).get())?.completed).toBe(true)
      yield* Effect.gen(function* () {
        const restarted = yield* TurnQueue.Service
        yield* restarted.reconcileOnBoot(session.id)
        expect(receipts(session.id)).toEqual(rows)
      }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
    }),
  ))

  it.live("a new session without a migration snapshot never adopts unreceipted messages, including on restart", provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "post-queue-holes" })
      const queue = yield* TurnQueue.Service
      const hole = user(session.id)
      assistant(session.id, hole)
      yield* queue.reconcileOnBoot(session.id)
      expect(receipts(session.id)).toEqual([])
      user(session.id)
      yield* Effect.gen(function* () {
        yield* (yield* TurnQueue.Service).reconcileOnBoot(session.id)
        expect(receipts(session.id)).toEqual([])
      }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
    }),
  ))

  it.live("receipt bootstrap and completion marker roll back together, then retry once", provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "legacy-rollback" })
      const queue = yield* TurnQueue.Service
      const answered = user(session.id)
      const response = assistant(session.id, answered, true)
      freeze(session.id)
      Database.use((db) => db.run(sql.raw("CREATE TRIGGER legacy_bootstrap_test_failure BEFORE UPDATE ON turn_legacy_bootstrap BEGIN SELECT RAISE(ABORT, 'bootstrap rollback'); END")))
      yield* Effect.addFinalizer(() => Effect.sync(() => Database.use((db) => db.run(sql.raw("DROP TRIGGER IF EXISTS legacy_bootstrap_test_failure")))))
      const failed = yield* queue.reconcileOnBoot(session.id).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(receipts(session.id)).toEqual([])
      expect(Database.use((db) => db.select().from(TurnLegacyBootstrapTable)
        .where(eq(TurnLegacyBootstrapTable.session_id, session.id)).get())?.completed).toBe(false)
      Database.use((db) => db.run(sql.raw("DROP TRIGGER legacy_bootstrap_test_failure")))
      yield* queue.reconcileOnBoot(session.id)
      expect(receipts(session.id)).toHaveLength(1)
      expect(receipts(session.id)[0]).toMatchObject({ state: "settled", consumed: true, outcome: "assistant_error", message_id: response })
    }),
  ))
})

describe("marked admission crash-gap recovery", () => {
  it.live("ready current-epoch messages are accepted, old epochs are cancelled, and existing receipts are preserved", provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "marked-admission-gap" })
      const queue = yield* TurnQueue.Service
      const lane = { sessionID: session.id, agentID: "main" }
      const old = user(session.id, { admission: { epoch: 0, ready: true, dispatch: true } })
      yield* queue.abortSession(session.id)
      const current = user(session.id, { admission: { epoch: 1, ready: true, dispatch: true } })
      const retained = user(session.id, { admission: { epoch: 1, ready: true, dispatch: true } })
      const existing = yield* queue.admit({ lane, intent: { kind: "prompt", messageID: retained } })
      Database.use((db) => db.update(TurnReceiptTable).set({ state: "cancelled", outcome: "never_ran" })
        .where(eq(TurnReceiptTable.id, existing.id)).run())
      const unchanged = receipts(session.id)[0]
      const unready = user(session.id, { admission: { epoch: 1, ready: true, dispatch: true } })
      Database.use((db) => db.update(MessageTable).set({ data: sql`json_set(${MessageTable.data}, '$.queueAdmission.ready', 0)` })
        .where(eq(MessageTable.id, unready)).run())
      const unknown = user(session.id)
      yield* queue.reconcileOnBoot(session.id)
      const rows = receipts(session.id)
      expect(rows).toHaveLength(3)
      expect(rows.find((row) => row.intent.messageID === old)).toMatchObject({ state: "cancelled", outcome: "never_ran", consumed: false, epoch: 0 })
      expect(rows.find((row) => row.intent.messageID === current)).toMatchObject({ state: "accepted", consumed: false, epoch: 1 })
      expect(rows.find((row) => row.id === existing.id)).toEqual(unchanged)
      expect(rows.some((row) => row.intent.messageID === unready || row.intent.messageID === unknown)).toBe(false)
      expect(yield* queue.observeInput(lane, -1)).toBe(2)
      yield* Effect.gen(function* () {
        yield* (yield* TurnQueue.Service).reconcileOnBoot(session.id)
        expect(receipts(session.id)).toEqual(rows)
      }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
    }),
  ))

  it.live("dispatch=false stays accepted without any boot kick, including later restarts", provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "marked-no-dispatch" })
      const queue = yield* TurnQueue.Service
      const lane = { sessionID: session.id, agentID: "main" }
      const silent = user(session.id, { admission: { epoch: 0, ready: true, dispatch: false } })
      const kicks: string[] = []
      const scheduler = schedulerRef.current
      schedulerRef.current = { kick: (lane) => Effect.sync(() => { kicks.push(lane.sessionID) }) }
      yield* Effect.addFinalizer(() => Effect.sync(() => { schedulerRef.current = scheduler }))
      yield* queue.reconcileOnBoot(session.id)
      expect((yield* queue.listAccepted(lane)).map((row) => row.intent)).toEqual([{ kind: "prompt", messageID: silent }])
      expect(kicks).toEqual([])
      yield* Effect.gen(function* () {
        yield* (yield* TurnQueue.Service).reconcileOnBoot(session.id)
        expect(kicks).toEqual([])
        expect(receipts(session.id)).toHaveLength(1)
      }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
      user(session.id, { admission: { epoch: 0, ready: true, dispatch: true } })
      yield* Effect.gen(function* () {
        yield* (yield* TurnQueue.Service).reconcileOnBoot(session.id)
        expect(kicks).toEqual([session.id])
        expect(receipts(session.id)).toHaveLength(2)
      }).pipe(Effect.provide(Layer.fresh(TurnQueue.defaultLayer)))
    }),
  ))
})

const originalMigration = await Bun.file(new URL("../../migration/20260920000000_turn_queue/migration.sql", import.meta.url)).text()
const bootstrapMigration = await Bun.file(new URL("../../migration/20260924000000_turn_legacy_bootstrap/migration.sql", import.meta.url)).text()

function preQueueDatabase() {
  const db = new SQLite(":memory:")
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL);")
  db.exec("INSERT INTO session VALUES ('legacy'); INSERT INTO message VALUES ('old-user', 'legacy', 'main'), ('old-assistant', 'legacy', 'main'), ('child-user', 'legacy', 'child');")
  return db
}

describe("legacy bootstrap SQL upgrade", () => {
  test("original queue migration freezes actual main members and the forward migration preserves that snapshot", () => {
    const db = preQueueDatabase()
    try {
      db.exec(originalMigration)
      db.exec("INSERT INTO message VALUES ('post-queue-hole', 'legacy', 'main')")
      db.exec(bootstrapMigration)
      const row = db.query<{ message_ids: string; completed: number }, []>("SELECT message_ids, completed FROM turn_legacy_bootstrap").get()!
      expect(JSON.parse(row.message_ids).sort()).toEqual(["old-assistant", "old-user"])
      expect(row.completed).toBe(0)
      expect(db.query<{ name: string }, []>("PRAGMA table_info(turn_receipt)").all().map((row) => row.name)).toContain("delivery_message_id")
    } finally {
      db.close()
    }
  })

  for (const used of [false, true]) {
    test(`already-applied development queue (${used ? "used" : "empty"}) seals sessions instead of guessing legacy membership`, () => {
      const db = preQueueDatabase()
      try {
        const boundary = originalMigration.indexOf("CREATE TABLE `turn_legacy_bootstrap`")
        expect(boundary).toBeGreaterThan(0)
        db.exec(originalMigration.slice(0, boundary))
        if (used) db.exec("INSERT INTO turn_session_epoch VALUES ('legacy', 1, 0)")
        db.exec("INSERT INTO message VALUES ('post-queue-hole', 'legacy', 'main')")
        db.exec(bootstrapMigration)
        expect(db.query("SELECT message_ids, completed FROM turn_legacy_bootstrap").get()).toEqual({ message_ids: "[]", completed: 1 })
        db.exec("INSERT INTO turn_receipt (id, session_id, state, intent, epoch, time_created, time_updated) VALUES ('receipt', 'legacy', 'accepted', '{}', 0, 0, 0)")
        expect(db.query("SELECT delivery_message_id FROM turn_receipt").get()).toEqual({ delivery_message_id: null })
      } finally {
        db.close()
      }
    })
  }
})
