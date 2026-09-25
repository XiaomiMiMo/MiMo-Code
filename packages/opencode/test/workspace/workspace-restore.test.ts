import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { GlobalBus } from "../../src/bus/global"
import { registerAdaptor } from "../../src/control-plane/adaptors"
import type { WorkspaceAdaptor } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Flag } from "../../src/flag/flag"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRunState } from "../../src/session/run-state"
import { SessionTable } from "../../src/session/session.sql"
import * as QueueSync from "../../src/turn-queue/sync"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Database, asc, eq } from "../../src/storage"
import { SyncEvent } from "../../src/sync"
import { installRestore } from "../../src/sync/restore"
import { schedulerRef } from "../../src/turn-queue/scheduler"
import { EventTable } from "../../src/sync/event.sql"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES

beforeEach(() => {
  Database.close()
  Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = true
})

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
  Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES = original
})

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

async function user(sessionID: SessionID, text: string) {
  const msg = await updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    time: { created: Date.now() },
  })
  await updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: msg.id,
    type: "text",
    text,
  })
  return MessageV2.get({ sessionID, messageID: msg.id })
}

function history(sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).orderBy(asc(EventTable.seq)).all(),
  )
}

function saved(sessionID: SessionID) {
  return {
    session: Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()),
    events: history(sessionID),
    queue: QueueSync.capture(sessionID),
  }
}

function seedQueue(sessionID: SessionID, messageID: MessageID) {
  const snapshot: QueueSync.Snapshot = {
    version: 1,
    sessionID,
    receipts: [
      {
        id: `${sessionID}-pending`,
        session_id: sessionID,
        agent_id: "main",
        state: "accepted",
        intent: { kind: "prompt", messageID },
        epoch: 3,
        run_id: null,
        claim_frontier: null,
        consumed: false,
        suspended: true,
        outcome: null,
        message_id: null,
        delivery_message_id: null,
        error: null,
        idempotency_key: messageID,
        time_created: 100,
        time_updated: 101,
      },
    ],
    lanes: [{ session_id: sessionID, agent_id: "main", consumed_frontier: null, input_revision: 4, time_updated: 101 }],
    epoch: { session_id: sessionID, epoch: 3, time_updated: 101 },
    bootstrap: { session_id: sessionID, message_ids: [messageID], completed: true, time_updated: 101 },
  }
  Database.transaction((db) => QueueSync.applySnapshot(snapshot, db))
  return snapshot
}

function remote(dir: string, url: string): WorkspaceAdaptor {
  return {
    name: "remote",
    description: "remote",
    configure(info) {
      return {
        ...info,
        directory: dir,
      }
    },
    async create() {
      await fs.mkdir(dir, { recursive: true })
    },
    async remove() {},
    target() {
      return {
        type: "remote" as const,
        url,
      }
    },
  }
}

function local(dir: string): WorkspaceAdaptor {
  return {
    name: "local",
    description: "local",
    configure(info) {
      return {
        ...info,
        directory: dir,
      }
    },
    async create() {
      await fs.mkdir(dir, { recursive: true })
    },
    async remove() {},
    target() {
      return {
        type: "local" as const,
        directory: dir,
      }
    },
  }
}

function eventStreamResponse() {
  return new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
    },
  })
}

describe("Workspace.sessionRestore", () => {
  for (const populated of [false, true]) {
    test(`actual ${populated ? "populated" : "empty"} sender envelope with workspace and time patches installs on a fresh receiver`, async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = path.join(tmp.path, ".receiver")
      let sent: Omit<Parameters<typeof installRestore>[0], "isIdle"> | undefined
      const raw = globalThis.fetch
      spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: URL | RequestInfo, init?: BunFetchRequestInit | RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
        if (url.pathname === "/base/global/event") return eventStreamResponse()
        if (url.pathname === "/base/sync/history") return Response.json([])
        expect(url.pathname).toBe("/base/sync/replay")
        sent = JSON.parse(String(init?.body))
        return Response.json({ sessionID: sent!.events[0].aggregateID })
      }, { preconnect: raw.preconnect?.bind(raw) }) as typeof globalThis.fetch)
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          registerAdaptor(Instance.project.id, "receiver", remote(dir, "https://workspace.test/base"))
          const space = await Workspace.create({ type: "receiver", branch: null, extra: null, projectID: Instance.project.id })
          const session = await create({ title: "real sender history" })
          if (populated) {
            const message = await user(session.id, "preserved transcript")
            seedQueue(session.id, message.info.id)
          }
          await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.setArchived({ sessionID: session.id, time: 123456789 })))
          await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.touch(session.id)))
          const touched = saved(session.id).session!.time_updated
          expect(await Workspace.sessionRestore({ workspaceID: space.id, sessionID: session.id })).toEqual({ total: 1 })
          expect(sent).toBeDefined()
          const payload = sent!
          const expected = saved(session.id)
          expect(payload.events.some((event) => event.type === "session.updated.2" &&
            JSON.stringify(event.data.info) === JSON.stringify({ workspaceID: space.id }))).toBe(true)
          expect(payload.events.some((event) => event.type === "session.updated.2" &&
            JSON.stringify(event.data.info) === JSON.stringify({ time: { updated: touched } }))).toBe(true)
          expect(payload.events.at(-1)?.seq).toBe(payload.finalSeq)
          Database.transaction((db) => {
            db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run()
            SyncEvent.remove(session.id)
          })
          expect(saved(session.id).session).toBeUndefined()
          expect(history(session.id)).toEqual([])
          const scheduler = schedulerRef.current
          const kick = mock(() => Effect.void)
          schedulerRef.current = { kick }
          const emitted = spyOn(GlobalBus, "emit")
          try {
            expect(installRestore({ ...payload, isIdle: () => true })).toBe(session.id)
            const received = saved(session.id)
            expect(received).toEqual({ ...expected, session: { ...expected.session!, time_updated: expect.any(Number) } })
            expect(received.session!.time_updated).toBeGreaterThanOrEqual(touched)
            expect(installRestore({ ...payload, isIdle: () => true })).toBe(session.id)
            expect(saved(session.id)).toEqual(received)
            expect(kick).not.toHaveBeenCalled()
            expect(emitted).not.toHaveBeenCalled()
          } finally {
            schedulerRef.current = scheduler
            emitted.mockRestore()
          }
        },
      })
    })
  }

  test("sends complete history and queue state in one atomic envelope and emits progress", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = path.join(tmp.path, ".restore")
    const seen: any[] = []
    const posts: Array<{
      path: string
      body: {
        directory: string
        workspaceID: string
        finalSeq: number
        queueSnapshot: QueueSync.Snapshot
        events: SyncEvent.SerializedEvent[]
      }
    }> = []
    const on = (evt: any) => seen.push(evt)
    GlobalBus.on("event", on)

    const raw = globalThis.fetch
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: URL | RequestInfo, init?: BunFetchRequestInit | RequestInit) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
          if (url.pathname === "/base/global/event") {
            return eventStreamResponse()
          }
          if (url.pathname === "/base/sync/history") {
            return Response.json([])
          }
          const body = JSON.parse(String(init?.body))
          posts.push({
            path: url.pathname,
            body,
          })
          return Response.json({ sessionID: body.events[0].aggregateID })
        },
        {
          preconnect: raw.preconnect?.bind(raw),
        },
      ) as typeof globalThis.fetch,
    )

    try {
      const setup = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          registerAdaptor(Instance.project.id, "worktree", remote(dir, "https://workspace.test/base"))
          const space = await Workspace.create({
            type: "worktree",
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
          const session = await create({})
          for (let i = 0; i < 6; i++) {
            const message = await user(session.id, `msg ${i}`)
            if (i === 0) seedQueue(session.id, message.info.id)
          }
          const queue = QueueSync.capture(session.id)
          const rows = Database.use((db) =>
            db
              .select({ seq: EventTable.seq })
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, session.id))
              .orderBy(asc(EventTable.seq))
              .all(),
          )
          const result = await Workspace.sessionRestore({
            workspaceID: space.id,
            sessionID: session.id,
          })
          return { space, session, rows, result, queue }
        },
      })

      expect(setup.rows).toHaveLength(13)
      expect(setup.result).toEqual({ total: 1 })
      expect(posts).toHaveLength(1)
      expect(posts[0]?.path).toBe("/base/sync/replay")
      expect(posts[0]?.body.directory).toBe(dir)
      expect(posts[0]?.body.workspaceID).toBe(setup.space.id)
      expect(posts[0]?.body.queueSnapshot).toEqual(setup.queue)
      expect(posts[0]?.body.finalSeq).toBe(14)
      expect(posts[0]?.body.events).toHaveLength(15)
      expect(posts[0]?.body.events.map((event) => event.seq)).toEqual(Array.from({ length: 15 }, (_, seq) => seq))
      expect(posts[0]?.body.events.at(-2)).toMatchObject({
        aggregateID: setup.session.id,
        seq: setup.rows.at(-1)!.seq + 1,
        type: SyncEvent.versionedType(SessionNs.Event.Updated.type, SessionNs.Event.Updated.version),
        data: {
          sessionID: setup.session.id,
          info: {
            workspaceID: setup.space.id,
          },
        },
      })

      expect(posts[0]?.body.events.at(-1)).toMatchObject({
        aggregateID: setup.session.id,
        seq: 14,
        type: SyncEvent.versionedType(QueueSync.Event.Snapshot.type, QueueSync.Event.Snapshot.version),
        data: setup.queue,
      })
      const restore = seen.filter(
        (evt) => evt.workspace === setup.space.id && evt.payload.type === Workspace.Event.Restore.type,
      )
      expect(restore.map((evt) => evt.payload.properties.step)).toEqual([0, 1])
      expect(restore.map((evt) => evt.payload.properties.total)).toEqual([1, 1])
      expect(restore.map((evt) => evt.payload.properties.sessionID)).toEqual([setup.session.id, setup.session.id])
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("transfers local ownership and records its queue snapshot without replaying the shared database", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = path.join(tmp.path, ".restore-local")
    const seen: any[] = []
    const on = (evt: any) => seen.push(evt)
    GlobalBus.on("event", on)

    const fetch = spyOn(globalThis, "fetch")
    const replayAll = spyOn(SyncEvent, "replayAll")

    try {
      const setup = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          registerAdaptor(Instance.project.id, "local-restore", local(dir))
          const space = await Workspace.create({
            type: "local-restore",
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
          const session = await create({})
          for (let i = 0; i < 6; i++) {
            const message = await user(session.id, `msg ${i}`)
            if (i === 0) seedQueue(session.id, message.info.id)
          }
          const queue = QueueSync.capture(session.id)
          const result = await Workspace.sessionRestore({
            workspaceID: space.id,
            sessionID: session.id,
          })
          const updated = await get(session.id)
          return { space, session, result, updated, queue }
        },
      })

      expect(setup.result).toEqual({ total: 1 })
      expect(fetch).not.toHaveBeenCalled()
      expect(replayAll).not.toHaveBeenCalled()
      expect(setup.updated.workspaceID).toBe(setup.space.id)
      expect(QueueSync.capture(setup.session.id)).toEqual(setup.queue)
      expect(history(setup.session.id)).toHaveLength(15)
      expect(history(setup.session.id).at(-1)).toMatchObject({
        seq: 14,
        type: SyncEvent.versionedType(QueueSync.Event.Snapshot.type, QueueSync.Event.Snapshot.version),
        data: setup.queue,
      })

      const restore = seen.filter(
        (evt) => evt.workspace === setup.space.id && evt.payload.type === Workspace.Event.Restore.type,
      )
      expect(restore.map((evt) => evt.payload.properties.step)).toEqual([0, 1])
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("rejects an active source without transferring ownership or cancelling its runner", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        registerAdaptor(Instance.project.id, "active-restore", local(path.join(tmp.path, ".active-target")))
        const space = await Workspace.create({
          type: "active-restore",
          branch: null,
          extra: null,
          projectID: Instance.project.id,
        })
        const session = await create({})
        const message = await user(session.id, "active source")
        seedQueue(session.id, message.info.id)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let completed = false
        const running = AppRuntime.runPromise(
          SessionRunState.Service.use((runs) =>
            runs.startShell(
              session.id,
              Effect.succeed(message),
              Effect.promise(async () => {
                entered.resolve()
                await release.promise
                return message
              }),
            ),
          ),
        ).then((result) => {
          completed = true
          return result
        })
        try {
          await Promise.race([
            entered.promise,
            running.then(() => {
              throw new Error("Source runner exited before entering")
            }),
          ])
          const before = saved(session.id)
          await expect(Workspace.sessionRestore({ workspaceID: space.id, sessionID: session.id })).rejects.toThrow(
            "active execution",
          )
          expect(saved(session.id)).toEqual(before)
          expect(completed).toBe(false)
        } finally {
          release.resolve()
          await running
        }
        expect(completed).toBe(true)
      },
    })
  })

  for (const failure of ["HTTP error", "lost response"] as const) {
    test(`${failure} keeps remote ownership, retries the identical envelope and rejects mirror A-to-B transfer`, async () => {
      await using tmp = await tmpdir({ git: true })
      const posts: string[] = []
      let fail = true
      const raw = globalThis.fetch
      spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: URL | RequestInfo, init?: BunFetchRequestInit | RequestInit) => {
            const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
            if (url.pathname === "/base/global/event") return eventStreamResponse()
            if (url.pathname === "/base/sync/history") return Response.json([])
            expect(url.pathname).toBe("/base/sync/replay")
            posts.push(String(init?.body))
            if (fail) {
              if (failure === "lost response") throw new Error("injected lost response after remote commit")
              return new Response("injected restore failure", { status: 503 })
            }
            return Response.json({ sessionID: JSON.parse(String(init?.body)).events[0].aggregateID })
          },
          { preconnect: raw.preconnect?.bind(raw) },
        ) as typeof globalThis.fetch,
      )
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          registerAdaptor(
            Instance.project.id,
            "remote-a",
            remote(path.join(tmp.path, ".remote-a"), "https://workspace.test/base"),
          )
          registerAdaptor(
            Instance.project.id,
            "remote-b",
            remote(path.join(tmp.path, ".remote-b"), "https://workspace.test/base"),
          )
          const a = await Workspace.create({
            type: "remote-a",
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
          const b = await Workspace.create({
            type: "remote-b",
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
          const session = await create({})
          const message = await user(session.id, "transfer source")
          const queue = seedQueue(session.id, message.info.id)
          const before = saved(session.id)
          await expect(Workspace.sessionRestore({ workspaceID: a.id, sessionID: session.id })).rejects.toThrow(
            failure === "lost response" ? "injected lost response" : "HTTP 503",
          )
          const transferred = saved(session.id)
          expect(transferred.session?.workspace_id).toBe(a.id)
          expect(transferred.queue).toEqual(queue)
          expect(transferred.events).toHaveLength(before.events.length + 2)
          expect(posts).toHaveLength(1)
          const payload = JSON.parse(posts[0])
          expect(payload.workspaceID).toBe(a.id)
          expect(payload.queueSnapshot).toEqual(queue)
          expect(payload.finalSeq).toBe(transferred.events.at(-1)?.seq)
          expect(payload.events).toHaveLength(transferred.events.length)
          fail = false
          expect(await Workspace.sessionRestore({ workspaceID: a.id, sessionID: session.id })).toEqual({ total: 1 })
          expect(posts).toHaveLength(2)
          expect(posts[1]).toBe(posts[0])
          expect(saved(session.id)).toEqual(transferred)
          await expect(Workspace.sessionRestore({ workspaceID: b.id, sessionID: session.id })).rejects.toThrow(
            "a mirror cannot transfer its lease",
          )
          expect(posts).toHaveLength(2)
          expect(saved(session.id)).toEqual(transferred)
        },
      })
    })
  }
})
