import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Memory } from "../../src/memory"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage"
import { MemoryTool } from "../../src/tool/memory"
import DESCRIPTION from "../../src/tool/memory.txt"
import DESCRIPTION_SEMANTIC from "../../src/tool/memory.semantic.txt"
import DESCRIPTION_CHECKPOINT from "../../src/tool/memory.checkpoint.txt"
import { Truncate } from "../../src/tool"
import * as Tool from "../../src/tool/tool"
import { renderToolScriptDeclarations } from "../../src/tool/tool-script"
import { SessionID, MessageID } from "../../src/session/schema"
import { withCheckpointDescription } from "../../src/tool/checkpoint-description"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const envKeys = ["MIMOCODE_SEMANTIC_ENABLED", "MIMOCODE_SEMANTIC_MEMORY", "MIMOCODE_SEMINDEX_HELPER"] as const
const original = new Map(envKeys.map((key) => [key, process.env[key]]))
let fixturePath: string | undefined

afterEach(async () => {
  for (const key of envKeys) {
    const value = original.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (fixturePath) {
    const currentPath = fixturePath
    fixturePath = undefined
    await fs.rm(currentPath, { force: true })
    Database.use((db) => db.delete(MemoryFtsTable).where(eq(MemoryFtsTable.path, currentPath)).run())
  }
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(
  Memory.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
))

const ctx = {
  sessionID: SessionID.make("ses_memory_tool"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("semantic memory tool integration", () => {
  it.live("preserves the default-off description and output", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "false"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const file = path.join(root, "global", `semantic-memory-${crypto.randomUUID()}.md`)
        fixturePath = file
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "JWT signing notes for the project"))

        const info = yield* MemoryTool
        const tool = yield* Tool.init(info)
        expect(tool.description).toBe(withCheckpointDescription(DESCRIPTION, DESCRIPTION_CHECKPOINT))
        expect(tool.parameters.shape.query.description).toBe("Search query (BM25 over markdown bodies)")
        const result = yield* tool.execute({ operation: "search", query: "JWT" }, ctx)
        expect(result.output).toContain("BM25-ranked, best first")
        expect(result.output).toContain("A hit here is authoritative")
        expect(result.output).toContain(file)
        expect(result.output).toContain("Score:")
        expect(result.metadata.vectorSemanticHits).toBeUndefined()
      }),
    ),
  )

  it.live("advertises and safely presents hybrid memory results, with honest lexical fallback", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const temp = yield* tmpdirScoped()
        const helperPath = path.join(temp, "semantic-helper.py")
        process.env.MIMOCODE_SEMINDEX_HELPER = helperPath
        const helper = `import hashlib, json, sys
request = json.load(sys.stdin)
text = "semantic-only phrase"
for rank, source in enumerate(request["allowed"], 1):
    try:
        if text in open(source, encoding="utf-8").read():
            print(json.dumps([{"source": source, "text": text, "signature": hashlib.sha1(text.encode()).hexdigest()[:12], "rank": rank}]))
            break
    except OSError:
        pass
else:
    print("[]")
`
        yield* Effect.promise(() => Bun.write(helperPath, helper))

        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const file = path.join(root, "global", `semantic-memory-${crypto.randomUUID()}.md`)
        fixturePath = file
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "historical decision: semantic-only phrase"))

        const info = yield* MemoryTool
        const tool = yield* Tool.init(info)
        expect(tool.description).toContain("BM25 and local embeddings")
        expect(tool.description).toContain("unavailable embeddings fall back to BM25")
        expect(tool.description).toContain("historical evidence")
        expect(tool.description).not.toContain("A HIT IS AUTHORITATIVE")
        expect(tool.parameters.shape.query.description).toContain("local semantic retrieval")
        const compact = renderToolScriptDeclarations([tool])
        const summary = compact.split("\n").find((line) => line.includes("Search curated memory"))
        expect(summary).toContain("BM25")
        expect(summary).toContain("local embeddings")
        expect(summary).toContain("fall back to BM25")
        expect(summary!.slice("  /** ".length, -" */".length).length).toBeLessThanOrEqual(200)

        const semantic = yield* tool.execute({ operation: "search", query: "conceptfox" }, ctx)
        expect(semantic.output).toContain("hybrid ranked")
        expect(semantic.output).toContain("Retrieval: semantic")
        expect(semantic.output).toContain("> semantic-only phrase")
        expect(semantic.output).not.toContain("A hit here is authoritative")
        expect(semantic.metadata.vectorSemanticHits).toBe(1)

        process.env.MIMOCODE_SEMINDEX_HELPER = path.join(temp, "missing-helper.py")
        const fallback = yield* tool.execute({ operation: "search", query: "historical decision" }, ctx)
        expect(fallback.output).toContain("BM25-ranked, best first")
        expect(fallback.output).not.toContain("hybrid ranked")
        expect(fallback.output).not.toContain("A hit here is authoritative")
        expect(fallback.metadata.vectorSemanticHits).toBeUndefined()

        // Keep the unmodified description fixture reachable in this test so the
        // enabled and disabled descriptions remain explicit contract variants.
        expect(DESCRIPTION_SEMANTIC).toContain("untrusted")
      }),
    ),
  )
})
