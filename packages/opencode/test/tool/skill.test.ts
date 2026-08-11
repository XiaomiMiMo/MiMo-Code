import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Cause, Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import type { Tool } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
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
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = yield* tool.execute({ name: "tool-skill" }, ctx)
          const file = path.resolve(skill, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")
          expect(result.metadata.dir).toBe(skill)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(skill).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
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
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")
          const ctx: Tool.Context = { ...baseCtx, ask: () => Effect.void }
          const exit = yield* Effect.exit(tool.execute({ name: "fact-check" }, ctx))
          expect(exit._tag).toBe("Failure")
          const msg = exit._tag === "Failure" ? Cause.pretty(exit.cause) : ""
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
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const exit = yield* Effect.exit(tool.execute({ name: "gated-skill" }, ctx))
          expect(exit._tag).toBe("Failure")
          const msg = exit._tag === "Failure" ? Cause.pretty(exit.cause) : ""
          expect(msg).toContain("disable-model-invocation")
          expect(msg).toContain("/gated-skill")
          expect(msg).not.toContain("GATED_BODY_MARKER")
          // Refused before the permission ask, so no approval is requested for a
          // call that can never succeed.
          expect(requests).toEqual([])

          // The tool description must not advertise it either, and a mistyped
          // name must not leak it back through the not-found hint.
          expect(tool.description).not.toContain("gated-skill")
          expect(tool.description).toContain("open-skill")
          const miss = yield* Effect.exit(tool.execute({ name: "gated-skil" }, ctx))
          const missMsg = miss._tag === "Failure" ? Cause.pretty(miss.cause) : ""
          expect(missMsg).toContain("not found")
          expect(missMsg).toContain("open-skill")
          expect(missMsg).not.toContain("gated-skill")
        }),
      { git: true },
    ),
  )
})
