import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import { provideInstance } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { tmpdir } from "../fixture/fixture"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("orchestrator agent is a native primary with scheduler toolset", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const orchestrator = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(orchestrator).toBeDefined()
      expect(orchestrator?.name).toBe("orchestrator")
      expect(orchestrator?.mode).toBe("primary")
      expect(orchestrator?.native).toBe(true)
      expect(orchestrator?.toolAllowlist).toContain("session")
      expect(orchestrator?.toolAllowlist).not.toContain("edit")
      expect(orchestrator?.toolAllowlist).not.toContain("write")
      expect(orchestrator?.toolAllowlist).not.toContain("bash")
    },
  })
})
