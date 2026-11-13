import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { History } from "../../src/history"
import { Memory } from "../../src/memory"
import { Provider } from "../../src/provider"
import { HistoryTool } from "../../src/tool/history"
import DESCRIPTION_HISTORY from "../../src/tool/history.txt"
import { MemoryTool } from "../../src/tool/memory"
import DESCRIPTION_MEMORY from "../../src/tool/memory.txt"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool"
import { renderToolScriptDeclarations } from "../../src/tool/tool-script"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const envKeys = ["MIMOCODE_SEMANTIC_ENABLED", "MIMOCODE_SEMANTIC_MEMORY", "MIMOCODE_SEMANTIC_HISTORY"] as const
const original = new Map(envKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of envKeys) {
    const value = original.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const it = testEffect(Layer.mergeAll(
  Memory.defaultLayer,
  History.defaultLayer,
  Provider.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
))

function firstDeclarationLine(declarations: string, tool: "memory" | "history") {
  const line = declarations.split("\n").find((item) => item.includes(`  ${tool}(input:`))
  if (!line) throw new Error(`missing ${tool} declaration`)
  const index = declarations.split("\n").indexOf(line)
  return declarations.split("\n")[index - 1]!
}

describe("semantic tool declaration summaries", () => {
  it.live("renders BM25 and local embedding fallback in compact memory and history summaries when enabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        process.env.MIMOCODE_SEMANTIC_HISTORY = "true"
        const memory = yield* MemoryTool
        const history = yield* HistoryTool
        const definitions = yield* Effect.all([Tool.init(memory), Tool.init(history)])
        const rendered = renderToolScriptDeclarations(definitions)
        for (const [tool, expected] of [
          ["memory", "Search curated memory"],
          ["history", "Search history"],
        ] as const) {
          const summary = firstDeclarationLine(rendered, tool)
          expect(summary).toContain(expected)
          expect(summary).toContain("BM25")
          expect(summary).toContain("local embeddings")
          expect(summary).toContain("fall back to BM25")
        }
      }),
    ),
  )

  it.live("keeps the compact summaries at their original BM25-only first lines when disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "false"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        process.env.MIMOCODE_SEMANTIC_HISTORY = "true"
        const memory = yield* MemoryTool
        const history = yield* HistoryTool
        const definitions = yield* Effect.all([Tool.init(memory), Tool.init(history)])
        const rendered = renderToolScriptDeclarations(definitions)
        const memorySummary = firstDeclarationLine(rendered, "memory")
        const historySummary = firstDeclarationLine(rendered, "history")
        expect(memorySummary).toBe(`  /** ${DESCRIPTION_MEMORY.split("\n").find((line) => line.trim())} */`)
        expect(historySummary).toBe(`  /** ${DESCRIPTION_HISTORY.split("\n").find((line) => line.trim())} */`)
        expect(memorySummary).not.toContain("local embeddings")
        expect(historySummary).not.toContain("local embeddings")
      }),
    ),
  )
})
