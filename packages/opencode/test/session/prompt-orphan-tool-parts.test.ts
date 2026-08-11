import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { MessageV2 } from "../../src/session/message-v2"
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
    SessionStatus.defaultLayer,
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
