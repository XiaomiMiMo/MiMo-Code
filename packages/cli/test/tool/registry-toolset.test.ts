import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ToolRegistry } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { ProviderID, ModelID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"

const it = testEffect(
  Layer.mergeAll(ToolRegistry.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

describe("ToolRegistry.tools: toolset selection", () => {
  it.live("advertises only exec in Codex mode while keeping hidden tools registered", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("openai/gpt-5.4"),
          agent: build,
          harness: "codex",
        })
        const registered = yield* reg.registered({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("openai/gpt-5.4"),
          agent: build,
          harness: "codex",
        })
        const ids = tools.map((tool) => tool.id)
        const nested = [
          "bash",
          "apply_patch",
          "view_image",
          "actor",
          "task",
          "question",
          "webfetch",
          "skill_search",
          "skill",
          "plan_exit",
          "memory",
          "history",
          "cron",
        ]

        expect(ids).toEqual(["exec"])
        expect(registered.map((tool) => tool.id)).toContain("webfetch")
        nested.forEach((id) => expect(ids).not.toContain(id))

        const description = tools.find((tool) => tool.id === "exec")?.description ?? ""
        expect(description).toContain("webfetch(input:")
        nested.filter((id) => id !== "bash").forEach((id) => expect(description).toContain(`${id}(input:`))
        expect(description).toContain("exec_command(input:")
        expect(description).not.toContain("\n  bash(input:")
        expect(description).toContain("`timeout` is always measured in milliseconds")
      }),
    ),
  )

  it.live("uses the harness rather than the model to select the toolset", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const normalDefault = yield* reg.tools({
          providerID: ProviderID.make("xiaomi"),
          modelID: ModelID.make("mimo-v2.6"),
          agent: build,
        })
        const responsesDefault = yield* reg.tools({
          providerID: ProviderID.make("xiaomi"),
          modelID: ModelID.make("mimo-v2.6-ptc"),
          agent: build,
        })
        const normalCodex = yield* reg.tools({
          providerID: ProviderID.make("xiaomi"),
          modelID: ModelID.make("mimo-v2.6"),
          agent: build,
          harness: "codex",
        })
        const responsesCodex = yield* reg.tools({
          providerID: ProviderID.make("xiaomi"),
          modelID: ModelID.make("mimo-v2.6-ptc"),
          agent: build,
          harness: "codex",
        })

        expect(normalDefault.map((tool) => tool.id)).toContain("bash")
        expect(normalDefault.map((tool) => tool.id)).not.toContain("exec")
        expect(responsesDefault.map((tool) => tool.id)).toContain("bash")
        expect(responsesDefault.map((tool) => tool.id)).not.toContain("exec")
        expect(normalCodex.map((tool) => tool.id)).toEqual(["exec"])
        const gptDefault = yield* reg.tools({
          providerID: ProviderID.openai,
          modelID: ModelID.make("gpt-5.4"),
          agent: build,
        })
        expect(gptDefault.map((tool) => tool.id)).toContain("bash")
        expect(gptDefault.map((tool) => tool.id)).not.toContain("exec")
        expect(responsesCodex.map((tool) => tool.id)).toEqual(["exec"])
      }),
    ),
  )

  it.live("keeps the specialized-tool bash description outside Codex mode", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: general,
        })
        const bash = tools.find((tool) => tool.id === "bash")
        expect(bash?.description).toContain("DO NOT use it for file operations")
        expect(bash?.description).not.toContain("the dedicated `read`, `write`, and `edit` tools are unavailable")
        expect(tools.find((tool) => tool.id === "skill_search")?.description).not.toContain("first query")
        expect(tools.some((tool) => tool.id === "notebook_edit")).toBeTrue()
        expect(tools.some((tool) => tool.id === "grep")).toBeTrue()
        expect(tools.some((tool) => tool.id === "glob")).toBeTrue()
      }),
    ),
  )

  it.live("uses the filesystem-capable bash description and masks file tools in Codex mode", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const tools = yield* reg.registered({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: general,
          harness: "codex",
        })
        const bash = tools.find((tool) => tool.id === "bash")
        expect(bash?.description).toContain("the dedicated `read`, `write`, and `edit` tools are unavailable")
        expect(bash?.description).not.toContain("DO NOT use it for file operations")
        for (const id of ["read", "write", "edit", "multiedit", "grep", "glob", "notebook_edit"])
          expect(tools.some((tool) => tool.id === id)).toBeFalse()
      }),
    ),
  )

  it.live("task parameters expose the JSON operation schema (no script field)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: general,
        })
        const task = tools.find((t) => t.id === "task")
        expect(task).toBeDefined()
        // JSON mode → parameters is an object wrapping an `operation` discriminated
        // union (discriminator "action"). Confirm `operation` is present and `script`
        // (the shell-mode shape) is not.
        const schema = task!.parameters as any
        expect(schema.shape?.operation ?? schema._def?.shape?.operation).toBeDefined()
        expect(schema.shape?.script ?? schema._def?.shape?.script).toBeUndefined()
      }),
    ),
  )

  it.live("offers Exa search tools to no provider unless explicitly enabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const ids = (providerID: string) =>
          reg
            .tools({ providerID: ProviderID.make(providerID), modelID: ModelID.make("mimo-v2.6"), agent: build })
            .pipe(Effect.map((tools) => tools.map((tool) => tool.id)))
        for (const providerID of ["xiaomi", "xiaomi-token-plan-cn", "openai", "opencode"]) {
          const tools = yield* ids(providerID)
          expect(tools).not.toContain("websearch")
          expect(tools).not.toContain("codesearch")
        }
      }),
    ),
  )

})
