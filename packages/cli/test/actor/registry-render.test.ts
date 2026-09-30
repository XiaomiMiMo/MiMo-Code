import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const testLayer = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

async function withRegistry(
  directory: string,
  fn: (rt: ManagedRuntime.ManagedRuntime<Session.Service | ActorRegistry.Service, never>) => Promise<void>,
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
      }
    },
  })
}

describe("ActorRegistry.renderForAgent", () => {
  test("returns empty string when no active tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
      const result = await rt.runPromise(
        ActorRegistry.Service.use((svc) => svc.renderForAgent(parent.id)),
      )
      expect(result).toBe("")
    })
  })

  test("renders active actors with description and agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
      const actorId = SessionID.descending()

      await rt.runPromise(
        ActorRegistry.Service.use((svc) =>
          svc.register({
            sessionID: parent.id,
            actorID: actorId,
            mode: "subagent",
            agent: "explore",
            description: "Research auth patterns",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          }),
        ),
      )
      await rt.runPromise(ActorRegistry.Service.use((svc) => svc.updateStatus(parent.id, actorId, { status: "running" })))

      const result = await rt.runPromise(
        ActorRegistry.Service.use((svc) => svc.renderForAgent(parent.id)),
      )

      expect(result).toContain("## Active Actors")
      expect(result).toContain("Interact via the `actor` tool")
      expect(result).toContain(`actor_id: ${actorId}`)
      expect(result).not.toContain("## Active Background Tasks")
      expect(result).not.toContain("task_id:")
      expect(result).not.toContain("`task` tool")
      expect(result).toContain("description: Research auth patterns")
      expect(result).toContain("agent: explore")
    })
  })

  test("excludes completed tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
      const taskId = SessionID.descending()

      await rt.runPromise(
        ActorRegistry.Service.use((svc) =>
          svc.register({
            sessionID: parent.id,
            actorID: taskId,
            mode: "subagent",
            agent: "general",
            description: "Finished work",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          }),
        ),
      )
      await rt.runPromise(ActorRegistry.Service.use((svc) => svc.updateStatus(parent.id, taskId, { status: "idle", lastOutcome: "success" })))

      const result = await rt.runPromise(
        ActorRegistry.Service.use((svc) => svc.renderForAgent(parent.id)),
      )

      expect(result).toBe("")
    })
  })
})
