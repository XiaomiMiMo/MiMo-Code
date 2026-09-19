import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { MessageV2 } from "../../src/session/message-v2"
import { orphanToolIdleSweepRef } from "../../src/session/orphan-tool-idle-hook"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    // Shared Bus so the test can observe Event.Idle published by THIS Status
    // instance (the same one the test calls status.set on).
    SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

const seedRunningToolPart = (dir: string, sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID,
      agent: "default",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
      time: { created: Date.now() },
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant" as const,
      sessionID,
      mode: "default",
      agent: "default",
      path: { cwd: path.resolve(dir), root: path.resolve(dir) },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test"),
      parentID: user.id,
      time: { created: Date.now() },
    })
    return yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID,
      type: "tool" as const,
      tool: "bash",
      callID: `call-${assistant.id}`,
      state: {
        status: "running" as const,
        input: { command: "sleep 100" },
        title: "sleep 100",
        time: { start: Date.now() },
      },
    })
  })

const readPart = (sessionID: SessionID, partID: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    for (const m of yield* sessions.messages({ sessionID })) {
      const found = m.parts.find((p) => p.id === partID)
      if (found) return found
    }
    return undefined
  })

describe("sweepOrphanToolParts", () => {
  it.live("repairs a tool part orphaned at running when the session is idle", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedRunningToolPart(dir, session.id)

        yield* svc.sweepOrphanToolParts(session.id)

        const after = yield* readPart(session.id, part.id)
        expect(after?.type).toBe("tool")
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("error")
        if (after.state.status !== "error") throw new Error("expected an error state")
        expect(after.state.error).toBe("Tool execution aborted")
        expect(after.state.metadata?.interrupted).toBe(true)
        // The original start time survives so the transcript keeps its duration.
        expect(after.state.time.start).toBe(part.state.status === "running" ? part.state.time.start : 0)
      }),
    ),
  )

  it.live("leaves an in-flight tool part alone while the session is busy", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedRunningToolPart(dir, session.id)

        // A CURRENTLY EXECUTING tool is persisted as `running` too — this is the
        // half that matters: a sweep that fires here would corrupt a live turn.
        yield* status.set(session.id, { type: "busy" })
        yield* svc.sweepOrphanToolParts(session.id)

        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("running")
      }),
    ),
  )

  it.live("leaves a retrying session's tool part alone", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedRunningToolPart(dir, session.id)

        yield* status.set(session.id, { type: "retry", attempt: 1, message: "retrying", next: Date.now() + 1000 })
        yield* svc.sweepOrphanToolParts(session.id)

        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("running")
      }),
    ),
  )

  it.live("leaves completed tool parts untouched", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: session.id,
          agent: "default",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant" as const,
          sessionID: session.id,
          mode: "default",
          agent: "default",
          path: { cwd: path.resolve(dir), root: path.resolve(dir) },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          parentID: user.id,
          time: { created: Date.now() },
        })
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: session.id,
          type: "tool" as const,
          tool: "read",
          callID: `call-${assistant.id}`,
          state: {
            status: "completed" as const,
            input: {},
            output: "ok",
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })

        yield* svc.sweepOrphanToolParts(session.id)

        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("completed")
      }),
    ),
  )

  it.live("skips a running part that started after the before-cutoff", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedRunningToolPart(dir, session.id)
        const started = part.state.status === "running" ? part.state.time.start : Date.now()

        // Simulates the idle-edge sweep racing a new prompt: only parts that
        // were already running when the session went idle may be rewritten.
        yield* svc.sweepOrphanToolParts(session.id, { before: started - 1 })

        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("running")
      }),
    ),
  )

  it.live("idle transition rewrites an orphan running part without a new prompt", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        // Construct SessionPrompt so orphanToolIdleSweepRef is wired.
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedRunningToolPart(dir, session.id)

        // No SessionPrompt.prompt() call — only the idle edge. This is the
        // regression for: natural turn end left a tool `running`, Desktop
        // settled it as completed, then the next user message's entry sweep
        // emitted the abort into the NEW turn.
        yield* status.set(session.id, { type: "idle" })

        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("error")
        if (after.state.status !== "error") throw new Error("expected an error state")
        expect(after.state.error).toBe("Tool execution aborted")
        expect(after.state.metadata?.interrupted).toBe(true)
      }),
    ),
  )

  // [RL-ORPHAN-D01] Terminal tool states must complete BEFORE idle is announced.
  // Desktop finishes/unsubscribes on idle; abort after that reopens the original
  // bug one edge later.
  it.live("sweep completes before session.idle is published", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const bus = yield* Bus.Service
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedRunningToolPart(dir, session.id)

        const order: string[] = []
        const real = orphanToolIdleSweepRef.current
        expect(real).toBeDefined()
        orphanToolIdleSweepRef.current = (sid, opts) => {
          order.push("sweep")
          return real!(sid, opts)
        }
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Idle, (evt) => {
          if (evt.properties.sessionID === session.id) order.push("idle")
        })

        try {
          yield* status.set(session.id, { type: "idle" })
          // Bus delivery may be async relative to publish return; flush.
          yield* Effect.sleep("50 millis")
        } finally {
          off()
          orphanToolIdleSweepRef.current = real
        }

        expect(order).toEqual(["sweep", "idle"])
        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("error")
      }),
    ),
  )

  // [RL-ORPHAN-D01] Queryable idle must not open before orphans are terminal.
  // Desktop can finish from status.get() alone, not only from session.idle.
  it.live("status.get is not idle during the idle-commit sweep", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        yield* seedRunningToolPart(dir, session.id)

        yield* status.set(session.id, { type: "busy" })

        let statusDuringSweep: string | undefined
        const real = orphanToolIdleSweepRef.current
        expect(real).toBeDefined()
        orphanToolIdleSweepRef.current = (sid, opts) =>
          Effect.gen(function* () {
            statusDuringSweep = (yield* status.get(sid)).type
            yield* real!(sid, opts)
          })

        try {
          yield* status.set(session.id, { type: "idle" })
        } finally {
          orphanToolIdleSweepRef.current = real
        }

        expect(statusDuringSweep).toBe("busy")
        expect((yield* status.get(session.id)).type).toBe("idle")
      }),
    ),
  )

  // [RL-ORPHAN-D01] A newer busy during the idle-commit sweep must win: the
  // stale idle must not be published after the new turn's busy.
  it.live("does not publish idle when a newer busy wins during sweep", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const bus = yield* Bus.Service
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        yield* seedRunningToolPart(dir, session.id)
        yield* status.set(session.id, { type: "busy" })

        const events: string[] = []
        const real = orphanToolIdleSweepRef.current
        expect(real).toBeDefined()
        orphanToolIdleSweepRef.current = (sid, opts) =>
          Effect.gen(function* () {
            events.push("sweep-start")
            // Concurrent new turn starts mid-sweep.
            yield* status.set(sid, { type: "busy" })
            events.push("busy")
            yield* real!(sid, opts)
            events.push("sweep-end")
          })
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Idle, (evt) => {
          if (evt.properties.sessionID === session.id) events.push("idle")
        })
        const offStatus = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID === session.id) events.push(`status:${evt.properties.status.type}`)
        })

        try {
          yield* status.set(session.id, { type: "idle" })
          yield* Effect.sleep("50 millis")
        } finally {
          off()
          offStatus()
          orphanToolIdleSweepRef.current = real
        }

        expect(events).toContain("sweep-start")
        expect(events).toContain("busy")
        expect(events).not.toContain("idle")
        expect((yield* status.get(session.id)).type).toBe("busy")
      }),
    ),
  )
})

describe("MessageV2.abortedToolState", () => {
  it.live("keeps the original start time and stamps interrupted", () =>
    Effect.sync(() => {
      const state = MessageV2.abortedToolState({
        status: "running",
        input: { a: 1 },
        metadata: { foo: "bar" },
        time: { start: 42 },
      })
      expect(state.status).toBe("error")
      expect(state.input).toEqual({ a: 1 })
      expect(state.time.start).toBe(42)
      expect(state.metadata).toMatchObject({ foo: "bar", interrupted: true })
    }),
  )

  it.live("synthesizes a start time for a pending part", () =>
    Effect.sync(() => {
      const state = MessageV2.abortedToolState({ status: "pending", input: {}, raw: "" })
      expect(state.status).toBe("error")
      expect(state.time.start).toBe(state.time.end)
      expect(state.metadata?.interrupted).toBe(true)
    }),
  )
})
