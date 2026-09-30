import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Global } from "../../src/global"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node))

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.registry", () => {
  for (const location of ["config", "home", "project"] as const) {
    for (const folder of ["tool", "tools"]) {
      it.live(`does not import ${location} ${folder} on startup or reload`, () =>
        provideTmpdirInstance((dir) =>
          Effect.gen(function* () {
            const root = location === "config" ? Global.Path.config : location === "home" ? Global.Path.home : dir
            const directory = path.join(root, ...(location === "config" ? [] : [".mimocode"]), folder)
            const sink = path.join(dir, "imports.log")
            const files = ["example.ts", "example_js.js", "late.ts"].map((name) => path.join(directory, name))
            const source = [
              'import fs from "node:fs"',
              `fs.appendFileSync(${JSON.stringify(sink)}, "imported\\n")`,
              'export const named = { description: "example tool", args: {}, execute: async () => "example" }',
              "export default named",
            ].join("\n")
            yield* Effect.acquireRelease(
              Effect.promise(() => fs.mkdir(directory, { recursive: true })),
              () => Effect.promise(() => Promise.all(files.map((file) => fs.rm(file, { force: true })))),
            )
            yield* Effect.promise(() => Promise.all(files.slice(0, 2).map((file) => Bun.write(file, source))))

            const registry = yield* ToolRegistry.Service
            const ids = yield* registry.ids()
            expect(ids).not.toContain("example")
            expect(ids).not.toContain("example_named")
            expect(ids).not.toContain("example_js")
            expect(yield* Effect.promise(() => Bun.file(sink).exists())).toBe(false)

            yield* Effect.promise(() => Bun.write(files[2], source))
            yield* registry.reload()
            const reloaded = yield* registry.ids()
            expect(reloaded).not.toContain("example")
            expect(reloaded).not.toContain("example_js")
            expect(reloaded).not.toContain("late")
            expect(yield* Effect.promise(() => Bun.file(sink).exists())).toBe(false)
          }),
        ),
      )
    }
  }

  it.live("todowrite tool is not registered; task is", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).not.toContain("todowrite")
        expect(ids).not.toContain("todo")
        expect(ids).toContain("task")
      }),
    ),
  )

  it.live("loads plugin tools while keeping the reserved MCP search tool", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "plugin.ts")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            [
              "export default async () => ({",
              "  tool: {",
              "    example: { description: 'example tool', args: {}, execute: async () => 'example' },",
              "    mcp_tool_search: { description: 'replacement', args: {}, execute: async () => 'replacement' },",
              "  },",
              "})",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(path.join(dir, "mimocode.json"), JSON.stringify({ plugin: [pathToFileURL(file).href] })),
        )

        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.all()
        expect(tools.find((tool) => tool.id === "example")?.description).toBe("example tool")
        const matches = tools.filter((tool) => tool.id === "mcp_tool_search")
        expect(matches).toHaveLength(1)
        expect(matches[0].description).toContain("Search locally available MCP tools")
        expect(matches[0].description).not.toContain("replacement")
      }),
    ),
  )
})
