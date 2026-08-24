import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import type { Tool } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { ToolScriptTool } from "../../src/tool/tool-script"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node))

describe("tool.skill", () => {
  it.live("execute returns skill content block with files", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".mimocode", "skill", "tool-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

          const home = process.env.HOME
          const userProfile = process.env.USERPROFILE
          process.env.HOME = dir
          process.env.USERPROFILE = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.HOME = home
              process.env.USERPROFILE = userProfile
            }),
          )

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === ToolScriptTool.id)
          if (!tool) throw new Error("Exec tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = yield* tool.execute(
            {
              code: `const result = await tools.skill({ name: "tool-skill" })
return {
  dir: result.metadata.dir,
  hasContent: result.output.includes('<skill_content name="tool-skill">'),
  hasBase: result.output.includes(${JSON.stringify(`Base directory for this skill: ${pathToFileURL(skill).href}`)}),
  hasFile: result.output.includes(${JSON.stringify(`<file>${path.resolve(skill, "scripts", "demo.txt")}</file>`)}),
}`,
            },
            { ...ctx, extra: { model: { providerID: "opencode", id: "gpt-5" } } },
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")
          expect(result.metadata.status).toBe("completed")
          expect(result.output).toContain(`"dir": ${JSON.stringify(skill)}`)
          expect(result.output).toContain('"hasContent": true')
          expect(result.output).toContain('"hasBase": true')
          expect(result.output).toContain('"hasFile": true')
        }),
      { git: true },
    ),
  )

  it.live("a built-in workflow name redirects to the workflow tool, not a dead-end error", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === ToolScriptTool.id)
          if (!tool) throw new Error("Exec tool not found")
          const ctx: Tool.Context = { ...baseCtx, ask: () => Effect.void }
          const result = yield* tool.execute(
            {
              code: `try {
  await tools.skill({ name: "fact-check" })
  return "unexpected success"
} catch (error) {
  return error.message
}`,
            },
            { ...ctx, extra: { model: { providerID: "opencode", id: "gpt-5" } } },
          )
          expect(result.metadata.status).toBe("completed")
          const msg = result.output
          expect(msg).toContain("built-in WORKFLOW")
          expect(msg).toContain("workflow tool")
          expect(msg).toContain('name: "fact-check"')
        }),
      { git: true },
    ),
  )

  it.live("refuses a disable-model-invocation skill and points at the user's slash command", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".mimocode", "skill", "gated-skill", "SKILL.md"),
                `---
name: gated-skill
description: Only the user may start this one.
disable-model-invocation: true
---

# Gated Skill

GATED_BODY_MARKER
`,
              ),
              Bun.write(
                path.join(dir, ".mimocode", "skill", "open-skill", "SKILL.md"),
                `---
name: open-skill
description: Anyone may start this one.
---

# Open Skill
`,
              ),
            ]),
          )

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === ToolScriptTool.id)
          if (!tool) throw new Error("Exec tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = yield* tool.execute(
            {
              code: `try {
  await tools.skill({ name: "gated-skill" })
  return "unexpected success"
} catch (error) {
  return error.message
}`,
            },
            { ...ctx, extra: { model: { providerID: "opencode", id: "gpt-5" } } },
          )
          expect(result.metadata.status).toBe("completed")
          const msg = result.output
          expect(msg).toContain("disable-model-invocation")
          expect(msg).toContain("/gated-skill")
          expect(msg).not.toContain("GATED_BODY_MARKER")
          // Refused before the permission ask, so no approval is requested for a
          // call that can never succeed.
          expect(requests).toEqual([])

          // The tool schema is static and never embeds either the reachable or
          // model-gated catalog. A mistyped name must not leak the gated skill.
          expect(tool.description).not.toContain("gated-skill")
          expect(tool.description).not.toContain("open-skill")
          expect(tool.description).toContain("listed in the system prompt")
          const miss = yield* tool.execute(
            {
              code: `try {
  await tools.skill({ name: "gated-skil" })
  return "unexpected success"
} catch (error) {
  return error.message
}`,
            },
            { ...ctx, extra: { model: { providerID: "opencode", id: "gpt-5" } } },
          )
          const missMsg = miss.output
          expect(missMsg).toContain("not found")
          expect(missMsg).toContain("open-skill")
          expect(missMsg).not.toContain("gated-skill")
        }),
      { git: true },
    ),
  )
})
