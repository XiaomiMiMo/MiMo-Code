import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Hono } from "hono"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { SessionRunState } from "../../src/session/run-state"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ErrorMiddleware } from "../../src/server/middleware"
import { InstanceMiddleware } from "../../src/server/routes/instance/middleware"
import { SessionRoutes } from "../../src/server/routes/instance/session"
import { SyncRoutes } from "../../src/server/routes/instance/sync"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { Database, eq } from "../../src/storage"
import { SyncEvent } from "../../src/sync"
import { EventSequenceTable, EventTable } from "../../src/sync/event.sql"
import { schedulerRef } from "../../src/turn-queue/scheduler"
import * as QueueSync from "../../src/turn-queue/sync"
import { TurnLaneStateTable, TurnReceiptTable, TurnSessionEpochTable } from "../../src/turn-queue/turn-queue.sql"
import { tmpdir } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"

function client(directory: string, workspaceID: WorkspaceID) {
  const app = new Hono()
    .onError(ErrorMiddleware)
    .use(InstanceMiddleware(workspaceID))
    .route("/session", SessionRoutes())
    .route("/sync", SyncRoutes())
  const post = (route: string, body: unknown) =>
    app.request(`${route}?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  return { post, directory, workspaceID }
}

type Http = ReturnType<typeof client>

function fixture(run: (http: Http, template: Session.Info, llm: TestLLMServer["Service"]) => Promise<void>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* Effect.promise(async () => {
        await using tmp = await tmpdir({
          git: true,
          config: {
            enabled_providers: ["alibaba"],
            provider: { alibaba: { options: { apiKey: "test-key", baseURL: llm.url } } },
            model: "alibaba/qwen-plus",
            small_model: "alibaba/qwen-plus",
            agent: { build: { model: "alibaba/qwen-plus" } },
          },
        })
        try {
          const http = client(tmp.path, WorkspaceID.ascending())
          const response = await http.post("/session", { title: "restore target fixture" })
          expect(response.status).toBe(200)
          const template = (await response.json()) as Session.Info
          expect(template.workspaceID).toBe(http.workspaceID)
          await run(http, template, llm)
        } finally {
          await Instance.disposeAll()
        }
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}

function envelope(http: Http, template: Session.Info) {
  const sessionID = SessionID.descending()
  const info: Session.Info = {
    ...template,
    id: sessionID,
    title: "restored complete session",
    workspaceID: http.workspaceID,
  }
  const events: SyncEvent.SerializedEvent[] = []
  const append = (type: string, data: Record<string, unknown>) => {
    const seq = events.length
    events.push({ id: `${sessionID}-event-${seq}`, aggregateID: sessionID, seq, type, data })
  }
  append(SyncEvent.versionedType(Session.Event.Created.type, Session.Event.Created.version), { sessionID, info })
  const users = ["accepted", "claimed", "settled", "cancelled", "rejected"].map((state) => {
    const message: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID,
      agentID: "main",
      role: "user",
      time: { created: 100 },
      agent: "build",
      model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
      queueAdmission: { epoch: 7, ready: true, dispatch: true },
    }
    const part: MessageV2.TextPart = {
      id: PartID.ascending(),
      sessionID,
      messageID: message.id,
      type: "text",
      text: `restore ${state} input`,
    }
    append(SyncEvent.versionedType(MessageV2.Event.Updated.type, MessageV2.Event.Updated.version), {
      sessionID,
      info: message,
    })
    append(SyncEvent.versionedType(MessageV2.Event.PartUpdated.type, MessageV2.Event.PartUpdated.version), {
      sessionID,
      part,
      time: 100,
    })
    return { info: message, parts: [part] }
  })
  const assistants = ["first delivery", "final answer"].map((text) => {
    const message: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID,
      agentID: "main",
      role: "assistant",
      parentID: users[2].info.id,
      time: { created: 101, completed: 102 },
      providerID: ProviderID.make("alibaba"),
      modelID: ModelID.make("qwen-plus"),
      mode: "build",
      agent: "build",
      path: { cwd: http.directory, root: http.directory },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    }
    const part: MessageV2.TextPart = { id: PartID.ascending(), sessionID, messageID: message.id, type: "text", text }
    append(SyncEvent.versionedType(MessageV2.Event.Updated.type, MessageV2.Event.Updated.version), {
      sessionID,
      info: message,
    })
    append(SyncEvent.versionedType(MessageV2.Event.PartUpdated.type, MessageV2.Event.PartUpdated.version), {
      sessionID,
      part,
      time: 102,
    })
    return { info: message, parts: [part] }
  })
  const queueSnapshot: QueueSync.Snapshot = {
    version: 1,
    sessionID,
    receipts: (["accepted", "claimed", "settled", "cancelled", "rejected"] as const).map((state, index) => ({
      id: `${sessionID}-receipt-${index}`,
      session_id: sessionID,
      agent_id: "main",
      state: state === "claimed" ? "cancelled" : state,
      intent: { kind: "prompt", messageID: users[index].info.id },
      epoch: state === "cancelled" ? 6 : 7,
      run_id: state === "claimed" || state === "settled" ? 31 + index : null,
      claim_frontier: state === "claimed" || state === "settled" ? users[index].info.id : null,
      consumed: state === "settled",
      suspended: state === "cancelled",
      outcome: state === "settled" ? "success" : state === "cancelled" || state === "claimed" ? "never_ran" : null,
      message_id: state === "settled" ? assistants[1].info.id : null,
      delivery_message_id: state === "settled" ? assistants[0].info.id : null,
      error: state === "rejected" ? "fixture rejection" : null,
      idempotency_key: users[index].info.id,
      time_created: 100,
      time_updated: 102,
    })),
    lanes: [
      {
        session_id: sessionID,
        agent_id: "main",
        consumed_frontier: users[2].info.id,
        input_revision: 9,
        time_updated: 102,
      },
      { session_id: sessionID, agent_id: "worker", consumed_frontier: null, input_revision: 3, time_updated: 101 },
    ],
    epoch: { session_id: sessionID, epoch: 7, time_updated: 102 },
    bootstrap: { session_id: sessionID, message_ids: [users[2].info.id], completed: true, time_updated: 99 },
  }
  return {
    payload: {
      directory: http.directory,
      workspaceID: http.workspaceID,
      events,
      finalSeq: events.length - 1,
      queueSnapshot,
    },
    info,
    users,
    assistants,
  }
}

function state(sessionID: SessionID) {
  return Database.use((db) => ({
    session: db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
    messages: db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .orderBy(MessageTable.id)
      .all(),
    parts: db.select().from(PartTable).where(eq(PartTable.session_id, sessionID)).orderBy(PartTable.id).all(),
    events: db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).orderBy(EventTable.seq).all(),
    sequence: db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get(),
    actors: db
      .select()
      .from(ActorRegistryTable)
      .where(eq(ActorRegistryTable.session_id, sessionID))
      .orderBy(ActorRegistryTable.actor_id)
      .all(),
    queue: QueueSync.capture(sessionID, db),
  }))
}

async function restored(http: Http, data: ReturnType<typeof envelope>) {
  const response = await http.post("/sync/replay", data.payload)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ sessionID: data.info.id })
}

async function rejected(http: Http, payload: unknown, status: 400 | 409 = 400) {
  const response = await http.post("/sync/replay", payload)
  expect(response.status).toBe(status)
}

describe("POST /sync/replay atomic session restore", () => {
  test(
    "restores complete history and all queue state without publishing or kicking execution",
    () =>
      fixture(async (http, template, llm) => {
        const data = envelope(http, template)
        const emitted: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => {
          if (
            event.payload.syncEvent?.aggregateID === data.info.id ||
            event.payload.properties?.sessionID === data.info.id
          )
            emitted.push(event)
        }
        const scheduler = schedulerRef.current
        expect(scheduler).toBeDefined()
        const kick = spyOn(scheduler!, "kick")
        GlobalBus.on("event", listener)
        try {
          await restored(http, data)
          const saved = state(data.info.id)
          expect(Session.fromRow(saved.session!)).toEqual(data.info)
          expect(saved.messages).toHaveLength(data.users.length + data.assistants.length)
          expect(saved.parts).toHaveLength(data.users.length + data.assistants.length)
          for (const message of [...data.users, ...data.assistants])
            expect(MessageV2.get({ sessionID: data.info.id, messageID: message.info.id })).toEqual(message)
          expect(saved.queue).toEqual(data.payload.queueSnapshot)
          expect(
            saved.events.map((event) => ({
              id: event.id,
              aggregateID: event.aggregate_id,
              seq: event.seq,
              type: event.type,
              data: event.data,
            })),
          ).toEqual(data.payload.events)
          expect(saved.sequence?.seq).toBe(data.payload.finalSeq)
          expect(kick).not.toHaveBeenCalled()
          expect(await Effect.runPromise(llm.calls)).toBe(0)
          expect(emitted).toEqual([])
        } finally {
          kick.mockRestore()
          GlobalBus.off("event", listener)
        }
      }),
    30_000,
  )

  test(
    "an identical restore is a no-op, but queue-only progress rejects the old snapshot without rollback",
    () =>
      fixture(async (http, template) => {
        const data = envelope(http, template)
        await restored(http, data)
        expect(QueueSync.capture(data.info.id)).toEqual(data.payload.queueSnapshot)
        const installed = state(data.info.id)
        await restored(http, data)
        expect(state(data.info.id)).toEqual(installed)
        Database.transaction((db) => {
          db.update(TurnSessionEpochTable)
            .set({ epoch: 8, time_updated: 200 })
            .where(eq(TurnSessionEpochTable.session_id, data.info.id))
            .run()
          db.update(TurnReceiptTable)
            .set({ state: "cancelled", outcome: "never_ran", suspended: true, time_updated: 200 })
            .where(eq(TurnReceiptTable.id, data.payload.queueSnapshot.receipts[0].id))
            .run()
          db.update(TurnLaneStateTable)
            .set({ input_revision: 20, time_updated: 200 })
            .where(eq(TurnLaneStateTable.session_id, data.info.id))
            .run()
        })
        const progressed = state(data.info.id)
        expect(progressed.sequence?.seq).toBe(data.payload.finalSeq)
        await rejected(http, data.payload, 409)
        expect(state(data.info.id)).toEqual(progressed)
      }),
    30_000,
  )

  for (const invalid of [
    "partial history",
    "wrong final sequence",
    "wrong workspace",
    "mixed aggregates",
    "foreign payload session",
    "foreign queue session",
    "foreign message session",
    "missing finalSeq",
    "missing workspaceID",
    "missing queueSnapshot",
  ] as const) {
    test(
      `rejects ${invalid} without installing any history or queue rows`,
      () =>
        fixture(async (http, template) => {
          const data = envelope(http, template)
          const before = state(data.info.id)
          const payload = structuredClone(data.payload)
          const foreign = SessionID.descending()
          if (invalid === "partial history") payload.events = payload.events.slice(1)
          if (invalid === "wrong final sequence") payload.finalSeq++
          if (invalid === "wrong workspace") payload.workspaceID = WorkspaceID.ascending()
          if (invalid === "mixed aggregates") payload.events[1].aggregateID = foreign
          if (invalid === "foreign payload session")
            payload.events[1].data = { ...payload.events[1].data, sessionID: foreign }
          if (invalid === "foreign queue session") payload.queueSnapshot.receipts[0].session_id = foreign
          if (invalid === "foreign message session")
            Object.assign(payload.events[1].data.info as object, { sessionID: foreign })
          if (invalid === "missing finalSeq") Reflect.deleteProperty(payload, "finalSeq")
          if (invalid === "missing workspaceID") Reflect.deleteProperty(payload, "workspaceID")
          if (invalid === "missing queueSnapshot") Reflect.deleteProperty(payload, "queueSnapshot")
          const response = await http.post("/sync/replay", payload)
          expect(state(data.info.id)).toEqual(before)
          expect(state(foreign).session).toBeUndefined()
          expect(response.status).toBe(invalid === "wrong workspace" ? 409 : 400)
        }),
      30_000,
    )
  }

  for (const collision of [
    "message ID",
    "part ID",
    "receipt ID",
    "intent reference",
    "delivery reference",
    "part parent",
    "bootstrap reference",
  ] as const) {
    test(
      `rejects a foreign ${collision} without mutating either session`,
      () =>
        fixture(async (http, template) => {
          const foreign = envelope(http, template)
          await restored(http, foreign)
          expect(QueueSync.capture(foreign.info.id)).toEqual(foreign.payload.queueSnapshot)
          const foreignBefore = state(foreign.info.id)
          const data = envelope(http, template)
          const before = state(data.info.id)
          let payload = structuredClone(data.payload)
          if (collision === "message ID")
            payload = JSON.parse(JSON.stringify(payload).replaceAll(data.users[0].info.id, foreign.users[0].info.id))
          if (collision === "part ID")
            payload = JSON.parse(
              JSON.stringify(payload).replaceAll(data.users[0].parts[0].id, foreign.users[0].parts[0].id),
            )
          if (collision === "receipt ID")
            payload.queueSnapshot.receipts[0].id = foreign.payload.queueSnapshot.receipts[0].id
          if (collision === "intent reference")
            payload.queueSnapshot.receipts[0].intent = { kind: "prompt", messageID: foreign.users[0].info.id }
          if (collision === "delivery reference")
            payload.queueSnapshot.receipts[2].delivery_message_id = foreign.assistants[0].info.id
          if (collision === "part parent")
            Object.assign(payload.events[2].data.part as object, { messageID: foreign.users[0].info.id })
          if (collision === "bootstrap reference")
            payload.queueSnapshot.bootstrap!.message_ids = [foreign.users[0].info.id]
          const response = await http.post("/sync/replay", payload)
          expect(state(data.info.id)).toEqual(before)
          expect(state(foreign.info.id)).toEqual(foreignBefore)
          expect(response.status).toBe(400)
        }),
      30_000,
    )
  }

  test(
    "claimed snapshots are rejected before any target history is installed",
    () =>
      fixture(async (http, template) => {
        const data = envelope(http, template)
        data.payload.queueSnapshot.receipts[1].state = "claimed"
        const before = state(data.info.id)
        await rejected(http, data.payload, 409)
        expect(state(data.info.id)).toEqual(before)
      }),
    30_000,
  )

  test(
    "an active target rejects even an identical complete restore without cancelling its runner",
    () =>
      fixture(async (http, template, llm) => {
        const data = envelope(http, template)
        await restored(http, data)
        expect(QueueSync.capture(data.info.id)).toEqual(data.payload.queueSnapshot)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let completed = false
        const running = WorkspaceContext.provide({
          workspaceID: http.workspaceID,
          fn: () =>
            Instance.provide({
              directory: http.directory,
              fn: () =>
                AppRuntime.runPromise(
                  SessionRunState.Service.use((runs) =>
                    runs.startShell(
                      data.info.id,
                      Effect.succeed(data.assistants[0]),
                      Effect.promise(async () => {
                        entered.resolve()
                        await release.promise
                        return data.assistants[0]
                      }),
                    ),
                  ),
                ),
            }),
        }).then((result) => {
          completed = true
          return result
        })
        try {
          await entered.promise
          const before = state(data.info.id)
          await rejected(http, data.payload, 409)
          expect(state(data.info.id)).toEqual(before)
          expect(completed).toBe(false)
          expect(await Effect.runPromise(llm.calls)).toBe(0)
        } finally {
          release.resolve()
          await running
        }
        expect(completed).toBe(true)
      }),
    30_000,
  )

  test(
    "a higher target history sequence rejects the older full payload without rollback",
    () =>
      fixture(async (http, template) => {
        const data = envelope(http, template)
        await restored(http, data)
        expect(QueueSync.capture(data.info.id)).toEqual(data.payload.queueSnapshot)
        SyncEvent.replay({
          id: `${data.info.id}-newer`,
          aggregateID: data.info.id,
          seq: data.payload.finalSeq + 1,
          type: SyncEvent.versionedType(Session.Event.Updated.type, Session.Event.Updated.version),
          data: { sessionID: data.info.id, info: { time: { updated: 400 } } },
        })
        const before = state(data.info.id)
        expect(before.sequence?.seq).toBe(data.payload.finalSeq + 1)
        await rejected(http, data.payload, 409)
        expect(state(data.info.id)).toEqual(before)
      }),
    30_000,
  )

  test(
    "a failure after real snapshot writes rolls back history, sequence and every queue table",
    () =>
      fixture(async (http, template, llm) => {
        const data = envelope(http, template)
        const before = state(data.info.id)
        const emitted: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => {
          if (
            event.payload.syncEvent?.aggregateID === data.info.id ||
            event.payload.properties?.sessionID === data.info.id
          )
            emitted.push(event)
        }
        const apply = QueueSync.applySnapshot
        let sawWrittenState = false
        const fault = spyOn(QueueSync, "applySnapshot").mockImplementation((snapshot, db) => {
          const result = apply(snapshot, db)
          if (snapshot.sessionID === data.info.id) {
            const written = state(data.info.id)
            expect(written.messages).toHaveLength(data.users.length + data.assistants.length)
            expect(written.events).toHaveLength(data.payload.events.length)
            expect(written.sequence?.seq).toBe(data.payload.finalSeq)
            expect(written.queue).toEqual(data.payload.queueSnapshot)
            sawWrittenState = true
            throw new Error("injected failure after history and snapshot persistence")
          }
          return result
        })
        GlobalBus.on("event", listener)
        try {
          const response = await http.post("/sync/replay", data.payload)
          expect(response.status).toBe(500)
          expect(sawWrittenState).toBe(true)
          expect(state(data.info.id)).toEqual(before)
          expect(emitted).toEqual([])
          expect(await Effect.runPromise(llm.calls)).toBe(0)
        } finally {
          fault.mockRestore()
          GlobalBus.off("event", listener)
        }
        await restored(http, data)
        expect(QueueSync.capture(data.info.id)).toEqual(data.payload.queueSnapshot)
      }),
    30_000,
  )

  for (const mode of ["events-only", "complete restore"] as const) {
    for (const invalid of ["unknown type", "first sequence gap", "invalid queue epoch"] as const) {
      test(`${mode} returns 400 for ${invalid} without applying the batch`, () => fixture(async (http, template) => {
        const data = envelope(http, template)
        const before = state(data.info.id)
        const events = structuredClone(data.payload.events)
        events.push({
          id: `${data.info.id}-valid-epoch`, type: "session.turn_queue.delta.1", aggregateID: data.info.id, seq: events.length,
          data: { sessionID: data.info.id, epoch: { session_id: data.info.id, epoch: 7, time_updated: 1 } },
        })
        if (invalid === "unknown type") events.push({ ...events.at(-1)!, id: `${data.info.id}-unknown`, seq: events.length, type: "unknown.event.1" })
        if (invalid === "first sequence gap") for (const event of events) event.seq++
        if (invalid === "invalid queue epoch") events.push({
          id: `${data.info.id}-bad-epoch`, type: "session.turn_queue.delta.1", aggregateID: data.info.id, seq: events.length,
          data: { sessionID: data.info.id, epoch: { session_id: data.info.id, epoch: -1, time_updated: 1 } },
        })
        const payload = mode === "events-only" ? { directory: http.directory, events }
          : { ...data.payload, events, finalSeq: events.at(-1)!.seq }
        await rejected(http, payload)
        expect(state(data.info.id)).toEqual(before)
      }))
    }

    for (const invalid of ["nested message session", "message ID collision", "nested part session", "part ID collision", "foreign part parent", "same-session part parent collision", "malformed message payload", "malformed part payload"] as const) {
      test(`${mode} rejects ${invalid} at the shared message and part boundary`, () => fixture(async (http, template, llm) => {
        const victim = envelope(http, template)
        await restored(http, victim)
        const data = envelope(http, template)
        const before = state(data.info.id)
        const victimBefore = state(victim.info.id)
        const info = { ...data.users[0].info, id: MessageID.ascending() }
        const part = { ...data.users[0].parts[0], id: PartID.ascending(), text: "must not overwrite" }
        if (invalid === "nested message session") info.sessionID = victim.info.id
        if (invalid === "message ID collision") info.id = victim.users[0].info.id
        if (invalid === "nested part session") part.sessionID = victim.info.id
        if (invalid === "part ID collision") part.id = victim.users[0].parts[0].id
        if (invalid === "foreign part parent") part.messageID = victim.users[0].info.id
        if (invalid === "same-session part parent collision") {
          part.id = data.users[0].parts[0].id
          part.messageID = data.users[1].info.id
        }
        const message = invalid === "nested message session" || invalid === "message ID collision" || invalid === "malformed message payload"
        const events = [...data.payload.events, {
          id: `${data.info.id}-valid-epoch`, type: "session.turn_queue.delta.1", aggregateID: data.info.id, seq: data.payload.events.length,
          data: { sessionID: data.info.id, epoch: { session_id: data.info.id, epoch: 7, time_updated: 1 } },
        }, {
          id: `${data.info.id}-bad-owner`, aggregateID: data.info.id, seq: data.payload.events.length + 1,
          type: message ? "message.updated.1" : "message.part.updated.1",
          data: message
            ? { sessionID: data.info.id, info: invalid === "malformed message payload" ? { id: info.id, sessionID: info.sessionID } : info }
            : { sessionID: data.info.id, part: invalid === "malformed part payload" ? { id: part.id, sessionID: part.sessionID } : part, time: 103 },
        }]
        const payload = mode === "events-only" ? { directory: http.directory, events }
          : { ...data.payload, events, finalSeq: events.length - 1 }
        const emitted: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => { emitted.push(event) }
        const kick = spyOn(schedulerRef.current!, "kick")
        GlobalBus.on("event", listener)
        try {
          await rejected(http, payload)
          expect(state(data.info.id)).toEqual(before)
          expect(state(victim.info.id)).toEqual(victimBefore)
          expect(emitted).toEqual([])
          expect(kick).not.toHaveBeenCalled()
          expect(await Effect.runPromise(llm.calls)).toBe(0)
        } finally {
          kick.mockRestore()
          GlobalBus.off("event", listener)
        }
      }))
    }

    test(`${mode} returns 400 for a late queue aggregate mismatch without mutating either session`, () =>
      fixture(async (http, template, llm) => {
        const data = envelope(http, template)
        const before = state(data.info.id)
        const victimBefore = state(template.id)
        const events = [...data.payload.events, {
          id: `${data.info.id}-queue-valid`, aggregateID: data.info.id, seq: data.payload.events.length,
          type: "session.turn_queue.delta.1",
          data: { sessionID: data.info.id, epoch: { session_id: data.info.id, epoch: 7, time_updated: 102 } },
        }, {
          id: `${data.info.id}-queue-foreign`, aggregateID: data.info.id, seq: data.payload.events.length + 1,
          type: "session.turn_queue.delta.1",
          data: { sessionID: template.id, epoch: { session_id: template.id, epoch: 99, time_updated: 103 } },
        }]
        const payload = mode === "events-only" ? { directory: http.directory, events }
          : { ...data.payload, events, finalSeq: events.length - 1 }
        const emitted: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => { emitted.push(event) }
        const kick = spyOn(schedulerRef.current!, "kick")
        GlobalBus.on("event", listener)
        try {
          const response = await http.post("/sync/replay", payload)
          expect(response.status).toBe(400)
          expect((await response.json()).name).toBe(mode === "events-only" ? "ReplayValidationError" : "RestorePayloadError")
          expect(state(data.info.id)).toEqual(before)
          expect(state(template.id)).toEqual(victimBefore)
          expect(emitted).toEqual([])
          expect(kick).not.toHaveBeenCalled()
          expect(await Effect.runPromise(llm.calls)).toBe(0)
        } finally {
          kick.mockRestore()
          GlobalBus.off("event", listener)
        }
      }),
    )

    test(`${mode} preserves HTTP 500 for a real SQLite log constraint failure and rolls back queue writes`, () =>
      fixture(async (http, template, llm) => {
        const data = envelope(http, template)
        const before = state(data.info.id)
        const events = [...data.payload.events, {
          id: `${data.info.id}-queue-valid`, aggregateID: data.info.id, seq: data.payload.events.length,
          type: "session.turn_queue.delta.1",
          data: { sessionID: data.info.id, epoch: { session_id: data.info.id, epoch: 7, time_updated: 102 } },
        }, {
          id: data.payload.events[0].id, aggregateID: data.info.id, seq: data.payload.events.length + 1,
          type: "session.turn_queue.delta.1",
          data: { sessionID: data.info.id, epoch: { session_id: data.info.id, epoch: 8, time_updated: 103 } },
        }]
        const payload = mode === "events-only" ? { directory: http.directory, events }
          : { ...data.payload, events, finalSeq: events.length - 1 }
        const emitted: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => { emitted.push(event) }
        GlobalBus.on("event", listener)
        try {
          const response = await http.post("/sync/replay", payload)
          expect(response.status).toBe(500)
          expect(state(data.info.id)).toEqual(before)
          expect(emitted).toEqual([])
          expect(await Effect.runPromise(llm.calls)).toBe(0)
        } finally {
          GlobalBus.off("event", listener)
        }
        await restored(http, data)
        expect(QueueSync.capture(data.info.id)).toEqual(data.payload.queueSnapshot)
      }),
    )
  }

  test(
    "events-only replay remains compatible and rolls its whole batch back on a late projector failure",
    () =>
      fixture(async (http, template) => {
        const data = envelope(http, template)
        const before = state(data.info.id)
        const bad = [
          ...data.payload.events,
          {
            id: `${data.info.id}-bad-title`,
            aggregateID: data.info.id,
            seq: data.payload.finalSeq + 1,
            type: SyncEvent.versionedType(Session.Event.Updated.type, Session.Event.Updated.version),
            data: {
              sessionID: data.info.id,
              previousRevision: 999,
              info: { title: "invalid", titleSource: "user", titleRevision: 1000 },
            },
          },
        ]
        const failed = await http.post("/sync/replay", { directory: http.directory, events: bad })
        expect(failed.status).toBe(500)
        expect(state(data.info.id)).toEqual(before)
        const response = await http.post("/sync/replay", { directory: http.directory, events: data.payload.events })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ sessionID: data.info.id })
        expect(state(data.info.id).events).toHaveLength(data.payload.events.length)
        expect(QueueSync.capture(data.info.id).receipts).toEqual([])
      }),
    30_000,
  )

  test(
    "rejects different content at an already installed final sequence",
    () =>
      fixture(async (http, template) => {
        const data = envelope(http, template)
        await restored(http, data)
        const before = state(data.info.id)
        const conflict = structuredClone(data.payload)
        conflict.queueSnapshot.receipts[0].suspended = true
        await rejected(http, conflict, 409)
        expect(state(data.info.id)).toEqual(before)
      }),
    30_000,
  )
})
