import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Permission } from "../../src/permission"
import type { Tool } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { SkillSearchTool } from "../../src/tool/skill-search"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("tool.skill_search", () => {
  it.live("loads the highest-confidence exact match", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".mimocode", "skill", "business-review")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: business-review
description: Generate executive business review presentations from sales spreadsheets.
aliases:
  - quarterly-review
---

# Business Review

Build the management presentation.
`,
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "build.ts"), "export {}"))

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
          })).find((item) => item.id === SkillSearchTool.id)
          if (!tool) throw new Error("Skill search tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (request) => Effect.sync(() => requests.push(request)),
          }
          const result = yield* tool.execute({ query: "quarterly-review" }, ctx)
          const [payload] = result.output.split("\n\n<skill_content")

          const parsed = JSON.parse(payload)
          expect(parsed).toMatchObject({
            status: "matched",
            loaded_skill_id: "business-review",
          })
          expect(parsed.results[0]).toMatchObject({ skill_id: "business-review", name: "business-review", score: 1 })
          expect(result.output).toContain('<skill_content name="business-review">')
          expect(result.output).toContain("Build the management presentation.")
          expect(result.output).toContain("<skill_files>")
          expect(result.output).toContain(`<file>${path.join(skill, "scripts", "build.ts")}</file>`)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toEqual(["business-review"])
        }),
      { git: true },
    ),
  )

  it.live("returns no_match when no skill is relevant", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((item) => item.id === SkillSearchTool.id)
          if (!tool) throw new Error("Skill search tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const result = yield* tool.execute(
            { query: "zyxwvutsrqponmlkjihgfedcba" },
            {
              sessionID: SessionID.make("ses_test"),
              messageID: MessageID.make("msg_test"),
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: (request) => Effect.sync(() => requests.push(request)),
            },
          )

          expect(JSON.parse(result.output)).toEqual({
            status: "no_match",
            results: [],
            loaded_skill_id: null,
          })
          expect(requests).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("returns uncertain BM25 matches without loading a skill", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".mimocode", "skill", "quasar-analysis", "SKILL.md"),
              `---
name: quasar-analysis
description: Analyze quasar telemetry and operational metrics.
---

# Quasar Analysis
`,
            ),
          )
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
          })).find((item) => item.id === SkillSearchTool.id)
          if (!tool) throw new Error("Skill search tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const result = yield* tool.execute(
            { query: "analyze quasar operational telemetry into executive deck for management" },
            {
              sessionID: SessionID.make("ses_test"),
              messageID: MessageID.make("msg_test"),
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: (request) => Effect.sync(() => requests.push(request)),
            },
          )
          const payload = JSON.parse(result.output)

          expect(payload).toMatchObject({ status: "matched", loaded_skill_id: null })
          expect(payload.results[0].skill_id).toBe("quasar-analysis")
          expect(payload.results.length).toBeLessThanOrEqual(3)
          expect(requests).toEqual([])
        }),
      { git: true },
    ),
  )
})
