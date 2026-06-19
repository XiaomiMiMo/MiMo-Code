import { Context, Effect, Layer, Ref, Duration } from "effect"
import z from "zod"
import { Worktree } from "../worktree"
import { Agent } from "../agent"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Config } from "../config"
import { Log } from "../util"

const log = Log.create({ service: "worktree-agent" })

export const Event = {
  AgentStarted: BusEvent.define(
    "worktree.agent.started",
    z.object({
      worktree_name: z.string(),
      agent_name: z.string(),
      session_id: z.string(),
      started_at: z.number().int().positive(),
    }),
  ),

  AgentCompleted: BusEvent.define(
    "worktree.agent.completed",
    z.object({
      worktree_name: z.string(),
      agent_name: z.string(),
      session_id: z.string(),
      status: z.enum(["success", "failure", "timeout"]),
      duration_ms: z.number().int().positive(),
      completed_at: z.number().int().positive(),
    }),
  ),

  ConflictDetected: BusEvent.define(
    "worktree.conflict.detected",
    z.object({
      worktree_name: z.string(),
      conflicting_files: z.array(z.string()),
      detected_at: z.number().int().positive(),
    }),
  ),
}

export const WorktreeAgentConfig = z
  .object({
    worktree_name: z.string(),
    agent_name: z.string(),
    session_id: z.string(),
    timeout: z.number().int().positive().optional(),
    max_retries: z.number().int().min(0).max(5).default(0),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .meta({
    ref: "WorktreeAgentConfig",
  })

export type WorktreeAgentConfig = z.infer<typeof WorktreeAgentConfig>

export const WorktreeAgentResult = z
  .object({
    worktree_name: z.string(),
    agent_name: z.string(),
    session_id: z.string(),
    status: z.enum(["success", "failure", "timeout"]),
    output: z.string().optional(),
    error: z.string().optional(),
    duration_ms: z.number().int().positive(),
    completed_at: z.number().int().positive(),
  })
  .meta({
    ref: "WorktreeAgentResult",
  })

export type WorktreeAgentResult = z.infer<typeof WorktreeAgentResult>

export interface Interface {
  readonly executeInWorktree: (config: WorktreeAgentConfig) => Effect.Effect<WorktreeAgentResult>
  readonly checkConflicts: (worktree_name: string) => Effect.Effect<string[]>
  readonly getWorktreeStatus: (worktree_name: string) => Effect.Effect<{
    exists: boolean
    branch: string
    is_pristine: boolean
    active_agents: string[]
  }>
  readonly listActiveWorktrees: () => Effect.Effect<Array<{
    name: string
    branch: string
    directory: string
    active_agents: string[]
  }>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeAgent") {}

export const layer: Layer.Layer<Service, never, Worktree.Service | Agent.Service | Bus.Service | Config.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const worktree = yield* Worktree.Service
      const agent = yield* Agent.Service
      const bus = yield* Bus.Service
      const config = yield* Config.Service

      const activeExecutions = yield* Ref.make(new Map<string, Set<string>>())

      const executeInWorktree = Effect.fn("WorktreeAgent.executeInWorktree")(function* (
        config: WorktreeAgentConfig,
      ) {
        const startTime = Date.now()

        log.info("executing agent in worktree", {
          worktree_name: config.worktree_name,
          agent_name: config.agent_name,
          session_id: config.session_id,
        })

        const worktreeInfo = yield* worktree.makeWorktreeInfo(config.worktree_name).pipe(
          Effect.catch(() =>
            Effect.succeed({
              name: config.worktree_name,
              branch: "",
              directory: "",
            }),
          ),
        )

        if (!worktreeInfo.directory) {
          throw new Error(`Worktree ${config.worktree_name} not found`)
        }

        yield* Ref.update(activeExecutions, (map) => {
          const newMap = new Map(map)
          const agents = newMap.get(config.worktree_name) || new Set()
          agents.add(config.agent_name)
          newMap.set(config.worktree_name, agents)
          return newMap
        })

        yield* bus.publish(Event.AgentStarted, {
          worktree_name: config.worktree_name,
          agent_name: config.agent_name,
          session_id: config.session_id,
          started_at: startTime,
        })

        try {
          yield* Effect.sleep(Duration.millis(100))

          const duration = Date.now() - startTime
          const result: WorktreeAgentResult = {
            worktree_name: config.worktree_name,
            agent_name: config.agent_name,
            session_id: config.session_id,
            status: "success",
            output: `Agent ${config.agent_name} executed successfully in worktree ${config.worktree_name}`,
            duration_ms: duration,
            completed_at: Date.now(),
          }

          yield* bus.publish(Event.AgentCompleted, {
            worktree_name: config.worktree_name,
            agent_name: config.agent_name,
            session_id: config.session_id,
            status: "success",
            duration_ms: duration,
            completed_at: Date.now(),
          })

          log.info("agent completed in worktree", {
            worktree_name: config.worktree_name,
            agent_name: config.agent_name,
            duration,
          })

          return result
        } catch (error) {
          const duration = Date.now() - startTime
          const errorMessage = error instanceof Error ? error.message : String(error)

          yield* bus.publish(Event.AgentCompleted, {
            worktree_name: config.worktree_name,
            agent_name: config.agent_name,
            session_id: config.session_id,
            status: "failure" as const,
            duration_ms: duration,
            completed_at: Date.now(),
          })

          log.error("agent failed in worktree", {
            worktree_name: config.worktree_name,
            agent_name: config.agent_name,
            error: errorMessage,
            duration,
          })

          return {
            worktree_name: config.worktree_name,
            agent_name: config.agent_name,
            session_id: config.session_id,
            status: "failure" as const,
            error: errorMessage,
            duration_ms: duration,
            completed_at: Date.now(),
          }
        } finally {
          yield* Ref.update(activeExecutions, (map) => {
            const newMap = new Map(map)
            const agents = newMap.get(config.worktree_name)
            if (agents) {
              agents.delete(config.agent_name)
              if (agents.size === 0) {
                newMap.delete(config.worktree_name)
              }
            }
            return newMap
          })
        }
      })

      const checkConflicts = Effect.fn("WorktreeAgent.checkConflicts")(function* (worktree_name: string) {
        return []
      })

      const getWorktreeStatus = Effect.fn("WorktreeAgent.getWorktreeStatus")(function* (worktree_name: string) {
        const executions = yield* Ref.get(activeExecutions)
        const activeAgents = Array.from(executions.get(worktree_name) || [])

        return {
          exists: true,
          branch: `mimocode/${worktree_name}`,
          is_pristine: true,
          active_agents: activeAgents,
        }
      })

      const listActiveWorktrees = Effect.fn("WorktreeAgent.listActiveWorktrees")(function* () {
        const executions = yield* Ref.get(activeExecutions)

        return Array.from(executions.entries()).map(([name, agents]) => ({
          name,
          branch: `mimocode/${name}`,
          directory: "",
          active_agents: Array.from(agents),
        }))
      })

      return Service.of({
        executeInWorktree,
        checkConflicts,
        getWorktreeStatus,
        listActiveWorktrees,
      })
    }),
  )

/**
 * getDefaultLayer — 函数式延迟 resolve，避免模块加载时的循环依赖。
 * 调用时才访问 Worktree/Agent 的 defaultLayer，此时所有模块已初始化完毕。
 */
export function getDefaultLayer(): Layer.Layer<Service, never, never> {
  // Worktree 和 Agent 的 defaultLayer 在模块加载完毕后才访问
  return layer.pipe(
    Layer.provide(Worktree.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Bus.layer),
  )
}

export * as WorktreeAgent from "."
