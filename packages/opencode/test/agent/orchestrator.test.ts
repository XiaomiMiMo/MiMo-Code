import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import { provideInstance } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { tmpdir } from "../fixture/fixture"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("orchestrator agent is a native, full-capability primary (no tool restriction)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const orchestrator = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(orchestrator).toBeDefined()
      expect(orchestrator?.name).toBe("orchestrator")
      expect(orchestrator?.mode).toBe("primary")
      expect(orchestrator?.native).toBe(true)
      // Full-capability: NOT restricted by a toolAllowlist (it gets the same
      // tools as build, plus the orchestrator-only `session` tool gated by name).
      expect(orchestrator?.toolAllowlist).toBeUndefined()
      // First-class delegator identity: the orchestrator carries its OWN system
      // prompt (agent.prompt), which REPLACES the base coding prompt — it is not
      // a system-reminder injected into the user message.
      expect(orchestrator?.prompt).toBe(PROMPT_ORCHESTRATOR)
      expect(orchestrator?.prompt).toMatch(/leader|manager|coordinat/i)
    },
  })
})
