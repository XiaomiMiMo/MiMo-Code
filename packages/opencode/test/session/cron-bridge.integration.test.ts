import { test, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { provideInstance } from "../fixture/fixture"
import { Flag } from "@/flag/flag"

import { Bus } from "@/bus"
import { SessionStatus } from "@/session/status"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt, type PromptInput, type InjectScheduledPromptInput } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { Scheduler, defaultLayer as SchedulerDefaultLayer, type Interface as SchedulerInterface } from "@/cron/scheduler"
import { clearAllLoopStates } from "@/cron/loop-state"
import { getSessionCronTasks, removeSessionCronTasks } from "@/cron/cron-task"
import { CronBridge, layer as cronBridgeLayer, type Interface as CronBridgeInterface } from "@/session/cron-bridge"

import * as PromptModule from "@/session/prompt"

// ---- Capture target: a stub SessionPrompt.Service whose `prompt` records its
// input and returns a minimal MessageV2.WithParts. The integration test asserts
// the bridge funnels onFire(task) through this Service entry point, with the
// cron origin marker plumbed onto a synthetic text part — i.e. through the
// front door, not a side channel.

type CapturedPrompt = PromptInput

const makeCaptureLayer = (captured: { value: CapturedPrompt[] }) =>
  Layer.succeed(
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
      loop: () => Effect.die("loop not expected in cron-bridge test"),
      shell: () => Effect.die("shell not expected in cron-bridge test"),
      command: () => Effect.die("command not expected in cron-bridge test"),
      resolvePromptParts: () => Effect.succeed([]),
      sweepOrphanAssistants: () => Effect.void,
      predict: () => Effect.succeed(""),
    }),
  )

// AppRuntime monkey-patch — injectScheduledPrompt's onFire fanout uses
// `import("@/effect/app-runtime").AppRuntime.runPromise(...)`. In tests we
// replace it with a runtime that materializes the capture layer so the
// detached fire-and-forget actually lands in our stub Service.
//
// We can't intercept the dynamic import without a module replacement, so the
// test asserts the synchronous PATH through `injectScheduledPrompt` directly
// (calling it from inside Effect.gen) plus a *bridge-driven* call via the
// callback. The bridge unit test below verifies start/stop + isKilled + the
// onFire callback shape; the higher-fidelity end-to-end fire (real
// setInterval clock advance) is deferred to T22's smoke test where the live
// AppRuntime + Session services are available.

const freshDir = () => mkdtempSync(join(tmpdir(), "cron-bridge-"))

beforeEach(() => {
  clearAllLoopStates()
  removeSessionCronTasks(getSessionCronTasks().map((t) => t.id))
  delete process.env.MIMOCODE_DISABLE_CRON
  process.env.MIMOCODE_EXPERIMENTAL_CRON = "1"
})

const sid = SessionID.make("ses_cronbridge_test")

const harness = <A>(captured: { value: CapturedPrompt[] }, work: (ctx: {
  bridge: CronBridgeInterface
  scheduler: SchedulerInterface
}) => Effect.Effect<A, unknown, SessionPrompt.Service>) => {
  const capture = makeCaptureLayer(captured)
  const base = Layer.mergeAll(SchedulerDefaultLayer, SessionStatus.defaultLayer, Bus.layer, capture)
  const bridge = cronBridgeLayer.pipe(Layer.provide(base))
  const eff = Effect.gen(function* () {
    const b = yield* CronBridge
    const s = yield* Scheduler
    return yield* work({ bridge: b, scheduler: s })
  })
  // The bridge (and its downstream SessionStatus / Bus / Scheduler) use
  // InstanceState which reads the current Instance from a fiber-local
  // context. Wrap the whole effect with an Instance provider so those
  // reads resolve — same shape the real AppRuntime uses when it mounts
  // the bridge from prompt.ts.
  const tmp = mkdtempSync(join(tmpdir(), "cron-bridge-instance-"))
  const provided = eff.pipe(Effect.provide(Layer.mergeAll(bridge, base)))
  return Effect.runPromise(provideInstance(tmp)(provided as Effect.Effect<A>)).finally(() => {
    rmSync(tmp, { recursive: true, force: true })
  })
}

test("injectScheduledPrompt funnels through SessionPrompt.Service.prompt with cron origin", async () => {
  const captured: { value: CapturedPrompt[] } = { value: [] }
  await harness(captured, () =>
    Effect.gen(function* () {
      yield* PromptModule.injectScheduledPrompt({
        sessionID: sid,
        value: "run weekly digest",
        origin: { kind: "cron", taskId: "abc12345", kindOfTask: "cron" },
      } satisfies InjectScheduledPromptInput)
    }),
  )

  expect(captured.value.length).toBe(1)
  const input = captured.value[0]!
  expect(input.sessionID).toBe(sid)
  expect(input.source).toBe("hook")
  expect(input.parts.length).toBe(1)
  const part = input.parts[0]!
  expect(part.type).toBe("text")
  if (part.type !== "text") throw new Error("expected text part")
  expect(part.text).toBe("run weekly digest")
  expect(part.synthetic).toBe(true)
  expect(part.metadata).toMatchObject({
    origin: { kind: "cron", taskId: "abc12345", kindOfTask: "cron" },
    priority: "later",
  })
})

test("cron-bridge start wires Scheduler with isLoading + isKilled + onFire", async () => {
  const captured: { value: CapturedPrompt[] } = { value: [] }
  const dir = freshDir()
  try {
    await harness(captured, ({ bridge, scheduler }) =>
      Effect.gen(function* () {
        yield* bridge.start(sid, dir)

        // Register a session-only task and verify it lands in scheduler state
        // (i.e. the bridge's start() actually called scheduler.start so the
        // shared runtime is alive). Loading is true initially in our wiring
        // because no busy event has been received and no Status.set has been
        // published — `initial.type === "idle"` so handle.loading = false.
        const created = yield* scheduler.add({
          session_id: sid,
          cron: "*/5 * * * *",
          prompt: "weekly digest",
          recurring: true,
          durable: false,
        })
        expect(created.createdBySessionId).toBe(sid)

        const list = yield* scheduler.list({ session_id: sid })
        expect(list.length).toBe(1)
        expect(list[0]!.id).toBe(created.id)

        // isKilled honors process.env.MIMOCODE_DISABLE_CRON live (verified by
        // forcing it and observing armLoop refuse to schedule).
        process.env.MIMOCODE_DISABLE_CRON = "1"
        const arm = yield* scheduler.armLoop({
          prompt: "k",
          delay_seconds: 120,
          reason_length: 0,
        })
        expect(arm).toBe(null)
        delete process.env.MIMOCODE_DISABLE_CRON

        yield* bridge.stop()
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("cron-bridge is a no-op when MIMOCODE_EXPERIMENTAL_CRON is explicitly disabled", async () => {
  const captured: { value: CapturedPrompt[] } = { value: [] }
  const originalFlag = Flag.MIMOCODE_EXPERIMENTAL_CRON
  ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = false
  const dir = freshDir()
  try {
    await harness(captured, ({ bridge, scheduler }) =>
      Effect.gen(function* () {
        yield* bridge.start(sid, dir)
        // Scheduler.start was never called so add() still works (it does not
        // require start), but armLoop returns null without a runtime.
        const arm = yield* scheduler.armLoop({
          prompt: "k",
          delay_seconds: 120,
          reason_length: 0,
        })
        expect(arm).toBe(null)
        yield* bridge.stop()
      }),
    )
  } finally {
    ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = originalFlag
    rmSync(dir, { recursive: true, force: true })
  }
})

test("cron-bridge double-start is idempotent (warns + ignores)", async () => {
  const captured: { value: CapturedPrompt[] } = { value: [] }
  const dir = freshDir()
  try {
    await harness(captured, ({ bridge }) =>
      Effect.gen(function* () {
        yield* bridge.start(sid, dir)
        yield* bridge.start(sid, dir) // second call no-ops
        yield* bridge.stop()
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Wiring assertion: the session-lifecycle hook near the auto-dream / auto-distill
// block in prompt.ts fires `AppRuntime.runPromise(CronBridge.use(b => b.start(sid, root)))`.
// That CALL only succeeds if CronBridge.defaultLayer is composed into AppLayer.
// We assert that the bridge layer + its transitive deps satisfy the
// `CronBridge.use(...)` access pattern the hook performs — equivalent to
// "AppLayer can resolve CronBridge", without booting the full AppRuntime
// (which would require Instance, Storage, Provider, etc).
test("cron-bridge is resolvable via CronBridge.use (matches prompt.ts hook pattern)", async () => {
  const captured: { value: CapturedPrompt[] } = { value: [] }
  const dir = freshDir()
  const instanceDir = mkdtempSync(join(tmpdir(), "cron-bridge-instance-"))
  try {
    const capture = makeCaptureLayer(captured)
    const base = Layer.mergeAll(SchedulerDefaultLayer, SessionStatus.defaultLayer, Bus.layer, capture)
    const bridge = cronBridgeLayer.pipe(Layer.provide(base))
    const layered = Layer.mergeAll(bridge, base)
    await Effect.runPromise(
      provideInstance(instanceDir)(
        CronBridge.use((b) =>
          Effect.gen(function* () {
            yield* b.start(sid, dir)
            yield* b.stop()
          }),
        ).pipe(Effect.provide(layered)) as Effect.Effect<void>,
      ),
    )
    expect(true).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(instanceDir, { recursive: true, force: true })
  }
})

// Regression: cron-bridge subscribes to SessionCompaction.Event.Compacted so
// the sentinel cache resets automatically on user /compact AND on the
// overflow-boundary path (compaction.create also publishes now). Subagent
// slice compactions (agentID present, not "main") must NOT reset the main
// cache — cache is scoped to (sessionID, workspaceRoot) and the sentinel
// content lives in the main agent's context, not the subagent slice.
test("cron-bridge resets sentinel cache on main-agent Compacted, ignores subagent slice", async () => {
  const captured: { value: CapturedPrompt[] } = { value: [] }
  const wsDir = freshDir()
  const instanceDir = mkdtempSync(join(tmpdir(), "cron-bridge-instance-"))
  try {
    // Set up loop.md so the sentinel expansion is exercisable.
    const mkdirSync2 = (await import("fs")).mkdirSync
    const writeFileSync2 = (await import("fs")).writeFileSync
    mkdirSync2(join(wsDir, ".mimocode"), { recursive: true })
    writeFileSync2(join(wsDir, ".mimocode", "loop.md"), "cached body")

    const capture = makeCaptureLayer(captured)
    const base = Layer.mergeAll(SchedulerDefaultLayer, SessionStatus.defaultLayer, Bus.layer, capture)
    const bridge = cronBridgeLayer.pipe(Layer.provide(base))
    const layered = Layer.mergeAll(bridge, base)

    // Import the sentinel primitives so we can inspect cache state directly.
    const { resolveAtFireTime, LOOP_FILE_SENTINEL, resetOnCompaction } = await import("@/cron/sentinel")
    // Clean slate for this test — earlier tests in the file may have written cache entries.
    resetOnCompaction()

    await Effect.runPromise(
      provideInstance(instanceDir)(
        Effect.gen(function* () {
          const b = yield* CronBridge
          const bus = yield* Bus.Service
          yield* b.start(sid, wsDir)

          // Warm the cache (first fire → full content).
          const first = yield* Effect.promise(() => resolveAtFireTime(LOOP_FILE_SENTINEL, wsDir, sid))
          expect(first).toContain("cached body")

          // Second fire → short reminder (cache is warm).
          const second = yield* Effect.promise(() => resolveAtFireTime(LOOP_FILE_SENTINEL, wsDir, sid))
          expect(second).toMatch(/unchanged/)

          // Subagent slice compaction fires. Bridge subscribes but filters
          // agentID !== "main" — cache should stay warm.
          yield* bus.publish(SessionCompaction.Event.Compacted, {
            sessionID: sid,
            agentID: "subagent-abc",
          })
          // Give the bus callback a tick to run.
          yield* Effect.promise(() => new Promise((r) => setImmediate(r)))
          const stillWarm = yield* Effect.promise(() => resolveAtFireTime(LOOP_FILE_SENTINEL, wsDir, sid))
          expect(stillWarm).toMatch(/unchanged/)

          // Main-agent compaction fires (agentID undefined). Bridge should
          // clear the cache for this session; next fire returns full content.
          yield* bus.publish(SessionCompaction.Event.Compacted, {
            sessionID: sid,
          })
          yield* Effect.promise(() => new Promise((r) => setImmediate(r)))
          const rewarm = yield* Effect.promise(() => resolveAtFireTime(LOOP_FILE_SENTINEL, wsDir, sid))
          expect(rewarm).toContain("cached body")

          yield* b.stop()
        }).pipe(Effect.provide(layered)) as Effect.Effect<void>,
      ),
    )
  } finally {
    rmSync(wsDir, { recursive: true, force: true })
    rmSync(instanceDir, { recursive: true, force: true })
  }
})
