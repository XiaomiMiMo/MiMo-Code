import { describe, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"

import { Bus } from "@/bus"
import { SessionStatus } from "@/session/status"
import { SessionPrompt, type PromptInput } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import {
  Scheduler,
  defaultLayer as SchedulerDefaultLayer,
  type Interface as SchedulerInterface,
} from "@/cron/scheduler"
import { clearAllLoopStates, getLoopState, getStrikes, setLoopState } from "@/cron/loop-state"
import { getSessionCronTasks, removeSessionCronTasks } from "@/cron/cron-task"
import {
  CronBridge,
  layer as cronBridgeLayer,
  type Interface as CronBridgeInterface,
} from "@/session/cron-bridge"
import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The flag is captured at module-load time. Tests force it ON so the bridge
// actually wires the scheduler. We save the original value once and restore
// after the file finishes (each `beforeEach` re-forces ON so per-test env
// fiddling doesn't leak).
const originalCronFlag = Flag.MIMOCODE_EXPERIMENTAL_CRON
afterEach(async () => {
  ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = originalCronFlag
  await Instance.disposeAll()
})

// Stub SessionPrompt — none of the keepalive code paths invoke it, but the
// CronBridge layer requires it transitively.
const stubPrompt = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    cancel: () => Effect.void,
    prompt: (input: PromptInput) =>
      Effect.sync(() => {
        const id = MessageID.ascending()
        const text: MessageV2.TextPart = {
          id: PartID.ascending(),
          messageID: id,
          sessionID: input.sessionID,
          type: "text",
          text: "",
          synthetic: true,
        }
        const info: MessageV2.User = {
          id,
          role: "user",
          sessionID: input.sessionID,
          agentID: undefined,
          time: { created: Date.now() },
          agent: input.agent ?? "main",
          model: {
            providerID: ProviderID.make("test"),
            modelID: ModelID.make("test-model"),
            variant: undefined,
          },
        }
        const out: MessageV2.WithParts = { info, parts: [text] }
        return out
      }),
    loop: () => Effect.die("loop not expected in keepalive test"),
    shell: () => Effect.die("shell not expected in keepalive test"),
    command: () => Effect.die("command not expected in keepalive test"),
    resolvePromptParts: () => Effect.succeed([]),
    sweepOrphanAssistants: () => Effect.void,
    predict: () => Effect.succeed(""),
  }),
)

const env = Layer.mergeAll(
  SchedulerDefaultLayer,
  SessionStatus.defaultLayer,
  Bus.layer,
  CrossSpawnSpawner.defaultLayer,
  stubPrompt,
  cronBridgeLayer.pipe(
    Layer.provide(SchedulerDefaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(stubPrompt),
  ),
)

const it = testEffect(env)

beforeEach(() => {
  clearAllLoopStates()
  removeSessionCronTasks(getSessionCronTasks().map((t) => t.id))
  delete process.env.MIMOCODE_DISABLE_CRON
  delete process.env.MIMOCODE_LOOP_KEEPALIVE_BUDGET
  delete process.env.MIMOCODE_LOOP_KEEPALIVE_DELAY_S
  ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = true
})

const sid = SessionID.make("ses_keepalive_test")

const withMountedBridge = <A>(
  run: (ctx: { bridge: CronBridgeInterface; scheduler: SchedulerInterface; dir: string }) => Effect.Effect<A>,
) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const bridge = yield* CronBridge
      const scheduler = yield* Scheduler
      yield* bridge.start(sid, dir)
      const result = yield* run({ bridge, scheduler, dir })
      yield* bridge.stop()
      return result
    }),
  )

const loopTasksFor = (prompt: string) =>
  getSessionCronTasks().filter((t) => t.kind === "loop" && t.prompt === prompt)

describe("cron-bridge keepalive sweep", () => {
  it.live("turn 1 with no re-arm increments strikes to 1 and auto-fires keepalive", () =>
    withMountedBridge(({ bridge, scheduler }) =>
      Effect.gen(function* () {
        const arm = yield* scheduler.armLoop({ prompt: "plain", delay_seconds: 600, reason_length: 0 })
        expect(arm).not.toBeNull()
        expect(getStrikes("plain")).toBe(0)
        expect(loopTasksFor("plain").length).toBe(1)

        // First sweep represents the turn that *originally created* the loop —
        // armedThisTurn contains "plain" so strikes reset (0 → 0).
        yield* bridge.runKeepaliveSweep()
        expect(getStrikes("plain")).toBe(0)
        const idAfterFirstSweep = loopTasksFor("plain")[0]!.id

        // Simulate the loop becoming overdue (its scheduled fire time has
        // passed but the model didn't re-arm). The fix for finding #2 only
        // strikes loops whose lastScheduledFor < now; tests must reproduce
        // that condition explicitly rather than relying on every sweep
        // striking every loop indiscriminately.
        const stateBefore = getLoopState("plain")!
        setLoopState({ ...stateBefore, lastScheduledFor: Date.now() - 1000 })

        // Turn 1 ends without a re-arm and the fire is overdue. Sweep
        // increments strikes to 1 and schedules a keepalive arm that
        // supersedes the prior loop task.
        yield* bridge.runKeepaliveSweep()
        expect(getStrikes("plain")).toBe(1)
        const after = loopTasksFor("plain")
        expect(after.length).toBe(1)
        expect(after[0]!.id).not.toBe(idAfterFirstSweep)
      }),
    ),
  )

  it.live("turn 2 at budget with no re-arm ends loop as model_stopped (via_keepalive)", () =>
    withMountedBridge(({ bridge, scheduler }) =>
      Effect.gen(function* () {
        // Arm + first sweep so strikes start at 0 with armedThisTurn drained.
        yield* scheduler.armLoop({ prompt: "exhaust", delay_seconds: 600, reason_length: 0 })
        yield* bridge.runKeepaliveSweep()
        expect(getStrikes("exhaust")).toBe(0)

        // Pre-populate strikes to the budget (1) AND mark the loop overdue
        // — only overdue loops are eligible for striking under the #2 fix.
        setLoopState({
          prompt: "exhaust",
          startedAt: Date.now(),
          lastScheduledFor: Date.now() - 1000,
          keepaliveStrikes: 1,
        })
        expect(getStrikes("exhaust")).toBe(1)
        expect(loopTasksFor("exhaust").length).toBe(1)

        yield* bridge.runKeepaliveSweep()
        // Loop is gone and the session task was cleared by endLoop.
        expect(getLoopState("exhaust")).toBe(null)
        expect(loopTasksFor("exhaust").length).toBe(0)
      }),
    ),
  )

  // New regression for PR #1479 finding #2: a quiescent loop (whose fire
  // hasn't come due yet) must not accrue strikes on unrelated user turns.
  it.live("quiescent loop with future fire time is not struck on sweep", () =>
    withMountedBridge(({ bridge, scheduler }) =>
      Effect.gen(function* () {
        yield* scheduler.armLoop({ prompt: "quiet", delay_seconds: 3000, reason_length: 0 })
        yield* bridge.runKeepaliveSweep()           // first sweep: armed-this-turn reset
        expect(getStrikes("quiet")).toBe(0)

        // Three unrelated user turns happen, none re-arm the loop. Its fire is
        // still 50min in the future. Under the old behavior strikes would tick
        // up to budget and kill the loop. Under #2 fix, strikes stay 0.
        yield* bridge.runKeepaliveSweep()
        yield* bridge.runKeepaliveSweep()
        yield* bridge.runKeepaliveSweep()
        expect(getStrikes("quiet")).toBe(0)
        expect(getLoopState("quiet")).not.toBeNull()
        expect(loopTasksFor("quiet").length).toBe(1)
      }),
    ),
  )

  it.live("model re-arms during the turn → strikes stay 0 and no keepalive auto-fire", () =>
    withMountedBridge(({ bridge, scheduler }) =>
      Effect.gen(function* () {
        // Arm + drain.
        yield* scheduler.armLoop({ prompt: "rearmed", delay_seconds: 600, reason_length: 0 })
        yield* bridge.runKeepaliveSweep()
        expect(getStrikes("rearmed")).toBe(0)

        // Model re-arms during this turn — armLoop populates armedThisTurn.
        yield* scheduler.armLoop({ prompt: "rearmed", delay_seconds: 900, reason_length: 0 })
        const idsBefore = new Set(loopTasksFor("rearmed").map((t) => t.id))
        expect(idsBefore.size).toBe(1)

        yield* bridge.runKeepaliveSweep()
        expect(getStrikes("rearmed")).toBe(0)
        const idsAfter = new Set(loopTasksFor("rearmed").map((t) => t.id))
        // No extra arm — the same id from the model re-arm is still the only one.
        expect(idsAfter).toEqual(idsBefore)
      }),
    ),
  )

  it.live("budget=0 ends loop immediately on first turn without a re-arm", () =>
    Effect.gen(function* () {
      process.env.MIMOCODE_LOOP_KEEPALIVE_BUDGET = "0"
      yield* withMountedBridge(({ bridge, scheduler }) =>
        Effect.gen(function* () {
          yield* scheduler.armLoop({ prompt: "zero", delay_seconds: 600, reason_length: 0 })
          // First sweep: armedThisTurn carries "zero" so strikes reset.
          yield* bridge.runKeepaliveSweep()
          expect(getLoopState("zero")).not.toBeNull()
          // Mark the loop overdue so the budget-exhausted branch can fire.
          const s = getLoopState("zero")!
          setLoopState({ ...s, lastScheduledFor: Date.now() - 1000 })
          // Second sweep with no re-arm and overdue fire: strikes=0 >= budget=0,
          // immediate model_stopped.
          yield* bridge.runKeepaliveSweep()
          expect(getLoopState("zero")).toBe(null)
          expect(loopTasksFor("zero").length).toBe(0)
        }),
      )
    }),
  )
})
