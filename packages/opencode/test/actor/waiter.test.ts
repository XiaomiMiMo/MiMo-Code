import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session as SessionNs } from "../../src/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ActorRegistry } from "../../src/actor/registry"
import { DEFAULT_LIVENESS_ABANDON_MS } from "../../src/actor/schema"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { Database, and, eq } from "../../src/storage"
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
  ActorWaiter.layer.pipe(Layer.provide(ActorRegistry.defaultLayer), Layer.provide(Bus.layer), Layer.provide(SessionNs.defaultLayer)),
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

  // Test 5: slow path — status flips during wait → callback resolves
  // NOTE: This test is skipped in full-suite runs due to a cross-test Effect-runtime
  // issue documented in the original waiter.test.ts (see the describe.skip comment).
  // The feature works in production; the hang is in scope-close after the Deferred
  // resolves, caused by cross-runtime interaction when other tests have pre-built
  // AppRuntime at module scope.
  it.live.skip(
    "slow path: status flips during wait, callback resolves with idle/success",
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

        // Fork: after 50ms, flip to idle/success and seed a result message
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* Effect.sleep("50 millis")
            yield* seedAssistantText(parent.id, "explore-2", "result from slow path")
            yield* registry.updateStatus(parent.id, "explore-2", { status: "idle", lastOutcome: "success" })
          }),
        )

        const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "explore-2", timeout_ms: 2000 })

        expect(snap.status).toBe("idle")
        expect(snap.lastOutcome).toBe("success")
        expect(snap.result).toBe("result from slow path")
      }),
    ),
  )
})

// The send-then-wait follow-up path, assembled from the two pieces that make it
// work: Inbox.send's markPending (an actor with a queued message is no longer
// idle) and SessionPrompt.loop wrapping the woken turn in runTurn (so it moves
// running → idle+outcome and publishes, exactly like a spawn turn).
//
// Without markPending, wait's fast path sees the row still idle+ephemeral from
// the PREVIOUS turn and answers from the slice's last assistant message — the
// previous turn's text. Without the runTurn wrapper, nothing ever publishes the
// woken turn's completion, so a subscribed wait can only time out.
describe("ActorWaiter — woken turn (send then wait)", () => {
  it.live(
    "a queued-message actor is not wait-resolving, and wait returns the woken turn's result",
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
          background: true,
          lifecycle: "ephemeral",
        })

        // Turn 1 settled — as a FAILURE, so the revived row's fields are visibly
        // the new turn's rather than the finished one's.
        yield* seedAssistantText(parent.id, "explore-1", "FIRST ANSWER")
        yield* registry.updateStatus(parent.id, "explore-1", {
          status: "idle",
          lastOutcome: "failure",
          lastError: "previous turn blew up",
        })

        // Inbox.send's pre-wake step.
        yield* registry.markPending(parent.id, "explore-1")
        const queued = yield* registry.get(parent.id, "explore-1")
        expect(queued?.status).toBe("pending")
        expect(queued?.lastOutcome).toBeUndefined()
        expect(queued?.lastError).toBeUndefined()

        // `wait` subscribes first, then the woken turn runs on the main fiber —
        // wrapped the way SessionPrompt.loop now wraps it.
        const waiting = yield* waiter
          .wait({ sessionID: parent.id, actor_id: "explore-1", timeout_ms: 5000 })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep("100 millis")
        yield* runTurn(
          parent.id,
          "explore-1",
          // runTurn takes a self-contained work Effect, so hand it the session
          // service the seed needs.
          seedAssistantText(parent.id, "explore-1", "SECOND ANSWER").pipe(
            Effect.provideService(SessionNs.Service, sessions),
          ),
        ).pipe(Effect.provideService(ActorRegistry.Service, registry))

        const snap = yield* Fiber.join(waiting)

        expect(snap.status).toBe("idle")
        expect(snap.lastOutcome).toBe("success")
        expect(snap.result).toBe("SECOND ANSWER")
      }),
    ),
  )

  it.live(
    "markPending leaves a running actor alone",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service

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
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(parent.id, "explore-1", { status: "running" })

        yield* registry.markPending(parent.id, "explore-1")

        expect((yield* registry.get(parent.id, "explore-1"))?.status).toBe("running")
      }),
    ),
  )

  it.live(
    "waking a long-idle actor does not read as stalled",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service

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
          background: true,
          lifecycle: "ephemeral",
        })
        yield* seedAssistantText(parent.id, "explore-1", "answered ages ago")
        yield* registry.updateStatus(parent.id, "explore-1", { status: "idle", lastOutcome: "success" })

        // Its last real activity predates both the stall and the abandon bound,
        // which is the normal state of a subagent the parent comes back to later.
        const longAgo = Date.now() - 3 * DEFAULT_LIVENESS_ABANDON_MS
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(ActorRegistryTable)
              .set({ last_activity_time: longAgo, time_created: longAgo })
              .where(
                and(
                  eq(ActorRegistryTable.session_id, parent.id),
                  eq(ActorRegistryTable.actor_id, "explore-1"),
                ),
              )
              .run(),
          ),
        )

        yield* registry.markPending(parent.id, "explore-1")

        const live = yield* registry.liveness(parent.id, "explore-1")
        expect(live?.actor.status).toBe("pending")
        expect(live?.liveness).toBe("progressing")
        // The finished turn's terminal fields must not travel with the revived row.
        expect(live?.actor.lastOutcome).toBeUndefined()
        expect(live?.actor.time.completed).toBeUndefined()
      }),
    ),
  )
})
