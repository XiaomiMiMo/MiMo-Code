import { Effect, Layer, Context } from "effect"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect"
import { SessionID } from "@/session/schema"
import type { TeamMember } from "./schema"
import * as Events from "./events"
import { Log } from "@/util"
import * as fs from "fs/promises"
import path from "path"

const log = Log.create({ service: "team" })

export interface Interface {
  readonly create: (teamID: string, creatorSessionID: SessionID) => Effect.Effect<void>
  readonly addMember: (
    teamID: string,
    sessionID: SessionID,
    agent: string,
    role: string,
  ) => Effect.Effect<void>
  readonly removeMember: (teamID: string, sessionID: SessionID) => Effect.Effect<void>
  readonly getMembers: (teamID: string) => Effect.Effect<TeamMember[]>
  readonly teamDir: (teamID: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Team") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const resolveTeamDir = (teamID: string) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        return path.join(ctx.directory, ".mimocode", "teams", teamID)
      })

    const membersFilePath = (teamID: string) =>
      Effect.map(resolveTeamDir(teamID), (dir) => path.join(dir, "members.json"))

    const readMembersFile = (teamID: string) =>
      Effect.gen(function* () {
        const filePath = yield* membersFilePath(teamID)
        return yield* Effect.promise(async () => {
          try {
            const raw = await fs.readFile(filePath, "utf-8")
            return JSON.parse(raw) as TeamMember[]
          } catch {
            return [] as TeamMember[]
          }
        })
      })

    const writeMembersFile = (teamID: string, members: TeamMember[]) =>
      Effect.gen(function* () {
        const filePath = yield* membersFilePath(teamID)
        yield* Effect.promise(() => fs.writeFile(filePath, JSON.stringify(members, null, 2)))
      })

    const create = Effect.fn("Team.create")(function* (
      teamID: string,
      creatorSessionID: SessionID,
    ) {
      const dir = yield* resolveTeamDir(teamID)
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "members.json"), "[]"))
      log.info("team created", { teamID })
      yield* bus.publish(Events.TeamCreated, { teamID, creatorSessionID })
    })

    const addMember = Effect.fn("Team.addMember")(function* (
      teamID: string,
      sessionID: SessionID,
      agent: string,
      role: string,
    ) {
      const members = yield* readMembersFile(teamID)
      const existing = members.find((m) => m.sessionID === sessionID)
      if (!existing) {
        members.push({ sessionID, agent, role, joinedAt: Date.now() })
        yield* writeMembersFile(teamID, members)
        log.info("team member added", { teamID, sessionID, agent, role })
      }
    })

    const removeMember = Effect.fn("Team.removeMember")(function* (
      teamID: string,
      sessionID: SessionID,
    ) {
      const members = yield* readMembersFile(teamID)
      const filtered = members.filter((m) => m.sessionID !== sessionID)
      if (filtered.length !== members.length) {
        yield* writeMembersFile(teamID, filtered)
        log.info("team member removed", { teamID, sessionID })
      }
    })

    const getMembers = Effect.fn("Team.getMembers")(function* (teamID: string) {
      return yield* readMembersFile(teamID)
    })

    const teamDir = Effect.fn("Team.teamDir")(function* (teamID: string) {
      return yield* resolveTeamDir(teamID)
    })

    return Service.of({ create, addMember, removeMember, getMembers, teamDir })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.defaultLayer))

export * as Team from "./index"
