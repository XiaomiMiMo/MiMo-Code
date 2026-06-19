import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

afterEach(async () => {
  await Instance.disposeAll()
})

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)),
  )
}

function evalPerm(agent: Agent.Info, permission: string): Permission.Action {
  return Permission.evaluate(permission, "*", agent.permission).action
}

describe("Agent config optimizations", () => {
  test("build agent has steps: 100", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const build = agents.find((a) => a.name === "build")
        expect(build).toBeDefined()
        expect(build!.steps).toBe(100)
      },
    })
  })

  test("plan agent has steps: 30", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const plan = agents.find((a) => a.name === "plan")
        expect(plan).toBeDefined()
        expect(plan!.steps).toBe(30)
      },
    })
  })

  test("compose agent has steps: 150", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const compose = agents.find((a) => a.name === "compose")
        expect(compose).toBeDefined()
        expect(compose!.steps).toBe(150)
      },
    })
  })

  test("plan agent has toolAllowlist", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const plan = agents.find((a) => a.name === "plan")
        expect(plan).toBeDefined()
        expect(plan!.toolAllowlist).toBeDefined()
        expect(plan!.toolAllowlist).toContain("read")
        expect(plan!.toolAllowlist).toContain("plan_exit")
        expect(plan!.toolAllowlist).toContain("question")
        expect(plan!.toolAllowlist).toContain("actor")
        expect(plan!.toolAllowlist).not.toContain("bash")
      },
    })
  })

  test("compose agent has toolAllowlist", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const compose = agents.find((a) => a.name === "compose")
        expect(compose).toBeDefined()
        expect(compose!.toolAllowlist).toBeDefined()
        expect(compose!.toolAllowlist).toContain("skill")
        expect(compose!.toolAllowlist).toContain("question")
        expect(compose!.toolAllowlist).toContain("actor")
        expect(compose!.toolAllowlist).not.toContain("bash")
      },
    })
  })

  test("plan agent denies edit via permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const plan = agents.find((a) => a.name === "plan")
        expect(plan).toBeDefined()
        expect(evalPerm(plan!, "edit")).toBe("deny")
      },
    })
  })

  test("plan agent allows read via permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const plan = agents.find((a) => a.name === "plan")
        expect(plan).toBeDefined()
        expect(evalPerm(plan!, "read")).toBe("allow")
      },
    })
  })

  test("compose agent denies bash via permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const compose = agents.find((a) => a.name === "compose")
        expect(compose).toBeDefined()
        expect(evalPerm(compose!, "bash")).toBe("deny")
      },
    })
  })

  test("explore agent denies bash via permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const explore = agents.find((a) => a.name === "explore")
        expect(explore).toBeDefined()
        expect(evalPerm(explore!, "bash")).toBe("deny")
      },
    })
  })

  test("explore agent allows read", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const explore = agents.find((a) => a.name === "explore")
        expect(explore).toBeDefined()
        expect(evalPerm(explore!, "read")).toBe("allow")
      },
    })
  })
})
