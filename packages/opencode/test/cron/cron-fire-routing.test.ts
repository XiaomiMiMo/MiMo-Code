import { test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Scheduler, layer as schedulerLayer } from "@/cron/scheduler"
import { removeSessionCronTasks, getSessionCronTasks } from "@/cron/cron-task"
import { fireTargetSessionId } from "@/session/cron-bridge"
import { SessionID } from "@/session/schema"

const provided = <A, E>(eff: Effect.Effect<A, E, Scheduler>) =>
  Effect.runPromise(eff.pipe(Effect.provide(schedulerLayer)) as Effect.Effect<A, E, never>)

const freshDir = () => mkdtempSync(join(tmpdir(), "cron-route-"))

beforeEach(() => {
  removeSessionCronTasks(getSessionCronTasks().map((t) => t.id))
})

test("fire targets the owning session recorded on the task, not the mounting session", () => {
  const target = fireTargetSessionId({ createdBySessionId: "ses_owner" }, SessionID.make("ses_mounted"))
  expect(String(target)).toBe("ses_owner")
})

test("fire falls back to the mounting session when the task has no owner", () => {
  const target = fireTargetSessionId({}, SessionID.make("ses_mounted"))
  expect(String(target)).toBe("ses_mounted")
})

test("list with all:true crosses the caller's ownership scope", async () => {
  const dir = freshDir()
  await provided(
    Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: dir,
        sessionID: "ses_first",
        isLoading: () => true,
        isKilled: () => false,
        onFire: () => {},
        onLoopEnded: () => {},
        dir,
      })
      // Second session creates a non-durable job in the same process.
      yield* sched.add({
        cron: "*/10 * * * *",
        prompt: "cross-session probe",
        recurring: true,
        session_id: "ses_second",
        durable: false,
      })

      const scoped = yield* sched.list({ session_id: "ses_first" })
      expect(scoped.map((t) => t.id)).not.toContain("x") // scope still filters by default
      expect(scoped.some((t) => t.prompt.includes("cross-session"))).toBe(false)

      const all = yield* sched.list({ session_id: "ses_first", all: true })
      expect(all.some((t) => t.prompt.includes("cross-session"))).toBe(true)
    }),
  )
  rmSync(dir, { recursive: true, force: true })
})
