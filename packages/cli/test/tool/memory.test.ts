import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Memory } from "../../src/memory"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage"
import { MemoryTool } from "../../src/tool/memory"
import { Truncate } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  Database.use((db) => db.delete(MemoryFtsTable).run())
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("memory tool", () => {
  it.live("search operation returns formatted results", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "global", "auth.md"), "JWT signing notes。把所有项目知识总结进一个文档。"))

        const info = yield* MemoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ operation: "search", query: "JWT" }, ctx)

        expect(result.output).toContain("auth.md")
        // [TP-R6-07] The public tool searches Chinese and presents original text.
        for (const query of ["项目知识", "项目 知识", "文档"]) {
          const result = yield* tool.execute({ operation: "search", query }, ctx)
          expect(result.output).toContain("auth.md")
          expect(result.output).not.toContain("No matches")
          expect(result.output).not.toContain("项 目")
        }
      }),
    ),
  )

  it.live("search operation with empty result returns 'No matches'", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))

        const info = yield* MemoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ operation: "search", query: "nonexistent" }, ctx)

        expect(result.output).toContain("No matches")
      }),
    ),
  )
})
