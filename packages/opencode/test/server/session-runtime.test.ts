import { describe, expect } from "bun:test"
import { Effect, Layer, Deferred, Fiber } from "effect"
import { Session } from "../../src/session"
import { SessionRunState } from "../../src/session/run-state"
import { SessionRuntime, type Envelope } from "../../src/session/runtime"
import { SessionStatus } from "../../src/session/status"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorExecution } from "../../src/actor/execution"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Bus } from "../../src/bus"
import { SyncEvent } from "../../src/sync"
import { EventID } from "../../src/sync/schema"
import { Server } from "../../src/server/server"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance, provideInstance } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage"
import { PartTable } from "../../src/session/session.sql"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Session.defaultLayer, SessionRunState.defaultLayer, ActorRegistry.defaultLayer, ActorExecution.layer, Bus.defaultLayer, SessionStatus.defaultLayer))
const user = (sessionID: SessionID, agentID?: string): MessageV2.Info => ({
  id: MessageID.ascending(), sessionID, agentID, role: "user", time: { created: Date.now() },
  agent: "test", model: { providerID: "test", modelID: "test" },
}) as MessageV2.Info

function reader(response: Response) {
  const stream = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return {
    cancel: () => stream.cancel(),
    async next(): Promise<{ type: string; properties: Record<string, unknown> } | undefined> {
      while (!buffer.includes("\n\n")) {
        const chunk = await stream.read()
        if (chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      const end = buffer.indexOf("\n\n")
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = frame.split("\n").find((line) => line.startsWith("data: "))!
      return JSON.parse(data.slice(6))
    },
  }
}

describe("session runtime HTTP/SSE", () => {
  // [TP-R17-01] [TP-R17-04] [TP-R17-05]
  it.live("ready precedes snapshot cut; undurable text, shorter final replacement, revert and removals stay authoritative", () =>
    provideTmpdirInstance((directory) => Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create()
      const info = user(created.id, "worker")
      const part: MessageV2.TextPart = { id: PartID.ascending(), sessionID: created.id, messageID: info.id, type: "text", text: "ha" }
      yield* session.updateMessage(info)
      yield* session.updatePart(part)
      const app = Server.Default().app
      const response = yield* Effect.promise(async () => app.request("/event?runtime=1", { headers: { "x-mimocode-directory": directory } }))
      const stream = reader(response)
      yield* Effect.addFinalizer(() => Effect.promise(() => stream.cancel()))
      const ready = yield* Effect.promise(() => stream.next())
      expect(ready?.type).toBe("runtime.ready")
      const delta = { sessionID: created.id, messageID: info.id, partID: part.id, field: "text", delta: "ha" }
      yield* session.updatePartDelta(delta)
      const snap = yield* Effect.promise(async () => (await app.request(`/session/${created.id}/runtime`, { headers: { "x-mimocode-directory": directory } })).json())
      expect(snap.epoch).toBe(ready?.properties.epoch)
      expect(snap.scope).toEqual({ agentID: "*", messageIDs: [info.id], revert: null })
      expect(snap.messages[0].parts[0].text).toBe("haha")
      const history = yield* session.messages({ sessionID: created.id, agentID: "worker" })
      expect(history[0].parts[0]).toMatchObject({ text: "ha" })
      yield* session.updatePartDelta(delta)
      const received: Envelope[] = []
      while (received.length < 2) {
        const frame = yield* Effect.promise(() => stream.next())
        if (frame?.type === "runtime.event" && (frame.properties.event as { type: string }).type === "message.part.delta") received.push(frame as Envelope)
      }
      expect(received[0].properties.seq).toBe(snap.throughSeq)
      expect(received[1].properties.seq).toBe(snap.throughSeq + 1)
      expect(received[0].properties.ownerActorId).toBe("worker")
      expect(SessionRuntime.current().snapshot(created.id).messages[0].parts[0]).toMatchObject({ text: "hahaha" })
      expect(snap.messages[0].parts[0].text).toBe("haha")
      yield* session.updatePart({ ...part, text: "x" })
      expect(SessionRuntime.current().snapshot(created.id).messages[0].parts[0]).toMatchObject({ text: "x" })
      yield* session.setRevert({ sessionID: created.id, revert: { messageID: info.id, partID: part.id }, summary: { additions: 0, deletions: 0, files: 0 } })
      expect(SessionRuntime.current().snapshot(created.id).scope.revert).toMatchObject({ messageID: info.id, partID: part.id })
      yield* session.removePart({ sessionID: created.id, messageID: info.id, partID: part.id })
      expect(SessionRuntime.current().snapshot(created.id).messages[0].parts).toEqual([])
      yield* session.removeMessage({ sessionID: created.id, messageID: info.id })
      expect(SessionRuntime.current().snapshot(created.id).messages).toEqual([])
      yield* session.remove(created.id)
      const missing = yield* Effect.promise(async () => app.request(`/session/${created.id}/runtime`, { headers: { "x-mimocode-directory": directory } }))
      expect(missing.status).toBe(404)
    })),
  )

  // [TP-R17-04] [TP-R17-05]
  it.live("silent SyncEvent replay replaces overlays and rejected/duplicate replay does not advance runtime seq", () =>
    provideTmpdirInstance((directory) => Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create()
      const info = user(created.id)
      const part: MessageV2.TextPart = { id: PartID.ascending(), sessionID: created.id, messageID: info.id, type: "text", text: "long" }
      yield* session.updateMessage(info)
      yield* session.updatePart(part)
      yield* session.updatePartDelta({ sessionID: created.id, messageID: info.id, partID: part.id, field: "text", delta: "er" })
      const runtime = SessionRuntime.current()
      const before = runtime.snapshot(created.id).throughSeq
      const event = { id: EventID.ascending(), seq: 0, aggregateID: created.id, type: SyncEvent.versionedType(MessageV2.Event.PartUpdated.type, MessageV2.Event.PartUpdated.version), data: { sessionID: created.id, part: { ...part, text: "x" }, time: Date.now() } }
      SyncEvent.replay(event)
      expect(runtime.snapshot(created.id).messages[0].parts[0]).toMatchObject({ text: "x" })
      expect(runtime.snapshot(created.id).throughSeq).toBe(before + 1)
      SyncEvent.replay(event)
      expect(runtime.snapshot(created.id).throughSeq).toBe(before + 1)
      expect(() => SyncEvent.replay({ ...event, seq: 4 })).toThrow("Sequence mismatch")
      expect(runtime.snapshot(created.id).throughSeq).toBe(before + 1)
    })),
  )

  // [TP-R17-02] [TP-R17-03]
  it.live("runner liveness wins stale registry outcome and source errors/retry remain actor-local", () =>
    provideTmpdirInstance((directory) => Effect.gen(function* () {
      const session = yield* Session.Service
      const registry = yield* ActorRegistry.Service
      const runners = yield* SessionRunState.Service
      const bus = yield* Bus.Service
      const created = yield* session.create()
      yield* registry.register({ sessionID: created.id, actorID: "worker", mode: "subagent", agent: "test", description: "test", contextMode: "none", background: true, lifecycle: "persistent" })
      yield* registry.updateStatus(created.id, "worker", { status: "idle", lastOutcome: "success" })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const info = user(created.id, "worker")
      const work = Effect.gen(function* () {
        yield* bus.publish(Session.Event.Error, { sessionID: created.id, error: { name: "UnknownError", data: { message: "worker error" } } })
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return { info, parts: [] }
      })
      const runtime = SessionRuntime.current()
      const events: Envelope[] = []
      const off = runtime.subscribe((event) => events.push(event))
      yield* Effect.addFinalizer(() => Effect.sync(off))
      const fiber = yield* runners.ensureRunning(created.id, "worker", Effect.succeed({ info, parts: [] }), work).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(runtime.snapshot(created.id).actors.find((actor) => actor.actorID === "worker")).toMatchObject({ executionActive: true, status: "running" })
      expect(events.find((event) => event.properties.event.type === "session.error")?.properties.ownerActorId).toBe("worker")
      expect(runtime.snapshot(created.id).actors.find((actor) => actor.actorID === "worker")?.error).toBe("worker error")
      runtime.retry(created.id, "worker", { type: "retry", attempt: 1, message: "wait", next: 123, phase: "stream" })
      yield* bus.publish(Session.Event.RetryAttempt, { sessionID: created.id, messageID: info.id, attempt: 1, phaseAttempt: 1, maxAttempts: 3, phase: "request", kind: "network", scope: "request", reason: "diagnostic", nextDelayMs: 10 })
      expect(runtime.snapshot(created.id).retries).toEqual([{ actorID: "worker", status: { type: "retry", attempt: 1, message: "wait", next: 123, phase: "stream" } }])
      yield* session.updateMessage(user(created.id, "main"))
      expect(runtime.snapshot(created.id).retries).toHaveLength(1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
      expect(runtime.snapshot(created.id).actors.find((actor) => actor.actorID === "worker")).toMatchObject({ executionActive: false, status: "idle" })
      expect(runtime.snapshot(created.id).retries).toEqual([])
      expect(events.some((event) => event.properties.event.type === "actor.retry" && event.properties.event.properties.status === null)).toBe(true)
    })),
  )

  // [TP-R17-01] [TP-R17-02]
  it.live("pre-runner prompt and non-main resume failures preserve source on both raw and runtime events", () =>
    provideTmpdirInstance((directory) => Effect.gen(function* () {
      const session = yield* Session.Service
      const app = Server.Default().app
      for (const action of ["prompt", "resume"] as const) {
        const created = yield* session.create()
        const source = user(created.id, "worker")
        yield* session.updateMessage(source)
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(), sessionID: created.id, parentID: source.id, agentID: "worker",
          role: "assistant", agent: "build", mode: "build", path: { cwd: directory, root: directory },
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          providerID: "test", modelID: "missing", time: { created: Date.now() },
        } as MessageV2.Assistant
        yield* session.updateMessage(assistant)
        const events: Envelope[] = []
        const raw: Array<{ ownerActorId?: string }> = []
        const seen = Promise.withResolvers<void>()
        const off = SessionRuntime.current().subscribe((event) => {
          if (event.properties.sessionID !== created.id || event.properties.event.type !== "session.error") return
          events.push(event)
          if (events.length === 2) seen.resolve()
        })
        const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID === created.id) raw.push(event.properties)
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => { off(); unsubscribe() }))
        const query = `?directory=${encodeURIComponent(directory)}`
        const response = yield* Effect.promise(async () => action === "resume"
          ? app.request(`/session/${created.id}/turn/${assistant.id}/resume${query}&agentID=worker&modelProviderID=test&modelID=missing`, { method: "POST" })
          : app.request(`/session/${created.id}/prompt_async${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentID: "worker", agent: "missing-agent", parts: [{ type: "text", text: "test" }] }) }))
        expect(response.status).toBe(action === "resume" ? 202 : 204)
        yield* Effect.promise(() => seen.promise).pipe(Effect.timeout("5 seconds"))
        yield* Effect.sleep("10 millis")
        expect(events).toHaveLength(2)
        expect(events.map((event) => event.properties.ownerActorId)).toEqual(["worker", "worker"])
        expect(events.map((event) => event.properties.event.properties.messageID)).toEqual([undefined, undefined])
        expect(events.map((event) => event.properties.event.properties.id)).toEqual(events.map((event) => `event:${event.properties.seq}`))
        expect(SessionRuntime.current().snapshot(created.id).errors.map((error) => error.id)).toEqual(events.map((event) => `event:${event.properties.seq}`))
        expect(raw.map((event) => event.ownerActorId)).toEqual(["worker", "worker"])
        expect(SessionRuntime.current().snapshot(created.id).actors.some((actor) => actor.actorID === "main" && actor.error)).toBe(false)
      }
    })),
  )

  // [TP-R17-03] [TP-R17-05]
  it.live("execution ownership covers runner gaps and stale release cannot affect the replacement instance", () =>
    provideTmpdirInstance((directory) => Effect.gen(function* () {
      const session = yield* Session.Service
      const executions = yield* ActorExecution.Service
      const runners = yield* SessionRunState.Service
      const created = yield* session.create()
      const runtime = SessionRuntime.current()
      const events: Envelope[] = []
      const off = runtime.subscribe((event) => events.push(event))
      yield* Effect.addFinalizer(() => Effect.sync(off))
      const response = yield* Effect.promise(async () => Server.Default().app.request("/event?runtime=1", { headers: { "x-mimocode-directory": directory } }))
      const stream = reader(response)
      yield* Effect.addFinalizer(() => Effect.promise(() => stream.cancel()))
      expect((yield* Effect.promise(() => stream.next()))?.type).toBe("runtime.ready")
      const owned = yield* executions.reserve(created.id, "worker")
      expect(runtime.snapshot(created.id).actors.find((actor) => actor.actorID === "worker")).toMatchObject({ executionActive: true, status: "running" })
      const info = user(created.id, "worker")
      for (let i = 0; i < 2; i++) {
        yield* runners.ensureRunning(created.id, "worker", Effect.succeed({ info, parts: [] }), Effect.succeed({ info, parts: [] }))
        expect(runtime.snapshot(created.id).actors.find((actor) => actor.actorID === "worker")).toMatchObject({ executionActive: true })
      }
      expect(events.filter((event) => event.properties.event.type === "actor.runtime").every((event) => (event.properties.event.properties.actor as { executionActive: boolean }).executionActive)).toBe(true)
      yield* executions.release(owned)
      expect(runtime.snapshot(created.id).actors.find((actor) => actor.actorID === "worker")).toMatchObject({ executionActive: false, status: "idle" })
      const expected = events.filter((event) => event.properties.event.type === "actor.runtime")
      const received: Envelope[] = []
      while (received.length < expected.length) {
        const frame = yield* Effect.promise(() => stream.next()).pipe(Effect.timeout("5 seconds"))
        if (frame?.type === "runtime.event" && (frame.properties.event as { type: string }).type === "actor.runtime") received.push(frame as Envelope)
      }
      expect(received).toEqual(expected)
      expect(received.at(-1)?.properties.event.properties.actor).toMatchObject({ executionActive: false })
      const stale = yield* executions.acquire(created.id, "worker")
      yield* Effect.promise(() => Instance.reload({ directory }))
      yield* Effect.gen(function* () {
        const fresh = SessionRuntime.current()
        expect(fresh.epoch).not.toBe(runtime.epoch)
        expect(yield* executions.current(created.id, "worker")).toBeUndefined()
        expect(fresh.snapshot(created.id).actors.some((actor) => actor.executionActive)).toBe(false)
        const next = yield* executions.acquire(created.id, "worker")
        const cut = fresh.snapshot(created.id)
        yield* executions.release(stale)
        expect(fresh.snapshot(created.id)).toEqual(cut)
        expect(yield* executions.current(created.id, "worker")).toBe(next)
        yield* executions.release(next)
        expect(fresh.snapshot(created.id).actors.find((actor) => actor.actorID === "worker")).toMatchObject({ executionActive: false })
      }).pipe(provideInstance(directory))
    })),
  )

  // [TP-R17-04]
  it.live("direct import replacement clears only touched overlays and rollback leaves the cut unchanged", () =>
    provideTmpdirInstance(() => Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create()
      const info = user(created.id)
      const native = user(created.id, "worker")
      const importedPart: MessageV2.TextPart = { id: PartID.ascending(), sessionID: created.id, messageID: info.id, type: "text", text: "x" }
      const nativePart: MessageV2.TextPart = { ...importedPart, id: PartID.ascending(), messageID: native.id }
      yield* session.updateMessage(info)
      yield* session.updateMessage(native)
      yield* session.updatePart(importedPart)
      yield* session.updatePart(nativePart)
      for (const part of [importedPart, nativePart]) yield* session.updatePartDelta({ sessionID: created.id, messageID: part.messageID, partID: part.id, field: "text", delta: "live" })
      const runtime = SessionRuntime.current()
      const before = runtime.snapshot(created.id)
      expect(() => Database.transaction((tx) => {
        SessionRuntime.observeImport(created.id, [info.id])
        tx.update(PartTable).set({ data: { type: "text", text: "rollback" } as typeof PartTable.$inferSelect.data }).where(eq(PartTable.id, importedPart.id)).run()
        throw new Error("rollback")
      })).toThrow("rollback")
      expect(runtime.snapshot(created.id)).toEqual(before)
      Database.transaction((tx) => {
        SessionRuntime.observeImport(created.id, [info.id])
        tx.update(PartTable).set({ data: { type: "text", text: "x" } as typeof PartTable.$inferSelect.data }).where(eq(PartTable.id, importedPart.id)).run()
      })
      const after = runtime.snapshot(created.id)
      expect(after.messages.find((message) => message.info.id === info.id)?.parts[0]).toMatchObject({ text: "x" })
      expect(after.messages.find((message) => message.info.id === native.id)?.parts[0]).toMatchObject({ text: "xlive" })
      expect(after.throughSeq).toBeGreaterThan(before.throughSeq)
    })),
  )

  // [TP-R17-05] [TP-R17-07]
  it.live("instance reload creates a new epoch and restores only durable history", () =>
    provideTmpdirInstance((directory) => Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create()
      const info = user(created.id)
      const part: MessageV2.TextPart = { id: PartID.ascending(), sessionID: created.id, messageID: info.id, type: "text", text: "durable" }
      yield* session.updateMessage(info)
      yield* session.updatePart(part)
      yield* session.updatePartDelta({ sessionID: created.id, messageID: info.id, partID: part.id, field: "text", delta: "live" })
      const old = SessionRuntime.current().snapshot(created.id)
      yield* Effect.promise(() => Instance.reload({ directory }))
      const next = yield* Effect.sync(() => SessionRuntime.current().snapshot(created.id)).pipe(provideInstance(directory))
      expect(next.epoch).not.toBe(old.epoch)
      expect(next.throughSeq).toBe(0)
      expect(next.messages[0].parts[0]).toMatchObject({ text: "durable" })
      expect(next.retries).toEqual([])
    })),
  )

  // [TP-R17-05]
  it.live("runtime overflow disconnects instead of delivering a silently truncated stream", () =>
    provideTmpdirInstance((directory) => Effect.gen(function* () {
      const previous = process.env.MIMOCODE_EVENT_QUEUE_CAPACITY
      process.env.MIMOCODE_EVENT_QUEUE_CAPACITY = "2"
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        if (previous === undefined) delete process.env.MIMOCODE_EVENT_QUEUE_CAPACITY
        else process.env.MIMOCODE_EVENT_QUEUE_CAPACITY = previous
      }))
      const session = yield* Session.Service
      const created = yield* session.create()
      const runtime = SessionRuntime.current()
      const response = yield* Effect.promise(async () => Server.Default().app.request("/event?runtime=1", { headers: { "x-mimocode-directory": directory } }))
      const stream = reader(response)
      expect((yield* Effect.promise(() => stream.next()))?.type).toBe("runtime.ready")
      for (let i = 0; i < 20; i++) runtime.retry(created.id, "main", { type: "retry", attempt: i + 1, message: "wait", next: i })
      let end = false
      for (let i = 0; i < 20; i++) {
        if (!(yield* Effect.promise(() => stream.next()))) { end = true; break }
      }
      expect(end).toBe(true)
      expect(runtime.snapshot(created.id).retries[0].status.attempt).toBe(20)
    })),
  )
})
