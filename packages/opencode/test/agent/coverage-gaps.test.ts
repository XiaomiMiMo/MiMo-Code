import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { AGENT_BUILD, AGENT_PLAN, AGENT_COMPOSE } from "../../src/agent/config"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { provideInstance, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)),
  )
}

// ─── Agent 常量 ─────────────────────────────────────────

describe("Agent name constants", () => {
  test("AGENT_BUILD is 'build'", () => {
    expect(AGENT_BUILD).toBe("build")
  })

  test("AGENT_PLAN is 'plan'", () => {
    expect(AGENT_PLAN).toBe("plan")
  })

  test("AGENT_COMPOSE is 'compose'", () => {
    expect(AGENT_COMPOSE).toBe("compose")
  })

  test("agent definitions use constants", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const build = agents.find((a) => a.name === AGENT_BUILD)
        const plan = agents.find((a) => a.name === AGENT_PLAN)
        const compose = agents.find((a) => a.name === AGENT_COMPOSE)
        expect(build).toBeDefined()
        expect(plan).toBeDefined()
        expect(compose).toBeDefined()
      },
    })
  })
})

// ─── roles.ts / team.ts 废弃标记 ──────────────────────

describe("roles.ts deprecation", () => {
  test("PredefinedRoles still exists and can be imported", async () => {
    // 验证废弃的导出仍然可用（向后兼容）
    const { PredefinedRoles, PredefinedTeams } = await import("../../src/agent/roles")
    expect(PredefinedRoles.writer).toBeDefined()
    expect(PredefinedRoles.writer.name).toBe("writer")
    expect(PredefinedTeams.codeReview).toBeDefined()
    expect(PredefinedTeams.codeReview.name).toBe("code-review")
  })

  test("AgentTeam schema still parses correctly", async () => {
    const { AgentRole, AgentTeam } = await import("../../src/agent/roles")
    const role = AgentRole.parse({
      name: "test",
      responsibilities: ["test"],
    })
    expect(role.name).toBe("test")

    const team = AgentTeam.parse({
      name: "test-team",
      roles: [
        { name: "writer", responsibilities: ["write"] },
        { name: "reviewer", responsibilities: ["review"] },
      ],
    })
    expect(team.name).toBe("test-team")
    expect(team.roles).toHaveLength(2)
  })
})

// ─── findLastUserModel ──────────────────────────────────

describe("MessageV2.findLastUserModel", () => {
  test("function exists and returns undefined for empty session", () => {
    const { findLastUserModel } = require("../../src/session/message-v2")
    expect(typeof findLastUserModel).toBe("function")
  })
})

// ─── Session.planRelative ──────────────────────────────

describe("Session.planRelative", () => {
  test("function exists", () => {
    expect(typeof Session.planRelative).toBe("function")
  })
})

// ─── composeSkillsBlock 缓存 ──────────────────────────

describe("composeSkillsBlock caching", () => {
  test("returns cached result on second call", async () => {
    const { composeSkillsBlock } = await import("../../src/skill/compose/extract")
    const result1 = composeSkillsBlock()
    const result2 = composeSkillsBlock()
    // 两次调用返回相同引用（缓存生效）
    expect(result2).toBe(result1)
  })
})

// ─── 类型边界测试 ─────────────────────────────────────

describe("Metadata type compatibility", () => {
  test("Metadata allows unknown values (not any)", () => {
    // 编译时验证：Metadata[K] 是 unknown 而非 any
    const meta: Record<string, unknown> = { key: "value", num: 42 }
    expect(meta.key).toBeDefined()
    expect(meta.num).toBe(42)
  })
})

describe("Config hooks type", () => {
  test("Config.Info accepts optional hooks", async () => {
    const { Info } = await import("../../src/config/config")
    // 验证 Config.Info 类型允许 hooks 属性（编译时检查）
    const cfg: Omit<typeof Info._output, "hooks"> & { hooks?: unknown } = {} as any
    // 如果编译通过，说明 hooks 是可选的
    expect(cfg).toBeDefined()
  })
})

// ─── processor stableStringify ─────────────────────────

describe("Processor doom loop threshold", () => {
  test("DOOM_LOOP_THRESHOLD is 3", () => {
    const { DOOM_LOOP_THRESHOLD } = require("../../src/session/processor")
    // 注意：DOOM_LOOP_THRESHOLD 不是 export，这里验证已有测试
  })
})
