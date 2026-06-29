import { test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  Scheduler,
  layer as schedulerLayer,
  type LoopEndedEvent,
  type StartOpts,
} from "@/cron/scheduler"
import { clearAllLoopStates } from "@/cron/loop-state"
import { removeSessionCronTasks, getSessionCronTasks } from "@/cron/cron-task"

const provided = <A, E>(eff: Effect.Effect<A, E, Scheduler>) =>
  Effect.runPromise(eff.pipe(Effect.provide(schedulerLayer)) as Effect.Effect<A, E, never>)

const freshDir = () => mkdtempSync(join(tmpdir(), "sched-"))

const baseStartOpts = (dir: string, overrides: Partial<StartOpts> = {}): StartOpts => ({
  workspaceRoot: dir,
  sessionID: "ses_test",
  isLoading: () => true, // keep ticks no-op for unit tests; we drive operations directly
  isKilled: () => false,
  onFire: () => {},
  onLoopEnded: () => {},
  dir,
  ...overrides,
})

beforeEach(() => {
  clearAllLoopStates()
  // Drain any session tasks left from prior tests
  removeSessionCronTasks(getSessionCronTasks().map((t) => t.id))
})

test("add + get + remove session-only task", async () => {
  const dir = freshDir()
  await provided(
    Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start(baseStartOpts(dir))
      const created = yield* sched.add({
        session_id: "ses_test",
        cron: "*/5 * * * *",
        prompt: "hello",
        recurring: true,
        durable: false,
      })
      expect(created.prompt).toBe("hello")
      expect(created.recurring).toBe(true)

      const got = yield* sched.get(created.id)
      expect(got).not.toBe(null)
      expect(got?.id).toBe(created.id)

      const removed = yield* sched.remove(created.id)
      expect(removed).toBe(true)

      const afterGet = yield* sched.get(created.id)
      expect(afterGet).toBe(null)

      yield* sched.stop()
    }),
  )
  rmSync(dir, { recursive: true, force: true })
})

test("armLoop creates a loop task and returns scheduledFor", async () => {
  const dir = freshDir()
  await provided(
    Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start(baseStartOpts(dir))

      const result = yield* sched.armLoop({
        prompt: "tick",
        delay_seconds: 120,
        reason_length: 0,
      })

      expect(result).not.toBe(null)
      expect(result!.scheduledFor).toBeGreaterThan(Date.now())
      expect(result!.clampedDelaySeconds).toBe(120)
      expect(result!.wasClamped).toBe(false)
      expect(result!.supersededCount).toBe(0)

      const tasks = yield* sched.list({ kind: "loop" })
      expect(tasks.length).toBe(1)
      expect(tasks[0]!.kind).toBe("loop")
      expect(tasks[0]!.prompt).toBe("tick")

      yield* sched.stop()
    }),
  )
  rmSync(dir, { recursive: true, force: true })
})

test("armLoop clamps delay_seconds to [60, 3600]", async () => {
  const dir = freshDir()
  await provided(
    Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start(baseStartOpts(dir))

      const low = yield* sched.armLoop({ prompt: "low", delay_seconds: 10, reason_length: 0 })
      expect(low!.clampedDelaySeconds).toBe(60)
      expect(low!.wasClamped).toBe(true)

      const high = yield* sched.armLoop({ prompt: "high", delay_seconds: 9999, reason_length: 0 })
      expect(high!.clampedDelaySeconds).toBe(3600)
      expect(high!.wasClamped).toBe(true)

      const fine = yield* sched.armLoop({ prompt: "fine", delay_seconds: 300, reason_length: 0 })
      expect(fine!.wasClamped).toBe(false)

      yield* sched.stop()
    }),
  )
  rmSync(dir, { recursive: true, force: true })
})

test("armLoop supersedes prior loop task for same prompt", async () => {
  const dir = freshDir()
  await provided(
    Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start(baseStartOpts(dir))

      const first = yield* sched.armLoop({ prompt: "same", delay_seconds: 120, reason_length: 0 })
      expect(first!.supersededCount).toBe(0)

      const second = yield* sched.armLoop({ prompt: "same", delay_seconds: 180, reason_length: 0 })
      expect(second!.supersededCount).toBe(1)

      const loops = yield* sched.list({ kind: "loop" })
      expect(loops.length).toBe(1)
      expect(loops[0]!.prompt).toBe("same")

      yield* sched.stop()
    }),
  )
  rmSync(dir, { recursive: true, force: true })
})

test("rename updates task prompt", async () => {
  const dir = freshDir()
  await provided(
    Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start(baseStartOpts(dir))

      const created = yield* sched.add({
        session_id: "ses_test",
        cron: "*/10 * * * *",
        prompt: "before",
        recurring: true,
        durable: false,
      })

      const ok = yield* sched.rename(created.id, "after")
      expect(ok).toBe(true)

      const got = yield* sched.get(created.id)
      expect(got?.prompt).toBe("after")

      yield* sched.stop()
    }),
  )
  rmSync(dir, { recursive: true, force: true })
})

test("endLoop cancels pending and emits loop_ended", async () => {
  const dir = freshDir()
  const events: LoopEndedEvent[] = []
  await provided(
    Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start(
        baseStartOpts(dir, {
          onLoopEnded: (e) => events.push(e),
        }),
      )

      yield* sched.armLoop({ prompt: "endme", delay_seconds: 600, reason_length: 0 })
      const before = yield* sched.list({ kind: "loop" })
      expect(before.length).toBe(1)

      yield* sched.endLoop("endme", "user_abort")

      const after = yield* sched.list({ kind: "loop" })
      expect(after.length).toBe(0)
      expect(events.length).toBe(1)
      expect(events[0]!.reason).toBe("user_abort")
      expect(events[0]!.prompt).toBe("endme")

      yield* sched.stop()
    }),
  )
  rmSync(dir, { recursive: true, force: true })
})
