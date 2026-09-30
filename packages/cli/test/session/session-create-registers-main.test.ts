import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

// Session.defaultLayer now provides ActorRegistry transitively
const testLayer = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

async function withServices(
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

describe("Session.create registers main actor (F50)", () => {
  test("creating a session auto-registers (sessionID, 'main') in ActorRegistry", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))

      const row = await rt.runPromise(
        ActorRegistry.Service.use((svc) => svc.get(session.id, "main")),
      )

      expect(row).toBeDefined()
      expect(row!.actorID).toBe("main")
      expect(row!.mode).toBe("main")
      expect(row!.agent).toBe("main")
      expect(row!.description).toBe("main agent")
      expect(row!.contextMode).toBe("full")
      expect(row!.background).toBe(false)
      expect(row!.status).toBe("pending")
    })
  })

  test("main actor row appears in listBySession", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))

      const actors = await rt.runPromise(
        ActorRegistry.Service.use((svc) => svc.listBySession(session.id)),
      )

      const main = actors.find((a) => a.actorID === "main")
      expect(main).toBeDefined()
      expect(main!.mode).toBe("main")
    })
  })
})
