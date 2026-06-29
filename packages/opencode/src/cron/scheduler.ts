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
  readonly remove: (id: string) => Effect.Effect<boolean>
  readonly rename: (id: string, prompt: string) => Effect.Effect<boolean>
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

      const tasks = yield* allTasks
      const now = Date.now()

      for (const task of tasks) {
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

        rt.opts.onFire(task)

        if (task.recurring === true && !aged) {
          rt.nextFireAt.set(task.id, computeNextFireFor(task, now, rt.cfg))
          if (task.durable === true) {
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
        if (task.durable === true) {
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

  const removeBy = (id: string) =>
    Effect.gen(function* () {
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

  const remove: Interface["remove"] = (id) => removeBy(id)

  const rename: Interface["rename"] = (id, prompt) =>
    Effect.gen(function* () {
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

  const get: Interface["get"] = (id, _opts) =>
    Effect.gen(function* () {
      const all = yield* list({})
      return all.find((t) => t.id === id) ?? null
    })

  const armLoop: Interface["armLoop"] = (input) =>
    Effect.gen(function* () {
      if (!rt || rt.opts.isKilled()) return null
      const cfg = rt?.cfg ?? DEFAULT_JITTER
      const now = Date.now()
      const existing = LoopState.getLoopState(input.prompt)

      if (existing && now - existing.startedAt >= cfg.recurringMaxAgeMs) {
        LoopState.setLoopState({ ...existing, agedOut: true })
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

      LoopState.setLoopState({
        prompt: input.prompt,
        startedAt: existing?.startedAt ?? now,
        lastScheduledFor: target.getTime(),
        keepaliveStrikes: existing?.keepaliveStrikes ?? 0,
      })

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
  }
}

export const layer = Layer.sync(Scheduler, () => Scheduler.of(makeImpl()))

export const defaultLayer = layer
