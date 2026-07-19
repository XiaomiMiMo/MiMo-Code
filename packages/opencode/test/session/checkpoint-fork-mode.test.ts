import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import { Actor, type AgentOutcome } from "../../src/actor/spawn"
import { spawnRef } from "../../src/actor/spawn-ref"
import { prefixCaptureRef, type PrefixCaptureFn } from "../../src/session/prefix-capture-ref"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Database } from "../../src/storage"
import { SessionTable } from "../../src/session/session.sql"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Closure-shared state. spawnLog captures Actor.spawn input (forkContext shape).
// captureLog captures the prefix-capture function calls (agentName + msgs[0] info).
// settle: when true, actor.spawn settles outcome with success immediately so the
// settle watcher fires deterministically (mirrors checkpoint-child-session.test.ts).
const spawnLog: { count: number; lastInput?: { sessionID: string; mode: string; forkContext?: unknown } } = { count: 0 }
const captureLog: { calls: Array<{ sessionID: string; agentName: string; msgsLen: number; firstMsgRole?: string; firstMsgID?: string }> } = { calls: [] }

// Actor stub: records spawn input (incl. forkContext) and settles outcome with
// success immediately so the writer doesn't hang the test.
const recordingActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prevSpawnRef = spawnRef.current
    let counter = 0
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          counter += 1
          spawnLog.count = counter
          spawnLog.lastInput = { sessionID: input.sessionID, mode: input.mode, forkContext: input.forkContext }
          const outcome = yield* Deferred.make<AgentOutcome>()
          yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
          return {
            actorID: `${input.agentType}-${counter}`,
            sessionID: input.sessionID,
            outcome,
          }
        }),
      cancel: () => Effect.void,
      getForkContext: () => Effect.succeed(undefined),
    })
    spawnRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = prevSpawnRef
      }),
    )
    return impl
  }),
)

// Custom prefix-capture closure — records its args and returns canned values.
// Used to assert what tryStartCheckpointWriter passes to the prefix-capture
// helper for each (forkMode, lastCheckpointMessageID) combination. Returns
// non-empty system/tools so the resulting forkCtx is non-undefined.
function installRecordingCapture() {
  const fn: PrefixCaptureFn = (input) =>
    Effect.sync(() => {
      const first = (input.msgs[0] as { info?: { role?: string; id?: string } } | undefined)?.info
      captureLog.calls.push({
        sessionID: input.sessionID,
        agentName: input.agentName,
        msgsLen: input.msgs.length,
        firstMsgRole: first?.role,
        firstMsgID: first?.id,
      })
      return {
        system: ["sys-canned"],
        tools: {},
        inheritedMessages: [{ role: "user" as const, content: "canned" } as never],
        parentPermission: [],
      }
    })
  prefixCaptureRef.current = fn
}

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  Memory.defaultLayer,
  TaskRegistry.defaultLayer,
  ActorRegistry.defaultLayer,
  recordingActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const reset = Effect.sync(() => {
  spawnLog.count = 0
  spawnLog.lastInput = undefined
  captureLog.calls = []
  prefixCaptureRef.current = undefined
})

// Seed parent session with msgs sequence: u1(text)/a1(tool)/u2(tool_result)/a2(text)
// a2 has finish="stop" so computeBoundary picks lastAsstIdx=3, startIdx=2 (u2)
// → endMessageID = u2.id, watermarkIdx = 2.
//
// computeBoundary requires the natural tail (msgs[startIdx..]) to be ≥ 20K tokens
// (TAIL_MAX_TOKENS) — otherwise it walks back further to satisfy the floor.
// We pad u2's tool_result body and a2's text with ~50K chars each (~12.5K tokens
// each, ~25K combined) so the tail at startIdx=2 already exceeds TAIL_MAX_TOKENS
// and the boundary stays at u2.
//
// u2 is seeded with a synthetic part of type "tool_result" to exercise the
// alignToNonToolResultUser helper: when rawDeltaStart=2 (u2), align must walk
// back past u2 to u1 (idx 0) because u2's parts are all tool_result-only.
// OpenCode's storage doesn't normally produce tool_result parts (tools are
// unified on assistants), so we use `as never` to bypass the discriminated
// union — the helper only inspects part.type as a string.
const PAD = "x ".repeat(25_000)  // ~50K chars → ~12.5K tokens
const seedFourMessages = Effect.fn("seedFourMessages")(function* () {
  const ssn = yield* SessionNs.Service
  const info = yield* ssn.create({})
  const t0 = Date.now()

  const u1 = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: info.id,
    agent: "build",
    model: ref,
    time: { created: t0 },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: u1.id,
    sessionID: info.id,
    type: "text",
    text: "u1 prompt",
  })

  const a1 = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: info.id,
    agent: "build",
    parentID: u1.id,
    providerID: ref.providerID,
    modelID: ref.modelID,
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: t0 + 1 },
    finish: "tool-calls",
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: a1.id,
    sessionID: info.id,
    type: "tool",
    tool: "read",
    callID: `call-${a1.id}`,
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: "",
      metadata: {},
      time: { start: t0 + 1, end: t0 + 2 },
    },
  })

  const u2 = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: info.id,
    agent: "build",
    model: ref,
    time: { created: t0 + 3 },
  })
  // Synthetic tool_result part: alignToNonToolResultUser keys on
  // parts.every(p => p.type === "tool_result"); cast through `as never`
  // because OpenCode's MessageV2.Part discriminator does not include
  // tool_result. The Part data is round-tripped as JSON unchanged.
  // Padded body so the natural tail at startIdx=2 exceeds TAIL_MAX_TOKENS
  // and computeBoundary doesn't walk back further than idx=2.
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: u2.id,
    sessionID: info.id,
    type: "tool_result",
    body: PAD,
  } as never)

  const a2 = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: info.id,
    agent: "build",
    parentID: u2.id,
    providerID: ref.providerID,
    modelID: ref.modelID,
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: t0 + 4 },
    finish: "stop",
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: a2.id,
    sessionID: info.id,
    type: "text",
    text: PAD,
  })

  return { info, u1, a1, u2, a2 }
})

describe("checkpoint writer forkContext shape per mode", () => {
  it.live(
    "T6: fork:true preserves prefix-cache parent-fork shape (parent agent + slice up to watermark)",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()

          const svc = yield* SessionCheckpoint.Service
          const { info, u2 } = yield* seedFourMessages()

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as never,
          })
          expect(outcome).toBe("started")

          // Capture invoked exactly once — for the parent's watermark slice.
          expect(captureLog.calls.length).toBe(1)
          const call = captureLog.calls[0]
          // T6: agentName must be the parent's (from watermark message), NOT "checkpoint-writer".
          expect(call.agentName).toBe("build")
          // msgs slice is [u1, a1, u2] — the watermark u2 is at idx 2, so slice
          // length = watermarkIdx + 1 = 3.
          expect(call.msgsLen).toBe(3)
          // First message is u1 (the start of full history up to watermark).
          // u2 is the watermark; the slice is msgs[0..watermarkIdx+1].
          // Sanity: firstMsgRole should be user.
          expect(call.firstMsgRole).toBe("user")

          // Fork context flows through to actor.spawn with the canned values.
          const fc = spawnLog.lastInput?.forkContext as
            | { system: string[]; watermarkMsgID: string }
            | undefined
          expect(fc).toBeDefined()
          expect(fc?.system).toEqual(["sys-canned"])
          expect(fc?.watermarkMsgID).toBe(u2.id)
        }),
      { config: { checkpoint: { fork: true } } },
    ),
  )

  it.live(
    "T4: fork:false with mid-pair lastCheckpointMessageID — alignment walks past tool_result-only u2 to u1",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()

          const svc = yield* SessionCheckpoint.Service
          const { info, u1, a1, u2 } = yield* seedFourMessages()

          // Set parent's last_checkpoint_message_id to a1.id BEFORE invoking writer
          // → rawDeltaStart = msgs.findIndex(a1.id) + 1 = 1 + 1 = 2 (u2).
          // u2 has parts=[{type: "tool_result"}], so align must walk back to u1 (idx 0).
          // delta = msgs.slice(0, watermarkIdx + 1) = msgs.slice(0, 3) = [u1, a1, u2].
          yield* Effect.sync(() =>
            Database.use((d) =>
              d.update(SessionTable)
                .set({ last_checkpoint_message_id: a1.id })
                .where(eq(SessionTable.id, info.id))
                .run(),
            ),
          )

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as never,
          })
          expect(outcome).toBe("started")

          expect(captureLog.calls.length).toBe(1)
          const call = captureLog.calls[0]
          // T4: agentName must be "checkpoint-writer" (no-fork path uses writer's own agent).
          expect(call.agentName).toBe("checkpoint-writer")
          // alignment: rawDeltaStart=2 walks back past tool_result-only u2 to u1 (idx 0).
          // delta length = watermarkIdx + 1 - 0 = 3.
          expect(call.msgsLen).toBe(3)
          // firstMsgID confirms alignment landed on u1 (NOT u2).
          expect(call.firstMsgID).toBe(u1.id)

          const fc = spawnLog.lastInput?.forkContext as { watermarkMsgID: string } | undefined
          expect(fc).toBeDefined()
          expect(fc?.watermarkMsgID).toBe(u2.id)
        }),
      { config: { checkpoint: { fork: false } } },
    ),
  )

  it.live(
    "T4b: fork:false succeeds even when watermark message has no agent field",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()

          const svc = yield* SessionCheckpoint.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const t0 = Date.now()

          // u1 keeps `agent: "build"` so seed is realistic; u2 (the watermark)
          // omits the agent field. Cast through `as never` to bypass the static
          // T extends MessageV2.Info check — Session.updateMessage itself does
          // no schema validation (it emits Event.Updated and returns the msg
          // verbatim), so the resulting info.agent === undefined at the
          // watermark. Pre-fix this downgraded fork:false to no forkContext;
          // post-fix the writer should still get a real forkCtx.
          const u1 = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: t0 },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: u1.id,
            sessionID: info.id,
            type: "text",
            text: "u1 prompt",
          })

          const a1 = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            agent: "build",
            parentID: u1.id,
            providerID: ref.providerID,
            modelID: ref.modelID,
            mode: "build",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: t0 + 1 },
            finish: "tool-calls",
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a1.id,
            sessionID: info.id,
            type: "tool",
            tool: "read",
            callID: `call-${a1.id}`,
            state: {
              status: "completed",
              input: {},
              output: "ok",
              title: "",
              metadata: {},
              time: { start: t0 + 1, end: t0 + 2 },
            },
          })

          // u2 — the watermark — intentionally has `agent` set to undefined
          // so info.agent === undefined at runtime. The schema requires
          // agent: string, but Session.updateMessage does no validation —
          // it emits Event.Updated and returns the msg verbatim. Cast just
          // the field (not the whole object) so TypeScript still infers
          // the return type properly downstream.
          const u2 = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: undefined as unknown as string,
            model: ref,
            time: { created: t0 + 3 },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: u2.id,
            sessionID: info.id,
            type: "text",
            text: PAD,
          })

          const a2 = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            agent: "build",
            parentID: u2.id,
            providerID: ref.providerID,
            modelID: ref.modelID,
            mode: "build",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: t0 + 4 },
            finish: "stop",
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a2.id,
            sessionID: info.id,
            type: "text",
            text: PAD,
          })

          // Sanity: verify the watermark really has no agent (schema-bypass worked).
          // Use messages() and find u2 — this is the only public lookup API on
          // the Session.Service interface.
          const all = yield* ssn.messages({ sessionID: info.id })
          const wm = all.find((m) => m.info.id === u2.id)
          expect((wm?.info as { agent?: string } | undefined)?.agent).toBeUndefined()

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as never,
          })
          expect(outcome).toBe("started")

          // Pre-fix expectation: captureLog.calls.length === 0 (forkCtx undefined).
          // Post-fix expectation: capture invoked once with writer's own agent.
          expect(captureLog.calls.length).toBe(1)
          expect(captureLog.calls[0].agentName).toBe("checkpoint-writer")

          const fc = spawnLog.lastInput?.forkContext as { watermarkMsgID: string } | undefined
          expect(fc).toBeDefined()
          expect(fc?.watermarkMsgID).toBe(u2.id)
        }),
      { config: { checkpoint: { fork: false } } },
    ),
  )

  it.live(
    "T5: fork:false with null last_checkpoint_message_id — delta covers full history up to watermark",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()

          const svc = yield* SessionCheckpoint.Service
          const { info, u1, u2 } = yield* seedFourMessages()

          // Parent's last_checkpoint_message_id is null by default after session.create({}).
          // No setup needed; verify it's null first.
          const before = yield* Effect.sync(() =>
            Database.use((d) =>
              d.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get(),
            ),
          )
          expect(before?.last_checkpoint_message_id ?? null).toBeNull()

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as never,
          })
          expect(outcome).toBe("started")

          expect(captureLog.calls.length).toBe(1)
          const call = captureLog.calls[0]
          // T5: agentName must be "checkpoint-writer" (no-fork path).
          expect(call.agentName).toBe("checkpoint-writer")
          // No prior checkpoint → rawDeltaStart=0 → align stays at 0 → delta = msgs.slice(0, watermarkIdx+1).
          // watermarkIdx = 2 (u2), so delta length = 3.
          expect(call.msgsLen).toBe(3)
          // First message is u1.
          expect(call.firstMsgID).toBe(u1.id)

          const fc = spawnLog.lastInput?.forkContext as { watermarkMsgID: string } | undefined
          expect(fc).toBeDefined()
          expect(fc?.watermarkMsgID).toBe(u2.id)
        }),
      // Default config (fork unset) → fork: false. Explicitly setting for clarity.
      { config: { checkpoint: { fork: false } } },
    ),
  )

  it.live(
    "T5b: fork:false with last_checkpoint_message_id PAST the watermark returns 'skipped' (no spawn, no child session)",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()

          const svc = yield* SessionCheckpoint.Service
          const { info, a2 } = yield* seedFourMessages()

          // Set parent's last_checkpoint_message_id to a2 (PAST the boundary the
          // writer computes — boundary lands at u2 because computeBoundary picks
          // startIdx = lastAsstIdx-1 = 2 and the natural tail exceeds
          // TAIL_MAX_TOKENS, so endMessageID = u2.id). Result:
          //   - watermarkIdx = 2 (u2)
          //   - lastIdx = 3 (a2)
          //   - rawDeltaStart = 4, alignedStart = 4 (past msgs.length)
          //   - delta = msgs.slice(4, 3) = []
          // Pre-fix the writer fell through to spawn → runLoop's
          // `isForkAgent && !forkCtx → break` → silent watermark re-advance.
          // Post-fix the writer must short-circuit to "skipped" BEFORE creating
          // a child session and BEFORE invoking actor.spawn.
          //
          // Setting last to == endMessageID (u2.id) wouldn't trigger this path
          // because alignToNonToolResultUser walks back past u2 (which has only
          // tool_result parts) to u1, producing a non-empty delta=[u1,a1,u2].
          yield* Effect.sync(() =>
            Database.use((d) =>
              d.update(SessionTable)
                .set({ last_checkpoint_message_id: a2.id })
                .where(eq(SessionTable.id, info.id))
                .run(),
            ),
          )

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as never,
          })

          // M1 fix: empty delta under fork:false → "skipped" (NOT "started").
          expect(outcome).toBe("skipped")
          // Capture must not have been invoked (the empty-delta short-circuit
          // is BEFORE the prefix-build call).
          expect(captureLog.calls.length).toBe(0)
          // actor.spawn must not have been invoked either (the empty-delta
          // short-circuit is BEFORE session.create / actor.spawn).
          expect(spawnLog.count).toBe(0)
        }),
      { config: { checkpoint: { fork: false } } },
    ),
  )
})
