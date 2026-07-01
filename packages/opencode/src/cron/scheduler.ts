import { Context, Effect, Layer } from "effect"
import { randomUUID } from "crypto"
import { Log } from "@/util"
import {
  type CronTask,
  readCronTasks,
  writeCronTasks,
  getSessionCronTasks,
  addSessionCronTask,
  removeSessionCronTasks,
  markCronTasksFired,
  findMissedTasks,
} from "./cron-task"
import {
  type JitterConfig,
  DEFAULT_JITTER,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from "./cron-jitter"
import { tryAcquireSchedulerLock, releaseSchedulerLock } from "./cron-lock"
import * as LoopState from "./loop-state"

const log = Log.create({ service: "scheduler" })

export type LoopEndedReason =
  | "gate_off"
  | "model_stopped"
  | "aged_out"
  | "user_abort"
  | "budget"
  | "error"

export type LoopEndedEvent = {
  reason: LoopEndedReason
  prompt: string
  via_keepalive?: boolean
}

export type StartOpts = {
  workspaceRoot: string
  sessionID: string
  isLoading: () => boolean
  isKilled: () => boolean
  onFire: (task: CronTask) => void
  onLoopEnded: (e: LoopEndedEvent) => void
  /**
   * Fires when the model successfully re-arms a loop via `armLoop` from a
   * model-driven turn. The bridge uses this to track which loop prompts the
   * model touched during a turn so the busy→idle keepalive sweep knows whose
   * strikes to reset. Keepalive-driven auto-arms set `viaKeepalive: true` on
   * `armLoop` so this callback is NOT invoked for them — otherwise the
   * keepalive fire would itself appear to "re-arm" and clear strikes.
   */
  onArmLoop?: (prompt: string) => void
  dir?: string
  jitterConfig?: JitterConfig
}

export type NewCronTask = {
  session_id: string
  cron: string
  prompt: string
  recurring: boolean
  durable: boolean
  kind?: "loop"
}

export type ListFilter = {
  session_id?: string
  kind?: "cron" | "loop"
  durable_only?: boolean
}

export type ArmLoopInput = {
  prompt: string
  delay_seconds: number
  reason_length: number
  /**
   * Marks this arm as a bridge-driven keepalive auto-fire. When true the
   * scheduler skips invoking `StartOpts.onArmLoop` so the bridge does not
   * treat this arm as a model re-arm.
   */
  viaKeepalive?: boolean
}

export type ArmLoopResult = {
  scheduledFor: number
  clampedDelaySeconds: number
  wasClamped: boolean
  supersededCount: number
}

export interface Interface {
  readonly start: (opts: StartOpts) => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly add: (task: NewCronTask) => Effect.Effect<CronTask>
  readonly remove: (id: string, opts?: { session_id?: string }) => Effect.Effect<boolean>
  readonly rename: (id: string, prompt: string, opts?: { session_id?: string }) => Effect.Effect<boolean>
  readonly list: (filter: ListFilter) => Effect.Effect<CronTask[]>
  readonly get: (id: string, opts?: { session_id?: string }) => Effect.Effect<CronTask | null>
  readonly armLoop: (input: ArmLoopInput) => Effect.Effect<ArmLoopResult | null>
  readonly resetKeepaliveStrikes: (prompt: string) => Effect.Effect<void>
  readonly incrementKeepaliveStrikes: (prompt: string) => Effect.Effect<void>
  readonly endLoop: (
    prompt: string,
    reason: LoopEndedReason,
    opts?: { via_keepalive?: boolean },
  ) => Effect.Effect<void>
  readonly nextFireTime: () => Effect.Effect<number | null>
  /**
   * Test-only seam: runs one iteration of the same tick body the setInterval
   * driver calls, synchronously inside the caller's Effect. Production code
   * does not call this — it exists so the end-to-end smoke test can drive a
   * fire without waiting on the 1s tick cadence or smuggling in a fake clock.
   *
   * Honors the same gates as the live tick: returns early when not started,
   * killed, or loading.
   */
  readonly tickOnce: () => Effect.Effect<void>
}

export class Scheduler extends Context.Service<Scheduler, Interface>()("@mimocode/Scheduler") {}

type Runtime = {
  opts: StartOpts
  cfg: JitterConfig
  interval: ReturnType<typeof setInterval> | null
  inFlight: Set<string>
  nextFireAt: Map<string, number>
  isOwner: boolean
}

const newId = () => randomUUID().replace(/-/g, "").slice(0, 8)

const makeImpl = (): Interface => {
  let rt: Runtime | null = null

  const allTasks = Effect.gen(function* () {
    const session = getSessionCronTasks()
    if (!rt || !rt.isOwner) return session
    const file = yield* readCronTasks(rt.opts.dir)
    return [...file, ...session]
  })

  const computeNextFireFor = (task: CronTask, anchor: number, cfg: JitterConfig): number => {
    const fn = task.recurring ? jitteredNextCronRunMs : oneShotJitteredNextCronRunMs
    return fn(task.cron, anchor, task.id, cfg) ?? Number.POSITIVE_INFINITY
  }

  const tick = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!rt) return
      if (rt.opts.isKilled()) return
      if (rt.opts.isLoading()) return

      const sessionTasks = getSessionCronTasks()
      const sessionIds = new Set(sessionTasks.map((t) => t.id))
      const fileTasks = rt.isOwner ? yield* readCronTasks(rt.opts.dir) : []
      const tasks = [...fileTasks, ...sessionTasks]
      const now = Date.now()

      // Tick-local latch. Once a task fires this tick, break out and let the
      // next 1s tick handle the rest. The earlier `if (rt.opts.isLoading())`
      // check was insufficient: isLoading() reads handle.loading from the
      // cron-bridge, which only flips inside an async bus-subscription
      // callback triggered by the injection's `busy` event. onFire itself is
      // fire-and-forget (dynamic import().then(...)), so the second iteration
      // of this loop runs before any microtask can update handle.loading.
      // The synchronous latch prevents same-tick double-fire deterministically.
      let firedThisTick = false

      for (const task of tasks) {
        if (firedThisTick) break
        if (rt.opts.isLoading()) break
        if (rt.opts.isKilled()) break
        if (rt.inFlight.has(task.id)) continue

        if (!rt.nextFireAt.has(task.id)) {
          const anchor = task.lastFiredAt ?? task.createdAt
          rt.nextFireAt.set(task.id, computeNextFireFor(task, anchor, rt.cfg))
        }

        const due = rt.nextFireAt.get(task.id) ?? Number.POSITIVE_INFINITY
        if (now < due) continue

        const aged =
          task.recurring === true &&
          task.permanent !== true &&
          now - task.createdAt >= rt.cfg.recurringMaxAgeMs

        // Routing is by identity (file vs session origin), not by the `durable`
        // field: tasks written to disk before the stripRuntime fix may have
        // `durable: undefined` even though they live on disk. Looking up
        // session-store membership is the durable-only-on-disk signal we can
        // actually trust.
        const isFileTask = !sessionIds.has(task.id)

        rt.opts.onFire(task)
        firedThisTick = true

        if (task.recurring === true && !aged) {
          rt.nextFireAt.set(task.id, computeNextFireFor(task, now, rt.cfg))
          if (isFileTask) {
            rt.inFlight.add(task.id)
            yield* markCronTasksFired([task.id], now, rt.opts.dir).pipe(
              Effect.orElseSucceed(() => undefined),
            )
            rt.inFlight.delete(task.id)
          }
          continue
        }

        rt.inFlight.add(task.id)
        rt.nextFireAt.delete(task.id)
        if (isFileTask) {
          const current = yield* readCronTasks(rt.opts.dir)
          yield* writeCronTasks(
            current.filter((t) => t.id !== task.id),
            rt.opts.dir,
          ).pipe(Effect.orElseSucceed(() => undefined))
        } else {
          removeSessionCronTasks([task.id])
        }
        rt.inFlight.delete(task.id)

        if (aged) {
          rt.opts.onLoopEnded({ reason: "aged_out", prompt: task.prompt })
        }
      }
    })

  const start: Interface["start"] = (opts) =>
    Effect.gen(function* () {
      if (rt) return
      const cfg = opts.jitterConfig ?? DEFAULT_JITTER
      const isOwner = yield* tryAcquireSchedulerLock({ dir: opts.dir })
      rt = {
        opts,
        cfg,
        interval: null,
        inFlight: new Set(),
        nextFireAt: new Map(),
        isOwner,
      }
      log.info("scheduler.start", { sessionID: opts.sessionID, isOwner })

      // PR #1479 bonus: surface durable one-shot tasks that fired-overdue
      // while the scheduler was down (e.g. machine off through a 9am
      // reminder). findMissedTasks was exported + unit-tested but had no
      // callers in src — the documented catch-up behavior was dead code.
      // We only surface as the lock owner: a non-owner would double-emit
      // missed-task notifications if it later took over the lock.
      if (isOwner) {
        const all = yield* readCronTasks(opts.dir)
        const missed = findMissedTasks(all, Date.now())
        for (const task of missed) {
          opts.onFire(task)
          // Remove durable one-shot from disk after surfacing so it doesn't
          // re-surface on the next start.
          const remaining = (yield* readCronTasks(opts.dir)).filter((t) => t.id !== task.id)
          yield* writeCronTasks(remaining, opts.dir).pipe(Effect.orElseSucceed(() => undefined))
        }
        if (missed.length > 0) log.info("missed_tasks_surfaced", { count: missed.length })
      }

      const runTick = () => {
        if (!rt) return
        Effect.runPromise(tick().pipe(Effect.orElseSucceed(() => undefined))).catch((e) => {
          log.warn("tick error", { error: String(e) })
        })
      }
      rt.interval = setInterval(runTick, 1000)
    })

  const stop: Interface["stop"] = () =>
    Effect.gen(function* () {
      if (!rt) return
      if (rt.interval) clearInterval(rt.interval)
      const owned = rt.isOwner
      const dir = rt.opts.dir
      rt = null
      if (owned) {
        yield* releaseSchedulerLock({ dir }).pipe(Effect.orElseSucceed(() => undefined))
      }
      log.info("scheduler.stop")
    })

  const add: Interface["add"] = (input) =>
    Effect.gen(function* () {
      const id = newId()
      const created: CronTask = {
        id,
        cron: input.cron,
        prompt: input.prompt,
        createdAt: Date.now(),
        recurring: input.recurring,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.session_id ? { createdBySessionId: input.session_id } : {}),
        durable: input.durable,
      }

      if (input.durable) {
        const dir = rt?.opts.dir
        const existing = yield* readCronTasks(dir)
        yield* writeCronTasks([...existing, created], dir).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        return created
      }

      addSessionCronTask(created)
      return created
    })

  // Internal helper: returns the task with this id, optionally restricted to
  // tasks that the named session created. PR #1479 finding #9: the cron tool
  // accepts --session on get/delete/rename but the scheduler ignored it;
  // any session could read/cancel another's job by id. When session_id is
  // supplied we now match on createdBySessionId before any action.
  const findById = (id: string, session_id?: string) =>
    Effect.gen(function* () {
      const dir = rt?.opts.dir
      const sessionTasks = getSessionCronTasks()
      const file = rt ? yield* readCronTasks(dir) : []
      const all = [...file, ...sessionTasks]
      const t = all.find((x) => x.id === id)
      if (!t) return null
      if (session_id && t.createdBySessionId && t.createdBySessionId !== session_id) return null
      return t
    })

  const removeBy = (id: string, session_id?: string) =>
    Effect.gen(function* () {
      const target = yield* findById(id, session_id)
      if (!target) return false
      const dir = rt?.opts.dir
      const session = getSessionCronTasks()
      const inSession = session.some((t) => t.id === id)
      if (inSession) {
        removeSessionCronTasks([id])
        if (rt) rt.nextFireAt.delete(id)
        return true
      }

      const file = yield* readCronTasks(dir)
      const next = file.filter((t) => t.id !== id)
      if (next.length === file.length) return false
      yield* writeCronTasks(next, dir).pipe(Effect.orElseSucceed(() => undefined))
      if (rt) rt.nextFireAt.delete(id)
      return true
    })

  const remove: Interface["remove"] = (id, opts) => removeBy(id, opts?.session_id)

  const rename: Interface["rename"] = (id, prompt, opts) =>
    Effect.gen(function* () {
      const target = yield* findById(id, opts?.session_id)
      if (!target) return false
      const dir = rt?.opts.dir
      const session = getSessionCronTasks()
      const found = session.find((t) => t.id === id)
      if (found) {
        removeSessionCronTasks([id])
        addSessionCronTask({ ...found, prompt })
        return true
      }
      const file = yield* readCronTasks(dir)
      const idx = file.findIndex((t) => t.id === id)
      if (idx < 0) return false
      const next = file.slice()
      next[idx] = { ...next[idx]!, prompt }
      yield* writeCronTasks(next, dir).pipe(Effect.orElseSucceed(() => undefined))
      return true
    })

  const list: Interface["list"] = (filter) =>
    Effect.gen(function* () {
      const dir = rt?.opts.dir
      const file = yield* readCronTasks(dir).pipe(Effect.orElseSucceed(() => [] as CronTask[]))
      const session = getSessionCronTasks()
      const all = [
        ...file.map((t) => ({ ...t, durable: true as const })),
        ...session.map((t) => ({ ...t, durable: false as const })),
      ]
      return all.filter((t) => {
        if (filter.session_id && t.createdBySessionId !== filter.session_id) return false
        if (filter.kind === "loop" && t.kind !== "loop") return false
        if (filter.kind === "cron" && t.kind === "loop") return false
        if (filter.durable_only && t.durable !== true) return false
        return true
      })
    })

  const get: Interface["get"] = (id, opts) => findById(id, opts?.session_id)

  const armLoop: Interface["armLoop"] = (input) =>
    Effect.gen(function* () {
      if (!rt || rt.opts.isKilled()) return null
      const cfg = rt?.cfg ?? DEFAULT_JITTER
      const now = Date.now()
      const existing = LoopState.getLoopState(input.prompt)

      if (existing && now - existing.startedAt >= cfg.recurringMaxAgeMs) {
        // PR #1479 finding #5: clear any prior loop task and the LoopState
        // entry before returning null. Otherwise the previously-armed session
        // task keeps its live nextFireAt, fires once more, the model calls
        // armLoop again, and a fresh LoopState{startedAt:now} is created —
        // the max-age cap is defeated and the loop runs forever.
        const stalePrior = getSessionCronTasks().filter(
          (t) => t.kind === "loop" && t.prompt === input.prompt,
        )
        if (stalePrior.length > 0) {
          removeSessionCronTasks(stalePrior.map((p) => p.id))
          if (rt) for (const p of stalePrior) rt.nextFireAt.delete(p.id)
        }
        LoopState.deleteLoopState(input.prompt)
        rt.opts.onLoopEnded({ reason: "aged_out", prompt: input.prompt })
        return null
      }

      const clamped = Math.max(60, Math.min(3600, input.delay_seconds))
      const wasClamped = clamped !== input.delay_seconds

      const target = new Date(now + clamped * 1000)
      target.setUTCSeconds(0, 0)
      if (target.getTime() <= now) target.setUTCMinutes(target.getUTCMinutes() + 1)

      const prior = getSessionCronTasks().filter(
        (t) => t.kind === "loop" && t.prompt === input.prompt,
      )
      if (prior.length > 0) {
        removeSessionCronTasks(prior.map((p) => p.id))
        if (rt) for (const p of prior) rt.nextFireAt.delete(p.id)
      }

      const id = newId()
      const cron = `${target.getUTCMinutes()} ${target.getUTCHours()} * * *`
      addSessionCronTask({
        id,
        cron,
        prompt: input.prompt,
        createdAt: now,
        kind: "loop",
        recurring: false,
      })

      // PR #1479 finding #4: pin nextFireAt to the requested target so the
      // tick skips first-sight computation. Without this, the tick falls
      // through to oneShotJitteredNextCronRunMs which pulls fires up to 90s
      // early on :00/:30 minute marks — a 60s armLoop landing on a :00 target
      // could fire immediately. The pre-population also covers the secondary
      // case where the cron expression's parse is correct but the early-pull
      // formula is wrong for delay-based scheduling.
      if (rt) rt.nextFireAt.set(id, target.getTime())

      LoopState.setLoopState({
        prompt: input.prompt,
        startedAt: existing?.startedAt ?? now,
        lastScheduledFor: target.getTime(),
        keepaliveStrikes: existing?.keepaliveStrikes ?? 0,
      })

      if (!input.viaKeepalive && rt?.opts.onArmLoop) rt.opts.onArmLoop(input.prompt)

      return {
        scheduledFor: target.getTime(),
        clampedDelaySeconds: clamped,
        wasClamped,
        supersededCount: prior.length,
      }
    })

  const resetKeepaliveStrikes: Interface["resetKeepaliveStrikes"] = (prompt) =>
    Effect.sync(() => LoopState.resetStrikes(prompt))

  const incrementKeepaliveStrikes: Interface["incrementKeepaliveStrikes"] = (prompt) =>
    Effect.sync(() => {
      LoopState.incrementStrikes(prompt)
    })

  const endLoop: Interface["endLoop"] = (prompt, reason, opts) =>
    Effect.gen(function* () {
      const prior = getSessionCronTasks().filter(
        (t) => t.kind === "loop" && t.prompt === prompt,
      )
      if (prior.length > 0) {
        removeSessionCronTasks(prior.map((p) => p.id))
        if (rt) for (const p of prior) rt.nextFireAt.delete(p.id)
      }
      LoopState.deleteLoopState(prompt)
      if (rt) {
        rt.opts.onLoopEnded({
          reason,
          prompt,
          ...(opts?.via_keepalive !== undefined ? { via_keepalive: opts.via_keepalive } : {}),
        })
      }
    })

  const nextFireTime: Interface["nextFireTime"] = () =>
    Effect.sync(() => {
      if (!rt) return null
      const values = [...rt.nextFireAt.values()].filter((v) => Number.isFinite(v))
      if (values.length === 0) return null
      return Math.min(...values)
    })

  const tickOnce: Interface["tickOnce"] = () => tick()

  return {
    start,
    stop,
    add,
    remove,
    rename,
    list,
    get,
    armLoop,
    resetKeepaliveStrikes,
    incrementKeepaliveStrikes,
    endLoop,
    nextFireTime,
    tickOnce,
  }
}

export const layer = Layer.sync(Scheduler, () => Scheduler.of(makeImpl()))

export const defaultLayer = layer
