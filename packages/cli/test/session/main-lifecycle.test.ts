import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

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

describe("Session.create main lifecycle (Plan 1 / Task 6)", () => {
  test("main actor lifecycle = persistent on session create", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))

      const entry = await rt.runPromise(
        ActorRegistry.Service.use((reg) => reg.get(session.id, "main")),
      )

      expect(entry).toBeDefined()
      expect(entry!.lifecycle).toBe("persistent")
      expect(entry!.mode).toBe("main")
      expect(entry!.status).toBe("pending")
      expect(entry!.lastOutcome).toBeUndefined()
    })
  })
})
