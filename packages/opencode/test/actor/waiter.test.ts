import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session as SessionNs } from "../../src/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { runTurn } from "../../src/actor/turn"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ProviderID, ModelID } from "../../src/provider/schema"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Bus.layer,
  ActorRegistry.defaultLayer,
  ActorWaiter.layer.pipe(
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionNs.defaultLayer),
  ),
)

const it = testEffect(env)

// Helper: seed an assistant message with a text part in the actor's slice.
// Mirrors the pattern in test/session/revert-compact.test.ts.
const seedAssistantText = (sessionID: SessionID, actorID: string, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    // First seed a parent user message so parentID is valid
    const userMsg = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID,
      agentID: actorID,
      time: { created: Date.now() },
      agent: "general",
      model: {
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
      },
    })
    const msgID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: msgID,
      role: "assistant" as const,
      sessionID,
      agentID: actorID,
      mode: "default",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test"),
      parentID: userMsg.id,
      time: { created: Date.now() },
      finish: "end_turn",
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msgID,
      sessionID,
      type: "text" as const,
      text,
    })
  })

describe("ActorWaiter — lifecycle predicate (Plan 3 / Task 3)", () => {
  it.live(
    "[TP-R14-11] failure reads the referenced structured delivery rather than newer text",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service
        const parent = yield* sessions.create({ title: "structured partial" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "child",
          mode: "subagent",
          agent: "general",
          description: "child",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* seedAssistantText(parent.id, "child", "raw text")
        const delivery = (yield* sessions.messages({ sessionID: parent.id, agentID: "child" })).findLast(
          (m) => m.info.role === "assistant",
        )!
        if (delivery.info.role !== "assistant") throw new Error("missing assistant")
        yield* sessions.updateMessage({ ...delivery.info, actorResult: { structured: { answer: 42 } } })
        yield* seedAssistantText(parent.id, "child", "UNRELATED-NEWER-TEXT")
        yield* registry.updateStatus(parent.id, "child", {
          status: "idle",
          lastOutcome: "failure",
          lastError: "verification failed",
          resultMessageID: delivery.info.id,
        })
        const snapshot = yield* waiter.wait({ sessionID: parent.id, actor_id: "child" })
        expect(snapshot.lastOutcome).toBe("failure")
        expect(snapshot.structured).toEqual({ answer: 42 })
        expect(snapshot.result).toBeUndefined()
      }),
    ),
  )
  for (const previousOutcome of ["success", "failure"] as const) {
    it.live(
      `[TP-R14-11] failure without output does not reuse a previous ${previousOutcome} delivery`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const registry = yield* ActorRegistry.Service
          const waiter = yield* ActorWaiter.Service
          const parent = yield* sessions.create({ title: "delivery isolation" })
          yield* registry.register({
            sessionID: parent.id,
            actorID: "child",
            mode: "subagent",
            agent: "general",
            description: "child",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* seedAssistantText(parent.id, "child", "OLD-RESULT")
          const message = (yield* sessions.messages({ sessionID: parent.id, agentID: "child" })).findLast(
            (m) => m.info.role === "assistant",
          )!
          if (message.info.role !== "assistant") throw new Error("missing assistant")
          yield* sessions.updateMessage({ ...message.info, actorResult: { finalText: "OLD-RESULT" } })
          yield* registry.updateStatus(parent.id, "child", {
            status: "idle",
            lastOutcome: previousOutcome,
            resultMessageID: message.info.id,
          })
          expect((yield* waiter.wait({ sessionID: parent.id, actor_id: "child" })).result).toBe("OLD-RESULT")
          yield* runTurn(parent.id, "child", Effect.fail("CURRENT-FAILURE")).pipe(Effect.exit)
          const current = yield* waiter.wait({ sessionID: parent.id, actor_id: "child" })
          expect(current.lastOutcome).toBe("failure")
          expect(current.error).toContain("CURRENT-FAILURE")
          expect(current.result).toBeUndefined()
          expect(current.structured).toBeUndefined()
          expect((yield* registry.get(parent.id, "child"))?.resultMessageID).toBeUndefined()
          const prior = (yield* sessions.messages({ sessionID: parent.id, agentID: "child" })).find(
            (m) => m.info.id === message.info.id,
          )!
          if (prior.info.role === "assistant") expect(prior.info.actorResult?.finalText).toBe("OLD-RESULT")
        }),
      ),
    )
  }
  // Test 1: ephemeral idle/success → resolves with result from slice's last assistant
  it.live(
    "ephemeral idle/success resolves with result text from last assistant message",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service

        const parent = yield* sessions.create({ title: "parent" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "explore-1",
          mode: "subagent",
          parentActorID: undefined,
          agent: "explore",
          description: "explore task",
          contextMode: "none",
          contextWatermark: undefined,
          background: false,
          lifecycle: "ephemeral",
        })

        // Seed an assistant message with text "done" in explore-1's slice
        yield* seedAssistantText(parent.id, "explore-1", "done")

        yield* registry.updateStatus(parent.id, "explore-1", { status: "idle", lastOutcome: "success" })

        const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "explore-1" })

        expect(snap.status).toBe("idle")
        expect(snap.lastOutcome).toBe("success")
        expect(snap.actor_id).toBe("explore-1")
        expect(snap.result).toBe("done")
      }),
    ),
  )

  // Test 2: persistent idle/success → does NOT resolve; times out
  it.live(
    "persistent idle/success does not resolve — wait returns timeout",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service

        const parent = yield* sessions.create({ title: "parent" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "peer-1",
          mode: "peer",
          parentActorID: undefined,
          agent: "general",
          description: "persistent peer",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "persistent",
        })
        yield* registry.updateStatus(parent.id, "peer-1", { status: "idle", lastOutcome: "success" })

        const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "peer-1", timeout_ms: 200 })

        expect(snap.status).toBe("timeout")
      }),
    ),
  )

  // Test 3: persistent idle/failure → resolves
  it.live(
    "persistent idle/failure resolves with error in snapshot",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service

        const parent = yield* sessions.create({ title: "parent" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "peer-2",
          mode: "peer",
          parentActorID: undefined,
          agent: "general",
          description: "persistent peer fail",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "persistent",
        })
        yield* registry.updateStatus(parent.id, "peer-2", {
          status: "idle",
          lastOutcome: "failure",
          lastError: "boom",
        })

        const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "peer-2" })

        expect(snap.status).toBe("idle")
        expect(snap.lastOutcome).toBe("failure")
        expect(snap.error).toBe("boom")
      }),
    ),
  )

  // Desktop tool-step-schema [TP-R14-11]: a missed event at the timeout
  // boundary must not hide a persisted failure/cancellation.
  for (const lastOutcome of ["failure", "cancelled"] as const) {
    it.live(
      `[TP-R14-11] timeout performs a final registry read for ${lastOutcome}`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const registry = yield* ActorRegistry.Service
          const parent = yield* sessions.create({ title: "timeout boundary" })
          yield* registry.register({
            sessionID: parent.id,
            actorID: "child",
            mode: "subagent",
            agent: "general",
            description: "child",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* registry.updateStatus(parent.id, "child", { status: "running" })
          let reads = 0
          const waiter = yield* Effect.gen(function* () {
            return yield* ActorWaiter.Service
          }).pipe(
            Effect.provide(Layer.fresh(ActorWaiter.layer)),
            Effect.provideService(
              ActorRegistry.Service,
              ActorRegistry.Service.of({
                ...registry,
                get: (sid, aid) =>
                  Effect.gen(function* () {
                    const entry = yield* registry.get(sid, aid)
                    reads++
                    // Simulate a commit after the subscription recheck has read its
                    // snapshot. The bus callback in this test deliberately gets no event.
                    if (reads === 2)
                      yield* registry.updateStatus(sid, aid, {
                        status: "idle",
                        lastOutcome,
                        lastError: lastOutcome === "failure" ? "boom" : undefined,
                      })
                    return entry
                  }),
              }),
            ),
            Effect.provideService(
              Bus.Service,
              Bus.Service.of({
                ...(yield* Bus.Service),
                subscribeCallback: () => Effect.succeed(() => {}),
              }),
            ),
          )
          const result = yield* waiter.wait({ sessionID: parent.id, actor_id: "child", timeout_ms: 10 })
          expect(result.lastOutcome).toBe(lastOutcome)
          expect(result.status).toBe("idle")
          expect(result.error).toBe(lastOutcome === "failure" ? "boom" : undefined)
          expect(reads).toBe(3)
        }),
      ),
    )
  }

  // Test 4: unknown actor → status: "unknown"
  it.live(
    "unknown actor returns status: unknown",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const waiter = yield* ActorWaiter.Service

        const snap = yield* waiter.wait({
          sessionID: SessionID.make("ses_never_existed"),
          actor_id: "ghost",
        })

        expect(snap.status).toBe("unknown")
        expect(snap.actor_id).toBe("ghost")
      }),
    ),
  )

  for (const lastOutcome of ["success", "failure", "cancelled"] as const) {
    it.live(
      `[TP-R14-11] slow path: status flips during wait, callback resolves with ${lastOutcome}`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const registry = yield* ActorRegistry.Service
          const waiter = yield* ActorWaiter.Service

          const parent = yield* sessions.create({ title: "parent" })
          yield* registry.register({
            sessionID: parent.id,
            actorID: "explore-2",
            mode: "subagent",
            parentActorID: undefined,
            agent: "explore",
            description: "in-flight",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          })
          yield* registry.updateStatus(parent.id, "explore-2", { status: "running" })

          yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Effect.sleep("50 millis")
              yield* seedAssistantText(parent.id, "explore-2", "result from slow path")
              yield* registry.updateStatus(parent.id, "explore-2", {
                status: "idle",
                lastOutcome,
                lastError: lastOutcome === "failure" ? "execution failed" : undefined,
              })
            }),
          )

          const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "explore-2", timeout_ms: 2000 })

          expect(snap.status).toBe("idle")
          expect(snap.lastOutcome).toBe(lastOutcome)
          expect(snap.result).toBe(lastOutcome === "success" ? "result from slow path" : undefined)
          expect(snap.error).toBe(lastOutcome === "failure" ? "execution failed" : undefined)
        }),
      ),
    )
  }
})
