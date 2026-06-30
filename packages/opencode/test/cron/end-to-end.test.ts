import { describe, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"

import { Bus } from "@/bus"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { SessionStatus } from "@/session/status"
import { SessionPrompt, type PromptInput, injectScheduledPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import {
  Scheduler,
  defaultLayer as SchedulerDefaultLayer,
} from "@/cron/scheduler"
import { clearAllLoopStates } from "@/cron/loop-state"
import { getSessionCronTasks, removeSessionCronTasks, type CronTask } from "@/cron/cron-task"
import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// End-to-end smoke test for the cron + loop system (T22, spec [S11]).
//
// Verifies the entire chain composes:
//   Scheduler.add → tick → onFire(task) → injectScheduledPrompt
//     → SessionPrompt.Service.prompt (stubbed to capture) → cron origin survives.
//
// The bridge's own onFire callback uses production AppRuntime via dynamic
// import (cron-bridge.ts:168), which cannot route into the test's stubbed
// Service. So this test mounts Scheduler directly with a captured onFire
// callback that invokes the same injectScheduledPrompt seam the bridge uses
// — verifying the composed pipeline without fighting the AppRuntime detour.
// The bridge's own wiring to Scheduler.start (isKilled / onFire / onArmLoop)
// is covered by cron-bridge.integration.test.ts and keepalive.integration.test.ts.

const originalCronFlag = Flag.MIMOCODE_EXPERIMENTAL_CRON
afterEach(async () => {
  ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = originalCronFlag
  await Instance.disposeAll()
})

// Captured prompts land here. Defined as a stable container so the layer
// constructed once below sees the same array across all tests.
const captured: { value: PromptInput[] } = { value: [] }

const stubPrompt = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    cancel: () => Effect.void,
    prompt: (input: PromptInput) =>
      Effect.sync(() => {
        captured.value.push(input)
        const sessionID = input.sessionID
        const id = MessageID.ascending()
        const text: MessageV2.TextPart = {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "text",
          text: "",
          synthetic: true,
        }
        const info: MessageV2.User = {
          id,
          role: "user",
          sessionID,
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
    loop: () => Effect.die("loop not expected in end-to-end test"),
    shell: () => Effect.die("shell not expected in end-to-end test"),
    command: () => Effect.die("command not expected in end-to-end test"),
    resolvePromptParts: () => Effect.succeed([]),
    sweepOrphanAssistants: () => Effect.void,
    predict: () => Effect.succeed(""),
  }),
)

const env = Layer.mergeAll(SchedulerDefaultLayer, SessionStatus.defaultLayer, Bus.layer, CrossSpawnSpawner.defaultLayer, stubPrompt)

const it = testEffect(env)

beforeEach(() => {
  captured.value = []
  clearAllLoopStates()
  removeSessionCronTasks(getSessionCronTasks().map((t) => t.id))
  delete process.env.MIMOCODE_DISABLE_CRON
  ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = true
})

const sid = SessionID.make("ses_e2e_test")

// Same shape as cron-bridge's onFire callback (cron-bridge.ts:159-200): on
// fire, prepend an ISO fire timestamp to the resolved prompt and call
// injectScheduledPrompt with the task's origin marker plus the firedAt field.
// Captured inside an Effect so it runs against the SAME test Service stub,
// instead of the production AppRuntime the live bridge dynamically imports.
const fireToInject = (task: CronTask) => {
  const firedAtISO = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  return injectScheduledPrompt({
    sessionID: sid,
    value: `[cron fire @ ${firedAtISO}] ${task.prompt}`,
    origin: {
      kind: "cron",
      taskId: task.id,
      kindOfTask: task.kind ?? "cron",
      firedAt: firedAtISO,
    },
    priority: "later",
    isMeta: true,
  })
}

describe("cron + loop end-to-end smoke", () => {
  it.live("schedule → tick → fire → cron origin lands → delete → no more fires", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const scheduler = yield* Scheduler

        // Mount the scheduler with an onFire callback that runs the same
        // injection seam the production bridge calls. We collect fires
        // synchronously into a queue so onFire stays Effect-free (matches
        // StartOpts contract), then drain them through Effect after each
        // tickOnce so the stubbed SessionPrompt.Service sees them.
        const fired: CronTask[] = []
        yield* scheduler.start({
          workspaceRoot: dir,
          sessionID: sid,
          isLoading: () => false,
          isKilled: () => false,
          onFire: (task) => {
            fired.push(task)
          },
          onLoopEnded: () => undefined,
          dir,
        })

        // Step 1: register a recurring cron task via Scheduler.add — this is
        // the same code path the `cron schedule` tool verb funnels through
        // (cron.ts → Scheduler.add).
        const created = yield* scheduler.add({
          session_id: sid,
          cron: "* * * * *",
          prompt: "check the deploy",
          recurring: true,
          durable: false,
        })
        expect(created.prompt).toBe("check the deploy")
        expect(created.createdBySessionId).toBe(sid)

        // Step 2: backdate createdAt so the task's next computed fire is in
        // the past. Without this, `* * * * *` schedules for the next minute
        // boundary plus jitter — far longer than a test should wait.
        const all = getSessionCronTasks()
        const target = all.find((t) => t.id === created.id)
        expect(target).toBeDefined()
        ;(target as { createdAt: number }).createdAt = Date.now() - 5 * 60_000

        // Step 3: drive ONE tick. Verifies the scheduler's tick body actually
        // resolves due tasks and invokes onFire with the right task.
        yield* scheduler.tickOnce()
        expect(fired.length).toBe(1)
        expect(fired[0]!.id).toBe(created.id)
        expect(fired[0]!.prompt).toBe("check the deploy")

        // Step 4: drain the fire through injectScheduledPrompt → stubbed
        // SessionPrompt.Service.prompt, asserting the cron origin survives
        // the full pipeline end-to-end.
        for (const task of fired) yield* fireToInject(task)
        fired.length = 0

        expect(captured.value.length).toBe(1)
        const input = captured.value[0]!
        expect(input.sessionID).toBe(sid)
        expect(input.source).toBe("hook")
        expect(input.parts.length).toBe(1)
        const part = input.parts[0]!
        expect(part.type).toBe("text")
        if (part.type !== "text") throw new Error("expected text part")
        // Fire-time prefix + original prompt, e.g. "[cron fire @ 2026-06-30T15:42:00Z] check the deploy"
        expect(part.text).toMatch(/^\[cron fire @ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] check the deploy$/)
        expect(part.synthetic).toBe(true)
        const meta = part.metadata as { origin?: { firedAt?: string; kind?: string; taskId?: string; kindOfTask?: string } }
        expect(meta.origin?.kind).toBe("cron")
        expect(meta.origin?.taskId).toBe(created.id)
        expect(meta.origin?.kindOfTask).toBe("cron")
        // firedAt: ISO-8601 second-precision UTC stamp ending in Z (no millis).
        expect(meta.origin?.firedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
        // Same stamp appears in both the visible prefix and the metadata.
        expect(part.text.includes(meta.origin!.firedAt!)).toBe(true)
        expect((part.metadata as { priority?: string }).priority).toBe("later")

        // Step 5: delete via Scheduler.remove — same path the `cron delete`
        // tool verb uses (cron.ts → Scheduler.remove).
        const removed = yield* scheduler.remove(created.id)
        expect(removed).toBe(true)
        const after = yield* scheduler.list({ session_id: sid })
        expect(after.length).toBe(0)

        // Step 6: drive another tick and verify NO further fires occur. This
        // proves remove actually evicts the task from scheduler state, not
        // just from the session-task store (which would leave a stale fire
        // pending if the scheduler kept an internal nextFireAt entry).
        captured.value = []
        yield* scheduler.tickOnce()
        expect(fired.length).toBe(0)
        for (const task of fired) yield* fireToInject(task)
        expect(captured.value.length).toBe(0)

        yield* scheduler.stop()
      }),
    ),
  )
})
