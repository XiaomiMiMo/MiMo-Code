import { Context, Effect, Layer, Ref, Duration } from "effect"
import z from "zod"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Config } from "../config"
import { Skill } from "../skill"
import { Log } from "../util"
import type { AutomationTask, WorkItem, AutomationResult } from "./schema"

const log = Log.create({ service: "automation-scheduler" })

export const Event = {
  TaskStarted: BusEvent.define(
    "automation.task.started",
    z.object({
      task_id: z.string(),
      task_name: z.string(),
      started_at: z.number().int().positive(),
    }),
  ),

  TaskCompleted: BusEvent.define(
    "automation.task.completed",
    z.object({
      task_id: z.string(),
      task_name: z.string(),
      status: z.enum(["success", "failure", "timeout", "skipped"]),
      duration_ms: z.number().int().positive(),
      completed_at: z.number().int().positive(),
    }),
  ),

  WorkDiscovered: BusEvent.define(
    "automation.work.discovered",
    z.object({
      work_item: z.object({
        id: z.string(),
        type: z.enum(["ci_failure", "issue", "commit", "custom"]),
        source: z.string(),
        title: z.string(),
        priority: z.enum(["low", "medium", "high"]),
      }),
      discovered_at: z.number().int().positive(),
    }),
  ),

  SchedulerStateChanged: BusEvent.define(
    "automation.scheduler.state",
    z.object({
      running: z.boolean(),
      active_tasks: z.number().int().min(0),
      pending_work: z.number().int().min(0),
      last_cycle_at: z.number().int().positive().optional(),
    }),
  ),
}

export interface Interface {
  readonly register: (task: AutomationTask) => Effect.Effect<void>
  readonly unregister: (task_id: string) => Effect.Effect<void>
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly trigger: (task_id: string, work_item?: WorkItem) => Effect.Effect<AutomationResult>
  readonly status: () => Effect.Effect<{
    running: boolean
    active_tasks: number
    pending_work: number
    registered_tasks: AutomationTask[]
  }>
  readonly enqueueWork: (work_item: WorkItem) => Effect.Effect<void>
  readonly pendingWork: () => Effect.Effect<WorkItem[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AutomationScheduler") {}

function parseSchedule(schedule: string): number | null {
  const intervalMatch = schedule.match(/^(\d+)(s|m|h)$/)
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1])
    const unit = intervalMatch[2]
    switch (unit) {
      case "s":
        return value * 1000
      case "m":
        return value * 60 * 1000
      case "h":
        return value * 60 * 60 * 1000
    }
  }

  const cronParts = schedule.split(" ")
  if (cronParts.length === 5) {
    return 60 * 1000
  }

  return null
}

export const layer: Layer.Layer<Service, never, Bus.Service | Config.Service | Skill.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const skill = yield* Skill.Service

    const state = yield* Ref.make({
      running: false,
      tasks: new Map<string, AutomationTask>(),
      pendingWork: [] as WorkItem[],
      activeExecutions: new Set<string>(),
      intervals: new Map<string, ReturnType<typeof setInterval>>(),
    })

    const executeTask = Effect.fn("AutomationScheduler.executeTask")(function* (
      task: AutomationTask,
      work_item?: WorkItem,
    ) {
      const startTime = Date.now()

      yield* bus.publish(Event.TaskStarted, {
        task_id: task.id,
        task_name: task.name,
        started_at: startTime,
      })

      log.info("executing automation task", {
        task_id: task.id,
        task_name: task.name,
        skill: task.skill,
        work_item_id: work_item?.id,
      })

      yield* Ref.update(state, (s) => ({
        ...s,
        activeExecutions: new Set([...s.activeExecutions, task.id]),
      }))

      try {
        // 查找技能是否可用
        const skillInfo = yield* skill.get(task.skill)
        if (!skillInfo) {
          throw new Error(`Skill "${task.skill}" not found for task "${task.name}"`)
        }

        log.info("skill found, executing", {
          skill: task.skill,
          location: skillInfo.location,
        })

        // 模拟技能执行（此处为未来实际执行预留接口）
        yield* Effect.sleep(Duration.millis(100))

        const duration = Date.now() - startTime
        const result: AutomationResult = {
          task_id: task.id,
          work_item_id: work_item?.id,
          status: "success",
          output: `Task "${task.name}" completed. Skill: ${task.skill}`,
          duration_ms: duration,
          executed_at: Date.now(),
        }

        yield* bus.publish(Event.TaskCompleted, {
          task_id: task.id,
          task_name: task.name,
          status: "success",
          duration_ms: duration,
          completed_at: Date.now(),
        })

        log.info("automation task completed", {
          task_id: task.id,
          skill: task.skill,
          duration,
        })

        return result
      } catch (error) {
        const duration = Date.now() - startTime
        const errorMessage = error instanceof Error ? error.message : String(error)

        yield* bus.publish(Event.TaskCompleted, {
          task_id: task.id,
          task_name: task.name,
          status: "failure",
          duration_ms: duration,
          completed_at: Date.now(),
        })

        log.error("automation task failed", {
          task_id: task.id,
          skill: task.skill,
          error: errorMessage,
          duration,
        })

        return {
          task_id: task.id,
          work_item_id: work_item?.id,
          status: "failure" as const,
          error: errorMessage,
          duration_ms: duration,
          executed_at: Date.now(),
        }
      } finally {
        yield* Ref.update(state, (s) => {
          const newExecutions = new Set(s.activeExecutions)
          newExecutions.delete(task.id)
          return { ...s, activeExecutions: newExecutions }
        })
      }
    })

    const register = Effect.fn("AutomationScheduler.register")(function* (task: AutomationTask) {
      yield* Ref.update(state, (s) => {
        const newTasks = new Map(s.tasks)
        newTasks.set(task.id, task)
        return { ...s, tasks: newTasks }
      })

      log.info("registered automation task", {
        task_id: task.id,
        task_name: task.name,
        schedule: task.schedule,
        skill: task.skill,
      })

      const currentState = yield* Ref.get(state)
      if (currentState.running && task.enabled) {
        const interval = parseSchedule(task.schedule)
        if (interval) {
          const timer = setInterval(() => {
            Effect.runFork(executeTask(task))
          }, interval)

          yield* Ref.update(state, (s) => {
            const newIntervals = new Map(s.intervals)
            newIntervals.set(task.id, timer)
            return { ...s, intervals: newIntervals }
          })
        }
      }
    })

    const unregister = Effect.fn("AutomationScheduler.unregister")(function* (task_id: string) {
      const currentState = yield* Ref.get(state)
      const timer = currentState.intervals.get(task_id)
      if (timer) {
        clearInterval(timer)
        yield* Ref.update(state, (s) => {
          const newIntervals = new Map(s.intervals)
          newIntervals.delete(task_id)
          return { ...s, intervals: newIntervals }
        })
      }

      yield* Ref.update(state, (s) => {
        const newTasks = new Map(s.tasks)
        newTasks.delete(task_id)
        return { ...s, tasks: newTasks }
      })

      log.info("unregistered automation task", { task_id })
    })

    const start = Effect.fn("AutomationScheduler.start")(function* () {
      const currentState = yield* Ref.get(state)
      if (currentState.running) {
        log.warn("scheduler already running")
        return
      }

      yield* Ref.update(state, (s) => ({ ...s, running: true }))

      for (const task of currentState.tasks.values()) {
        if (task.enabled) {
          const interval = parseSchedule(task.schedule)
          if (interval) {
            const timer = setInterval(() => {
              Effect.runFork(executeTask(task))
            }, interval)

            yield* Ref.update(state, (s) => {
              const newIntervals = new Map(s.intervals)
              newIntervals.set(task.id, timer)
              return { ...s, intervals: newIntervals }
            })
          }
        }
      }

      yield* bus.publish(Event.SchedulerStateChanged, {
        running: true,
        active_tasks: currentState.tasks.size,
        pending_work: currentState.pendingWork.length,
        last_cycle_at: Date.now(),
      })

      log.info("automation scheduler started", {
        task_count: currentState.tasks.size,
      })
    })

    const stop = Effect.fn("AutomationScheduler.stop")(function* () {
      const currentState = yield* Ref.get(state)

      for (const timer of currentState.intervals.values()) {
        clearInterval(timer)
      }

      yield* Ref.update(state, (s) => ({
        ...s,
        running: false,
        intervals: new Map(),
      }))

      yield* bus.publish(Event.SchedulerStateChanged, {
        running: false,
        active_tasks: 0,
        pending_work: currentState.pendingWork.length,
        last_cycle_at: Date.now(),
      })

      log.info("automation scheduler stopped")
    })

    const trigger = Effect.fn("AutomationScheduler.trigger")(function* (
      task_id: string,
      work_item?: WorkItem,
    ) {
      const currentState = yield* Ref.get(state)
      const task = currentState.tasks.get(task_id)
      if (!task) {
        throw new Error(`Task ${task_id} not found`)
      }

      return yield* executeTask(task, work_item)
    })

    const status = Effect.fn("AutomationScheduler.status")(function* () {
      const currentState = yield* Ref.get(state)
      return {
        running: currentState.running,
        active_tasks: currentState.activeExecutions.size,
        pending_work: currentState.pendingWork.length,
        registered_tasks: Array.from(currentState.tasks.values()),
      }
    })

    const enqueueWork = Effect.fn("AutomationScheduler.enqueueWork")(function* (work_item: WorkItem) {
      yield* Ref.update(state, (s) => ({
        ...s,
        pendingWork: [...s.pendingWork, work_item],
      }))

      yield* bus.publish(Event.WorkDiscovered, {
        work_item: {
          id: work_item.id,
          type: work_item.type,
          source: work_item.source,
          title: work_item.title,
          priority: work_item.priority,
        },
        discovered_at: work_item.discovered_at,
      })

      log.info("work item enqueued", {
        work_item_id: work_item.id,
        type: work_item.type,
        priority: work_item.priority,
      })
    })

    const pendingWork = Effect.fn("AutomationScheduler.pendingWork")(function* () {
      const currentState = yield* Ref.get(state)
      return currentState.pendingWork
    })

    // 从配置加载自动化任务
    const cfg = yield* config.get()
    const autoCfg = cfg.automation
    if (autoCfg?.tasks) {
      for (const taskDef of autoCfg.tasks) {
        const task: AutomationTask = {
          id: taskDef.id,
          name: taskDef.name,
          description: taskDef.description,
          schedule: taskDef.schedule,
          skill: taskDef.skill,
          enabled: taskDef.enabled ?? true,
          priority: taskDef.priority ?? "medium",
          timeout: taskDef.timeout,
          retries: taskDef.retries ?? 0,
        }
        yield* register(task)
      }

      // 如果配置启用，自动启动调度器
      if (autoCfg.enabled) {
        yield* start()
      }
    }

    return Service.of({
      register,
      unregister,
      start,
      stop,
      trigger,
      status,
      enqueueWork,
      pendingWork,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(Skill.defaultLayer),
)

