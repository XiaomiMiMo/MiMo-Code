import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { provideInstance, tmpdir } from "../fixture/fixture"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("plan agent keeps write restrictions even when global permissions allow writes", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        edit: "allow",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      const permission = Agent.runtimePermission(plan)

      expect(Permission.evaluate("edit", "src/file.ts", plan.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "src/file.ts", permission).action).toBe("deny")
      expect(Permission.evaluate("edit", ".mimocode/plans/foo.md", permission).action).toBe("allow")
    },
  })
})

test("plan runtime permission keeps session allow rules from overriding write restrictions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      const permission = Agent.runtimePermission(plan, [
        { permission: "edit", pattern: "*", action: "allow" },
      ])

      expect(Permission.evaluate("edit", "src/file.ts", permission).action).toBe("deny")
      expect(Permission.evaluate("edit", ".mimocode/plans/foo.md", permission).action).toBe("allow")
    },
  })
})
