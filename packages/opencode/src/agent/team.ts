import { Context, Effect, Layer, Ref, Duration } from "effect"
import z from "zod"
import { Agent } from "../agent"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Config } from "../config"
import { Log } from "../util"
import type { AgentRole, AgentTeam } from "./roles"
import { PredefinedRoles, PredefinedTeams } from "./roles"

const log = Log.create({ service: "agent-team" })

/**
 * @deprecated AgentTeam.Service is a placeholder implementation.
 * executeTeamTask returns stub results (100ms delay + "completed successfully").
 * Not used in the main execution flow. Planned for removal or redesign.
 */

export const Event = {
  TeamCreated: BusEvent.define(
    "agent-team.created",
    z.object({
      team_name: z.string(),
      role_count: z.number().int().positive(),
      created_at: z.number().int().positive(),
    }),
  ),

  TaskStarted: BusEvent.define(
    "agent-team.task.started",
    z.object({
      team_name: z.string(),
      role_name: z.string(),
      task_description: z.string(),
      started_at: z.number().int().positive(),
    }),
  ),

  TaskCompleted: BusEvent.define(
    "agent-team.task.completed",
    z.object({
      team_name: z.string(),
      role_name: z.string(),
      status: z.enum(["success", "failure", "timeout"]),
      duration_ms: z.number().int().positive(),
      completed_at: z.number().int().positive(),
    }),
  ),

  CoordinationCompleted: BusEvent.define(
    "agent-team.coordination.completed",
    z.object({
      team_name: z.string(),
      total_duration_ms: z.number().int().positive(),
      roles_completed: z.number().int().positive(),
      roles_failed: z.number().int().positive(),
      completed_at: z.number().int().positive(),
    }),
  ),
}

export interface Interface {
  readonly createTeam: (team: AgentTeam) => Effect.Effect<void>
  readonly getTeam: (team_name: string) => Effect.Effect<AgentTeam | undefined>
  readonly listTeams: () => Effect.Effect<AgentTeam[]>
  readonly executeTeamTask: (input: {
    team_name: string
    task_description: string
    context?: Record<string, string>
  }) => Effect.Effect<{
    team_name: string
    results: Array<{
      role_name: string
      status: "success" | "failure" | "timeout"
      output?: string
      error?: string
      duration_ms: number
    }>
    total_duration_ms: number
    roles_completed: number
    roles_failed: number
  }>
  readonly getRole: (role_name: string) => Effect.Effect<AgentRole | undefined>
  readonly listRoles: () => Effect.Effect<AgentRole[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentTeam") {}

export const layer: Layer.Layer<Service, never, Agent.Service | Bus.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service

    const teams = yield* Ref.make(new Map<string, AgentTeam>())

    const roles = yield* Ref.make(new Map<string, AgentRole>(
      Object.entries(PredefinedRoles).map(([key, value]) => [key, value]),
    ))

    const createTeam = Effect.fn("AgentTeam.createTeam")(function* (team: AgentTeam) {
      yield* Ref.update(teams, (map) => {
        const newMap = new Map(map)
        newMap.set(team.name, team)
        return newMap
      })

      for (const role of team.roles) {
        yield* Ref.update(roles, (map) => {
          const newMap = new Map(map)
          newMap.set(role.name, role)
          return newMap
        })
      }

      yield* bus.publish(Event.TeamCreated, {
        team_name: team.name,
        role_count: team.roles.length,
        created_at: Date.now(),
      })

      log.info("created agent team", {
        team_name: team.name,
        role_count: team.roles.length,
      })
    })

    const getTeam = Effect.fn("AgentTeam.getTeam")(function* (team_name: string) {
      const currentTeams = yield* Ref.get(teams)
      return currentTeams.get(team_name)
    })

    const listTeams = Effect.fn("AgentTeam.listTeams")(function* () {
      const currentTeams = yield* Ref.get(teams)
      return Array.from(currentTeams.values())
    })

    const executeTeamTask = Effect.fn("AgentTeam.executeTeamTask")(function* (input: {
      team_name: string
      task_description: string
      context?: Record<string, string>
    }) {
      const startTime = Date.now()

      const team = yield* getTeam(input.team_name)
      if (!team) {
        throw new Error(`Team ${input.team_name} not found`)
      }

      log.info("executing team task", {
        team_name: input.team_name,
        task_description: input.task_description,
        role_count: team.roles.length,
      })

      const results: Array<{
        role_name: string
        status: "success" | "failure" | "timeout"
        output?: string
        error?: string
        duration_ms: number
      }> = []

      if (team.workflow?.mode === "parallel") {
        const parallelResults = yield* Effect.forEach(
          team.roles,
          (role) =>
            Effect.gen(function* () {
              const roleStartTime = Date.now()

              yield* bus.publish(Event.TaskStarted, {
                team_name: input.team_name,
                role_name: role.name,
                task_description: input.task_description,
                started_at: roleStartTime,
              })

              try {
                yield* Effect.sleep(Duration.millis(100))

                const duration = Date.now() - roleStartTime

                yield* bus.publish(Event.TaskCompleted, {
                  team_name: input.team_name,
                  role_name: role.name,
                  status: "success",
                  duration_ms: duration,
                  completed_at: Date.now(),
                })

                return {
                  role_name: role.name,
                  status: "success" as const,
                  output: `Role ${role.name} completed successfully`,
                  duration_ms: duration,
                }
              } catch (error) {
                const duration = Date.now() - roleStartTime
                const errorMessage = error instanceof Error ? error.message : String(error)

                yield* bus.publish(Event.TaskCompleted, {
                  team_name: input.team_name,
                  role_name: role.name,
                  status: "failure",
                  duration_ms: duration,
                  completed_at: Date.now(),
                })

                return {
                  role_name: role.name,
                  status: "failure" as const,
                  error: errorMessage,
                  duration_ms: duration,
                }
              }
            }),
          { concurrency: "unbounded" },
        )
        results.push(...parallelResults)
      } else {
        for (const role of team.roles) {
          const roleStartTime = Date.now()

          yield* bus.publish(Event.TaskStarted, {
            team_name: input.team_name,
            role_name: role.name,
            task_description: input.task_description,
            started_at: roleStartTime,
          })

          try {
            yield* Effect.sleep(Duration.millis(100))

            const duration = Date.now() - roleStartTime

            yield* bus.publish(Event.TaskCompleted, {
              team_name: input.team_name,
              role_name: role.name,
              status: "success",
              duration_ms: duration,
              completed_at: Date.now(),
            })

            results.push({
              role_name: role.name,
              status: "success",
              output: `Role ${role.name} completed successfully`,
              duration_ms: duration,
            })
          } catch (error) {
            const duration = Date.now() - roleStartTime
            const errorMessage = error instanceof Error ? error.message : String(error)

            yield* bus.publish(Event.TaskCompleted, {
              team_name: input.team_name,
              role_name: role.name,
              status: "failure",
              duration_ms: duration,
              completed_at: Date.now(),
            })

            results.push({
              role_name: role.name,
              status: "failure",
              error: errorMessage,
              duration_ms: duration,
            })

            break
          }
        }
      }

      const totalDuration = Date.now() - startTime
      const rolesCompleted = results.filter((r) => r.status === "success").length
      const rolesFailed = results.filter((r) => r.status === "failure").length

      yield* bus.publish(Event.CoordinationCompleted, {
        team_name: input.team_name,
        total_duration_ms: totalDuration,
        roles_completed: rolesCompleted,
        roles_failed: rolesFailed,
        completed_at: Date.now(),
      })

      log.info("team task completed", {
        team_name: input.team_name,
        total_duration: totalDuration,
        roles_completed: rolesCompleted,
        roles_failed: rolesFailed,
      })

      return {
        team_name: input.team_name,
        results,
        total_duration_ms: totalDuration,
        roles_completed: rolesCompleted,
        roles_failed: rolesFailed,
      }
    })

    const getRole = Effect.fn("AgentTeam.getRole")(function* (role_name: string) {
      const currentRoles = yield* Ref.get(roles)
      return currentRoles.get(role_name)
    })

    const listRoles = Effect.fn("AgentTeam.listRoles")(function* () {
      const currentRoles = yield* Ref.get(roles)
      return Array.from(currentRoles.values())
    })

    for (const team of Object.values(PredefinedTeams)) {
      yield* createTeam(team)
    }

    return Service.of({
      createTeam,
      getTeam,
      listTeams,
      executeTeamTask,
      getRole,
      listRoles,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
)

export * as AgentTeam from "."
