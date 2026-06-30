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

        // Turn 1 ends without a re-arm. Sweep increments strikes to 1 and
        // schedules a keepalive arm that supersedes the prior loop task.
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

        // Pre-populate strikes to the budget (1). The very next sweep with no
        // re-arm should hit the budget-exhausted branch.
        setLoopState({
          prompt: "exhaust",
          startedAt: Date.now(),
          lastScheduledFor: Date.now() + 60_000,
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
          // Second sweep with no re-arm in between: strikes=0 >= budget=0,
          // immediate model_stopped.
          yield* bridge.runKeepaliveSweep()
          expect(getLoopState("zero")).toBe(null)
          expect(loopTasksFor("zero").length).toBe(0)
        }),
      )
    }),
  )
})
