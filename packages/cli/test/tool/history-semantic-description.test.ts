import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { History } from "../../src/history"
import { Provider } from "../../src/provider"
import { HistoryTool } from "../../src/tool/history"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const envKeys = ["MIMOCODE_SEMANTIC_ENABLED", "MIMOCODE_SEMANTIC_HISTORY"] as const
const original = new Map(envKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of envKeys) {
    const value = original.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const it = testEffect(Layer.mergeAll(
  History.defaultLayer,
  Provider.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
))

describe("History semantic description", () => {
  it.live("preserves the original BM25-only description and query schema when disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "false"
        process.env.MIMOCODE_SEMANTIC_HISTORY = "false"
        const info = yield* HistoryTool
        const tool = yield* info.init()

        expect(tool.description).toContain("FTS BM25 over text")
        expect(tool.description).not.toContain("local semantic retrieval")
        expect(tool.parameters.shape.query.description).toBeUndefined()
      }),
    ),
  )

  it.live("describes scoped hybrid search, lexical fallback, untrusted evidence, and source operations when enabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_HISTORY = "true"
        const info = yield* HistoryTool
        const tool = yield* info.init()

        expect(tool.description).toContain("BM25 plus local semantic retrieval")
        expect(tool.description).toContain("if semantic retrieval is unavailable")
        expect(tool.description).toContain("unavailable embeddings fall back to BM25")
        expect(tool.description).toContain("untrusted historical evidence")
        expect(tool.description).toContain("outcome is unknown")
        expect(tool.description).toContain("UTF-16 cursors")
        expect(tool.description).toContain("inline:0")
        expect(tool.description).not.toContain("search: FTS BM25 over")
        expect(tool.parameters.shape.query.description).toContain("local semantic retrieval")
        expect(tool.parameters.shape.query.description).toContain("BM25 fallback")
      }),
    ),
  )
})
