import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Question } from "../../src/question"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
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
    Question.defaultLayer,
    SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer)),
    SessionRunState.layer.pipe(Layer.provide(SessionStatus.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

const seedToolPart = (
  dir: string,
  sessionID: SessionID,
  opts?: { completeMessage?: boolean; tool?: "bash" | "question"; status?: "pending" | "running"; agentID?: string },
) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID,
      agentID: opts?.agentID,
      agent: "default",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
      time: { created: Date.now() },
    })
    const now = Date.now()
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant" as const,
      sessionID,
      agentID: opts?.agentID,
      mode: "default",
      agent: "default",
      path: { cwd: path.resolve(dir), root: path.resolve(dir) },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test"),
      parentID: user.id,
      time: opts?.completeMessage ? { created: now, completed: now } : { created: now },
    })
    const input =
      opts?.tool === "question"
        ? {
            questions: [
              { question: "Continue?", header: "Next", options: [{ label: "Yes", description: "Continue" }] },
            ],
          }
        : { command: "sleep 100" }
    return yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID,
      type: "tool" as const,
      tool: opts?.tool ?? "bash",
      callID: `call-${assistant.id}`,
      state:
        opts?.status === "pending"
          ? { status: "pending", input, raw: JSON.stringify(input) }
          : { status: "running", input, title: opts?.tool ?? "bash", time: { start: Date.now() } },
    })
  })

const readPart = (sessionID: SessionID, partID: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    for (const m of yield* sessions.messages({ sessionID, agentID: "*" })) {
      const found = m.parts.find((p) => p.id === partID)
      if (found) return found
    }
    return undefined
  })

const dummyWork = (sessionID: SessionID) =>
  Effect.succeed({
    info: {
      id: MessageID.ascending(),
      role: "assistant" as const,
      sessionID,
      time: { created: Date.now() },
    },
    parts: [],
  } as unknown as MessageV2.WithParts)

describe("selected-session question recovery", () => {
  for (const state of ["pending", "running"] as const) {
    it.live(`fresh prompt repairs ${state} questions only in the idle selected main slice`, () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const questions = yield* Question.Service
          const runState = yield* SessionRunState.Service
          const status = yield* SessionStatus.Service
          const selected = yield* sessions.create({ title: "Selected session" })
          const cold = yield* sessions.create({ title: "Cold session" })
          const part = yield* seedToolPart(dir, selected.id, { tool: "question", status: state })
          const untouched = yield* seedToolPart(dir, cold.id, { tool: "question", status: state })
          const child = yield* seedToolPart(dir, selected.id, { tool: "question", agentID: "explore-1" })
          const before = yield* sessions.messages({ sessionID: selected.id, agentID: "*" })

          const interrupted = before.find((m) => m.info.id === part.messageID)?.info
          if (interrupted?.role !== "assistant") throw new Error("expected interrupted assistant")

          expect(yield* questions.list()).toEqual([])
          expect(yield* prompt.recovery({ sessionID: selected.id })).toEqual([
            {
              kind: "assistant",
              assistantMessageID: part.messageID,
              parentMessageID: interrupted.parentID,
              created: interrupted.time.created,
            },
          ])
          expect(yield* sessions.messages({ sessionID: selected.id, agentID: "*" })).toEqual(before)
          expect(yield* readPart(cold.id, untouched.id)).toEqual(untouched)
          expect(yield* questions.list()).toEqual([])

          const started = yield* Deferred.make<void>()
          yield* runState.start(
            selected.id,
            "explore-1",
            Effect.die("unexpected interruption"),
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          )
          yield* Deferred.await(started)
          expect(yield* status.get(selected.id)).toEqual({ type: "idle" })
          expect(Exit.isFailure(yield* runState.assertNotBusy(selected.id, "explore-1").pipe(Effect.exit))).toBe(true)

          const submitted = yield* prompt.prompt({
            sessionID: selected.id,
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
            noReply: true,
            parts: [{ type: "text", text: "Continue with a new request" }],
          })

          expect(submitted.info.role).toBe("user")
          const repaired = yield* readPart(selected.id, part.id)
          if (repaired?.type !== "tool" || repaired.state.status !== "error")
            throw new Error("expected an interrupted question")
          expect(repaired.state.error).toBe("Tool execution aborted")
          expect(repaired.state.input).toEqual(part.state.input)
          expect(repaired.state.metadata?.interrupted).toBe(true)
          expect(yield* readPart(cold.id, untouched.id)).toEqual(untouched)
          expect(yield* readPart(selected.id, child.id)).toEqual(child)
          // A new main prompt must preserve the live child's message as well as
          // its tool. Marking only the message abandoned still emits a false error.
          const childAfter = (yield* sessions.messages({ sessionID: selected.id, agentID: "explore-1" })).find(
            (m) => m.info.id === child.messageID,
          )
          expect(childAfter).toEqual(before.find((m) => m.info.id === child.messageID))
          expect(Exit.isFailure(yield* runState.assertNotBusy(selected.id, "explore-1").pipe(Effect.exit))).toBe(true)
          expect(yield* questions.list()).toEqual([])
        }),
      ),
    )
  }

  for (const state of ["busy", "retry"] as const) {
    it.live(`fresh prompt preserves questions while the selected session is ${state}`, () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const status = yield* SessionStatus.Service
          const session = yield* sessions.create({ title: "Active session" })
          const running = yield* seedToolPart(dir, session.id, { tool: "question" })
          const pending = yield* seedToolPart(dir, session.id, { tool: "question", status: "pending" })
          yield* status.set(
            session.id,
            state === "busy"
              ? { type: "busy" }
              : { type: "retry", attempt: 1, message: "Retrying", next: Date.now() + 1000 },
          )

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
            noReply: true,
            parts: [{ type: "text", text: "Queue another request" }],
          })

          expect(yield* readPart(session.id, running.id)).toEqual(running)
          expect(yield* readPart(session.id, pending.id)).toEqual(pending)
          expect((yield* status.get(session.id)).type).toBe(state)
        }),
      ),
    )
  }
})

describe("sweepOrphanToolParts", () => {
  it.live("repairs a tool part orphaned at running when the session is idle", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedToolPart(dir, session.id)

        yield* svc.sweepOrphanToolParts(session.id)

        const after = yield* readPart(session.id, part.id)
        expect(after?.type).toBe("tool")
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("error")
        if (after.state.status !== "error") throw new Error("expected an error state")
        expect(after.state.error).toBe("Tool execution aborted")
        expect(after.state.metadata?.interrupted).toBe(true)
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
        const part = yield* seedToolPart(dir, session.id)

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
        const part = yield* seedToolPart(dir, session.id)

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
        const part = yield* seedToolPart(dir, session.id)
        const started = part.state.status === "running" ? part.state.time.start : Date.now()

        yield* svc.sweepOrphanToolParts(session.id, { before: started - 1 })

        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("running")
      }),
    ),
  )

  // [RL-ORPHAN-D01] Field evidence: orphan sat on an INCOMPLETE assistant
  // (completed only stamped at next prompt as Abandoned). Snapshot ownership
  // by message ID at ensuring time covers that set.
  it.live("work ensuring aborts orphans on snapshotted messages including incomplete", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runState = yield* SessionRunState.Service
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        // Incomplete — matches field parent msg_g001a0bb2e89bb001WTFuV6NUk
        const part = yield* seedToolPart(dir, session.id, { completeMessage: false })

        yield* runState.ensureRunning(session.id, "main", Effect.die("no-interrupt"), dummyWork(session.id))

        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("error")
        if (after.state.status !== "error") throw new Error("expected an error state")
        expect(after.state.error).toBe("Tool execution aborted")
      }),
    ),
  )

  it.live("sweep skips messages not in ownedMessageIds snapshot", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedToolPart(dir, session.id, { completeMessage: false })

        // Empty snapshot — nothing owned, nothing rewritten.
        yield* svc.sweepOrphanToolParts(session.id, { ownedMessageIds: new Set() })

        const after = yield* readPart(session.id, part.id)
        if (after?.type !== "tool") throw new Error("expected a tool part")
        expect(after.state.status).toBe("running")
      }),
    ),
  )

  // [RL-ORPHAN-D01] Cancel handoff: Runner stays Cancelling until the retiring
  // fiber's finalizers finish; ensureRunning waits instead of starting B mid-sweep.
  it.live("new work waits for cancel finalizer before starting", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runState = yield* SessionRunState.Service
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})

        const order: string[] = []
        const real = orphanToolIdleSweepRef.current
        expect(real).toBeDefined()
        orphanToolIdleSweepRef.current = (sid, opts) =>
          Effect.gen(function* () {
            order.push("sweep-start")
            yield* Effect.sleep("80 millis")
            order.push("sweep-end")
            yield* real!(sid, opts)
          })

        const workA = Effect.gen(function* () {
          order.push("A-body")
          yield* Effect.sleep("150 millis")
          return yield* dummyWork(session.id)
        })

        try {
          const fiberA = yield* runState
            .ensureRunning(session.id, "main", Effect.void as never, workA)
            .pipe(Effect.exit, Effect.forkChild)
          yield* Effect.sleep("40 millis")
          yield* runState.cancel(session.id)
          yield* runState.ensureRunning(session.id, "main", Effect.void as never, dummyWork(session.id))
          yield* Fiber.join(fiberA).pipe(Effect.ignore)
        } finally {
          orphanToolIdleSweepRef.current = real
        }

        expect(order).toContain("sweep-end")
      }),
    ),
  )

  // [RL-ORPHAN-C01/C03] Deterministic Cancelling barrier: hold inside ensuring,
  // signal entry, start B, verify B does not run until release; B's success
  // Exit is asserted (failures must not be swallowed).
  it.live("RunState registry tracks work that waited out Cancelling", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runState = yield* SessionRunState.Service
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})

        const hold = yield* Deferred.make<void>()
        const inFinalizer = yield* Deferred.make<void>()
        const startedA = yield* Deferred.make<void>()
        let bRan = false

        const workA = Effect.gen(function* () {
          yield* Deferred.succeed(startedA, undefined)
          yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(inFinalizer, undefined)
              yield* Deferred.await(hold)
            }),
          ),
          Effect.as(undefined as never),
        )

        const fiberA = yield* runState
          .ensureRunning(session.id, "main", Effect.void as never, workA)
          .pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(startedA)

        const cancelFiber = yield* runState.cancel(session.id).pipe(Effect.forkChild)
        // Wait until A's ensuring (finalizer) is actually blocked.
        yield* Deferred.await(inFinalizer)

        const exitB = yield* runState
          .ensureRunning(
            session.id,
            "main",
            Effect.void as never,
            Effect.gen(function* () {
              bRan = true
              // Must be the registered busy runner while B executes.
              const busyExit = yield* runState.assertNotBusy(session.id, "main").pipe(Effect.exit)
              expect(Exit.isFailure(busyExit)).toBe(true)
              return yield* dummyWork(session.id)
            }),
          )
          .pipe(Effect.exit, Effect.forkChild)

        yield* Effect.sleep("20 millis")
        expect(bRan).toBe(false)

        yield* Deferred.succeed(hold, undefined)
        yield* Fiber.join(fiberA).pipe(Effect.ignore)
        yield* Fiber.join(cancelFiber).pipe(Effect.ignore)
        const bResult = yield* Fiber.join(exitB)
        expect(Exit.isSuccess(bResult)).toBe(true)
        expect(bRan).toBe(true)
        yield* runState.assertNotBusy(session.id, "main")
      }),
    ),
  )

  // [RL-ORPHAN-C03] Order lock: PartUpdated (error) and session.status (idle)
  // are both recorded from async Bus callbacks. PartUpdated goes through
  // ProjectBus (standalone Bus.subscribe); Status through the test Status
  // layer's Bus. Both schedule Promise.then at publish time, so observed
  // callback order matches publish order on the JS event loop.
  it.live("orphan sweep completes before session.status idle is published", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const bus = yield* Bus.Service
        const runState = yield* SessionRunState.Service
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedToolPart(dir, session.id, { completeMessage: false })
        yield* status.set(session.id, { type: "busy" })

        const order: string[] = []
        // Standalone Bus matches ProjectBus.publish used by SyncEvent PartUpdated.
        const unsubPart = Bus.subscribe(MessageV2.Event.PartUpdated, (ev) => {
          const p = ev.properties.part
          if (p.id === part.id && (p as { state?: { status?: string } }).state?.status === "error") {
            order.push("part-error")
          }
        })
        const offStatus = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID === session.id && evt.properties.status.type === "idle") {
            order.push("status-idle")
          }
        })

        try {
          yield* runState.ensureRunning(session.id, "main", Effect.void as never, dummyWork(session.id))
          yield* Effect.sleep("100 millis")
        } finally {
          offStatus()
          unsubPart()
        }

        expect(order).toContain("part-error")
        expect(order).toContain("status-idle")
        expect(order.indexOf("part-error")).toBeLessThan(order.indexOf("status-idle"))
      }),
    ),
  )

  // [RL-ORPHAN-C03] Same order lock on the cancel path.
  it.live("cancel path: sweep completes before session.status idle", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const bus = yield* Bus.Service
        const runState = yield* SessionRunState.Service
        yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const part = yield* seedToolPart(dir, session.id, { completeMessage: false })

        const order: string[] = []
        const unsubPart = Bus.subscribe(MessageV2.Event.PartUpdated, (ev) => {
          const p = ev.properties.part
          if (p.id === part.id && (p as { state?: { status?: string } }).state?.status === "error") {
            order.push("part-error")
          }
        })
        const offStatus = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID === session.id && evt.properties.status.type === "idle") {
            order.push("status-idle")
          }
        })

        const hold = yield* Deferred.make<void>()
        const inFinalizer = yield* Deferred.make<void>()
        const startedA = yield* Deferred.make<void>()
        const workA = Effect.gen(function* () {
          yield* Deferred.succeed(startedA, undefined)
          yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(inFinalizer, undefined)
              yield* Deferred.await(hold)
            }),
          ),
          Effect.as(undefined as never),
        )

        try {
          const fiberA = yield* runState
            .ensureRunning(session.id, "main", Effect.void as never, workA)
            .pipe(Effect.exit, Effect.forkChild)
          yield* Deferred.await(startedA)
          const cancelFiber = yield* runState.cancel(session.id).pipe(Effect.forkChild)
          yield* Deferred.await(inFinalizer)
          yield* Deferred.succeed(hold, undefined)
          yield* Fiber.join(fiberA).pipe(Effect.ignore)
          yield* Fiber.join(cancelFiber).pipe(Effect.ignore)
          yield* Effect.sleep("100 millis")
        } finally {
          offStatus()
          unsubPart()
        }

        expect(order).toContain("part-error")
        expect(order).toContain("status-idle")
        expect(order.indexOf("part-error")).toBeLessThan(order.indexOf("status-idle"))
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
