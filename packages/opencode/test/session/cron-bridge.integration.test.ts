import { test, expect, beforeEach, afterEach } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { InstanceState } from "@/effect"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { Flag } from "@/flag/flag"

import { Bus } from "@/bus"
import { SessionStatus } from "@/session/status"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt, type PromptInput, type InjectScheduledPromptInput } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import {
  Scheduler,
  defaultLayer as SchedulerDefaultLayer,
  type Interface as SchedulerInterface,
  type StartOpts,
} from "@/cron/scheduler"
import { clearAllLoopStates, getLoopState, getStrikes, setLoopState } from "@/cron/loop-state"
import { addSessionCronTask, getSessionCronTasks, readCronTasks, removeSessionCronTasks, writeCronTasks } from "@/cron/cron-task"
import { getLockFilePath } from "@/cron/cron-lock"
import { CronBridge, layer as cronBridgeLayer, type Interface as CronBridgeInterface } from "@/session/cron-bridge"

import * as PromptModule from "@/session/prompt"

// ---- Capture target: a stub SessionPrompt.Service whose `prompt` records its
// input and returns a minimal MessageV2.WithParts. The integration test asserts
// the bridge funnels onFire(task) through this Service entry point, with the
// cron origin marker plumbed onto a synthetic text part — i.e. through the
// front door, not a side channel.

type CapturedPrompt = PromptInput
type Capture = { value: CapturedPrompt[]; beforePrompt?: Effect.Effect<void> }

const makeCaptureLayer = (captured: Capture) =>
  Layer.succeed(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      cancel: () => Effect.succeed(0),
      promptAsync: () => Effect.die("promptAsync not expected in cron-bridge test"),
      prompt: (input: PromptInput) =>
        Effect.andThen(
          captured.beforePrompt ?? Effect.void,
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
        ),
      recovery: () => Effect.succeed([]),
      resume: () => Effect.die("resume not expected in cron-bridge test"),
      resumeBackground: () => Effect.die("resumeBackground not expected in cron-bridge test"),
      cascadeSubagentResume: () => Effect.succeed([]),
      resumeMainCascading: () => Effect.void,
      loop: () => Effect.die("loop not expected in cron-bridge test"),
      shell: () => Effect.die("shell not expected in cron-bridge test"),
      command: () => Effect.die("command not expected in cron-bridge test"),
      resolvePromptParts: () => Effect.succeed([]),
      sweepOrphanAssistants: () => Effect.void,
      sweepOrphanToolParts: () => Effect.void,
      predict: () => Effect.succeed(""),
      genTitle: () => Effect.succeed({ title: "", status: "fallback" as const }),
    }),
  )

const captureInject = Effect.gen(function* () {
  const prompt = yield* SessionPrompt.Service
  return (input: InjectScheduledPromptInput) =>
    PromptModule.injectScheduledPrompt(input).pipe(Effect.provideService(SessionPrompt.Service, prompt))
})

const waitFor = (predicate: () => boolean) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await Bun.sleep(5)
    expect(predicate()).toBe(true)
  })

const addDueTask = (scheduler: SchedulerInterface, prompt: string) =>
  scheduler.add({ session_id: sid, cron: "* * * * *", prompt, recurring: false, durable: false }).pipe(
    Effect.tap((task) =>
      Effect.sync(() => {
        addSessionCronTask({ ...task, createdAt: Date.now() - 5 * 60_000 })
      }),
    ),
  )

const MountContext = Context.Reference("cron-bridge-test/MountContext", { defaultValue: () => "outside" })
const originalCronFlag = Flag.MIMOCODE_EXPERIMENTAL_CRON
const originalCronEnv = process.env.MIMOCODE_EXPERIMENTAL_CRON
const originalDisableEnv = process.env.MIMOCODE_DISABLE_CRON

afterEach(() => {
  ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = originalCronFlag
  if (originalCronEnv === undefined) delete process.env.MIMOCODE_EXPERIMENTAL_CRON
  else process.env.MIMOCODE_EXPERIMENTAL_CRON = originalCronEnv
  if (originalDisableEnv === undefined) delete process.env.MIMOCODE_DISABLE_CRON
  else process.env.MIMOCODE_DISABLE_CRON = originalDisableEnv
})

const freshDir = () => mkdtempSync(join(tmpdir(), "cron-bridge-"))

beforeEach(() => {
  clearAllLoopStates()
  removeSessionCronTasks(getSessionCronTasks().map((t) => t.id))
  delete process.env.MIMOCODE_DISABLE_CRON
  process.env.MIMOCODE_EXPERIMENTAL_CRON = "1"
  ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = true
})

const sid = SessionID.make("ses_cronbridge_test")

const harness = <A>(
  captured: Capture,
  work: (ctx: {
    bridge: CronBridgeInterface
    scheduler: SchedulerInterface
    inject: (input: InjectScheduledPromptInput) => Effect.Effect<void, unknown>
    bus: Bus.Interface
  }) => Effect.Effect<A, unknown, SessionPrompt.Service>,
  onStart?: (opts: StartOpts) => void,
  schedulerBase: Layer.Layer<Scheduler> = SchedulerDefaultLayer,
) => {
  const capture = makeCaptureLayer(captured)
  const schedulerLayer = onStart
    ? Layer.effect(
        Scheduler,
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          return Scheduler.of({
            ...scheduler,
            start: (opts) =>
              Effect.andThen(
                Effect.sync(() => onStart(opts)),
                scheduler.start(opts),
              ),
          })
        }),
      ).pipe(Layer.provide(schedulerBase))
    : schedulerBase
  const base = Layer.mergeAll(schedulerLayer, SessionStatus.defaultLayer, Bus.layer, capture)
  const bridge = cronBridgeLayer.pipe(Layer.provide(base))
  const eff = Effect.gen(function* () {
    const b = yield* CronBridge
    const s = yield* Scheduler
    const inject = yield* captureInject
    const bus = yield* Bus.Service
    return yield* work({ bridge: b, scheduler: s, inject, bus })
  })
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

test("scheduler tick delivers through the mounted prompt service and start-time context", async () => {
  const observed: { owner: string; instance: unknown }[] = []
  const captured: Capture = {
    value: [],
    beforePrompt: Effect.gen(function* () {
      observed.push({ owner: yield* MountContext, instance: yield* InstanceRef })
    }),
  }
  const dir = freshDir()
  try {
    await harness(captured, ({ bridge, scheduler, inject }) =>
      Effect.gen(function* () {
        const instance = yield* InstanceRef
        expect(instance).toBeDefined()
        yield* bridge.start(sid, dir, inject).pipe(Effect.provideService(MountContext, "mounted"))
        const task = yield* addDueTask(scheduler, "check deployment")
        const before = Date.now()
        yield* scheduler
          .tickOnce()
          .pipe(Effect.provideService(MountContext, "tick"), Effect.provideService(InstanceRef, undefined))
        yield* waitFor(() => captured.value.length === 1)
        expect(observed).toEqual([{ owner: "mounted", instance }])
        const input = captured.value[0]!
        expect(input.sessionID).toBe(sid)
        expect(input.source).toBe("hook")
        expect(input.parts).toHaveLength(1)
        const part = input.parts[0]!
        expect(part.type).toBe("text")
        if (part.type !== "text") throw new Error("expected text part")
        expect(part.synthetic).toBe(true)
        const origin = part.metadata?.origin as { firedAt: string }
        expect(part.metadata).toMatchObject({
          origin: { kind: "cron", taskId: task.id, kindOfTask: "cron" },
          priority: "later",
        })
        expect(origin.firedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
        expect(Date.parse(origin.firedAt)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000)
        expect(Date.parse(origin.firedAt)).toBeLessThanOrEqual(Date.now())
        expect(part.text).toBe(`[cron fire @ ${origin.firedAt}] check deployment`)
        yield* scheduler.tickOnce()
        expect(captured.value).toHaveLength(1)
        yield* bridge.stop()
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("busy to idle runs keepalive on the mounted scheduler and stop removes the subscription", async () => {
  const captured: Capture = { value: [] }
  const dir = freshDir()
  const priorBudget = process.env.MIMOCODE_LOOP_KEEPALIVE_BUDGET
  process.env.MIMOCODE_LOOP_KEEPALIVE_BUDGET = "1"
  try {
    await harness(captured, ({ bridge, scheduler, inject, bus }) =>
      Effect.gen(function* () {
        yield* bridge.start(sid, dir, inject)
        const overdue = {
          prompt: "edge keepalive",
          startedAt: Date.now(),
          lastScheduledFor: Date.now() - 1000,
          keepaliveStrikes: 0,
        }
        setLoopState(overdue)
        yield* bus.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "busy" } })
        const task = yield* addDueTask(scheduler, "wait until idle")
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
        yield* scheduler.tickOnce()
        expect(captured.value).toHaveLength(0)
        expect(getSessionCronTasks().some((row) => row.id === task.id)).toBe(true)
        yield* bus.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
        yield* waitFor(() => getStrikes(overdue.prompt) === 1)
        expect(getLoopState(overdue.prompt)!.lastScheduledFor).toBeGreaterThan(Date.now())
        expect(
          getSessionCronTasks().filter((row) => row.kind === "loop" && row.prompt === overdue.prompt),
        ).toHaveLength(1)
        yield* scheduler.tickOnce()
        yield* waitFor(() => captured.value.length === 1)
        yield* bridge.stop()
        setLoopState(overdue)
        yield* bus.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "busy" } })
        yield* bus.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
        yield* Effect.sleep("30 millis")
        expect(getStrikes(overdue.prompt)).toBe(0)
        yield* scheduler.tickOnce()
        expect(captured.value).toHaveLength(1)
      }),
    )
  } finally {
    if (priorBudget === undefined) delete process.env.MIMOCODE_LOOP_KEEPALIVE_BUDGET
    else process.env.MIMOCODE_LOOP_KEEPALIVE_BUDGET = priorBudget
    rmSync(dir, { recursive: true, force: true })
  }
})

test("stop waits for an in-flight start and cannot leave a late scheduler running", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const stopping = Deferred.makeUnsafe<void>()
  let running = false
  let stops = 0
  const delayedScheduler = Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      const scheduler = yield* Scheduler
      return Scheduler.of({
        ...scheduler,
        start: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            running = true
          }),
        stop: () =>
          Effect.sync(() => {
            running = false
            stops++
          }),
      })
    }),
  ).pipe(Layer.provide(SchedulerDefaultLayer))
  const dir = freshDir()
  try {
    await harness(
      { value: [] },
      ({ bridge, inject }) =>
        Effect.gen(function* () {
          const start = yield* bridge.start(sid, dir, inject).pipe(Effect.forkChild)
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          const stop = yield* Effect.andThen(Deferred.succeed(stopping, undefined), bridge.stop()).pipe(
            Effect.forkChild,
          )
          yield* Deferred.await(stopping)
          yield* Effect.sleep("20 millis")
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(start)
          yield* Fiber.join(stop)
          expect(running).toBe(false)
          expect(stops).toBe(1)
          yield* bridge.stop()
          expect(running).toBe(false)
          expect(stops).toBe(1)
        }),
      undefined,
      delayedScheduler,
    )
    expect(running).toBe(false)
    expect(stops).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const teardown of ["stop", "scope close"] as const) {
  test(`${teardown} interrupts pending delivery and rejects stale fires${teardown === "stop" ? " after restart" : ""}`, async () => {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let attempts = 0
    let finalized = 0
    const captured: Capture = {
      value: [],
      beforePrompt: Effect.gen(function* () {
        attempts++
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized++
          }),
        ),
      ),
    }
    const mounts: StartOpts[] = []
    const dir = freshDir()
    try {
      const escaped = await harness(
        captured,
        ({ bridge, scheduler, inject }) =>
          Effect.gen(function* () {
            yield* bridge.start(sid, dir, inject)
            const task = yield* addDueTask(scheduler, "pending delivery")
            yield* scheduler.tickOnce()
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
            expect(attempts).toBe(1)
            expect(captured.value).toHaveLength(0)
            if (teardown === "stop") {
              yield* bridge.stop()
              expect(finalized).toBe(1)
              yield* Deferred.succeed(release, undefined)
              yield* addDueTask(scheduler, "after stop")
              yield* scheduler.tickOnce()
              mounts[0]!.onFire(task)
              yield* Effect.sleep("30 millis")
              expect(attempts).toBe(1)
              expect(captured.value).toHaveLength(0)
              const nextSession = SessionID.make("ses_cronbridge_restarted")
              yield* bridge.start(nextSession, dir, inject)
              mounts[0]!.onFire(task)
              yield* Effect.sleep("30 millis")
              expect(attempts).toBe(1)
              expect(captured.value).toHaveLength(0)
              yield* scheduler.tickOnce()
              yield* waitFor(() => captured.value.length === 1)
              expect(captured.value[0]!.sessionID).toBe(nextSession)
              expect(attempts).toBe(2)
              yield* bridge.stop()
            }
            return { scheduler, task }
          }),
        (opts) => mounts.push(opts),
      )
      if (teardown === "scope close") {
        expect(finalized).toBe(1)
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* Deferred.succeed(release, undefined)
            yield* addDueTask(escaped.scheduler, "after scope close")
            yield* escaped.scheduler.tickOnce()
            mounts[0]!.onFire(escaped.task)
            yield* Effect.sleep("30 millis")
          }),
        )
        expect(attempts).toBe(1)
        expect(captured.value).toHaveLength(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("cron-bridge start wires Scheduler with isLoading + isKilled + onFire", async () => {
  const captured: { value: CapturedPrompt[] } = { value: [] }
  const dir = freshDir()
  try {
    await harness(captured, ({ bridge, scheduler, inject }) =>
      Effect.gen(function* () {
        yield* bridge.start(sid, dir, inject)

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

// Check the storage destination before delegating, so a regression never writes at `/`.
const directoryCheckedScheduler = Layer.effect(
  Scheduler,
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    return Scheduler.of({
      ...scheduler,
      start: (input) => Effect.gen(function* () {
        expect(input.dir).toBe(yield* InstanceState.directory)
        yield* scheduler.start(input)
      }),
    })
  }),
).pipe(Layer.provide(SchedulerDefaultLayer))
const directoryLayers = Layer.mergeAll(directoryCheckedScheduler, SessionStatus.defaultLayer, Bus.layer)
const directoryTest = testEffect(Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  directoryLayers,
  cronBridgeLayer.pipe(Layer.provide(directoryLayers)),
))

// Embedded hosts keep their own cwd; TUI can start in a Git subdirectory or outside Git.
for (const kind of ["git-root", "git-subdirectory", "non-git"] as const) {
  directoryTest.live(`cron-bridge stores durable tasks and locks in the instance directory (${kind})`, () =>
    Effect.gen(function* () {
      const workspace = yield* tmpdirScoped(kind === "non-git" ? { outsideGit: true } : { git: true })
      const directory = kind === "git-subdirectory" ? join(workspace, "nested") : workspace
      mkdirSync(directory, { recursive: true })
      expect(directory).not.toBe(process.cwd())
      yield* provideInstance(directory)(Effect.gen(function* () {
        const context = yield* InstanceState.context
        expect(context.directory).toBe(directory)
        expect(context.worktree).toBe(kind === "non-git" ? "/" : workspace)
        const bridge = yield* CronBridge
        const scheduler = yield* Scheduler
        const task = {
          id: "workspace-cron",
          cron: "0 0 1 1 *",
          prompt: "workspace task",
          createdAt: Date.now(),
          createdBySessionId: sid,
          recurring: true,
          durable: true,
        }
        yield* writeCronTasks([task], directory)
        yield* bridge.start(sid, context.worktree)
        expect(yield* scheduler.list({ session_id: sid })).toEqual([task])
        expect(existsSync(getLockFilePath(directory))).toBe(true)
        const created = yield* scheduler.add({
          session_id: sid,
          cron: "0 0 1 1 *",
          prompt: "another workspace task",
          recurring: true,
          durable: true,
        })
        expect((yield* readCronTasks(directory)).map((entry) => entry.id)).toEqual([task.id, created.id])
        yield* bridge.stop()
        expect(existsSync(getLockFilePath(directory))).toBe(false)
        expect((yield* readCronTasks(directory)).map((entry) => entry.id)).toEqual([task.id, created.id])
      }))
    }),
  )
}

test("cron-bridge is a no-op when MIMOCODE_EXPERIMENTAL_CRON is explicitly disabled", async () => {
  const captured: { value: CapturedPrompt[] } = { value: [] }
  const originalFlag = Flag.MIMOCODE_EXPERIMENTAL_CRON
  ;(Flag as { MIMOCODE_EXPERIMENTAL_CRON: boolean }).MIMOCODE_EXPERIMENTAL_CRON = false
  const dir = freshDir()
  try {
    await harness(captured, ({ bridge, scheduler, inject }) =>
      Effect.gen(function* () {
        yield* bridge.start(sid, dir, inject)
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
    await harness(captured, ({ bridge, inject }) =>
      Effect.gen(function* () {
        yield* bridge.start(sid, dir, inject)
        yield* bridge.start(sid, dir, inject) // second call no-ops
        yield* bridge.stop()
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
            const inject = yield* captureInject
            yield* b.start(sid, dir, inject)
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
          const inject = yield* captureInject
          yield* b.start(sid, wsDir, inject)

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
