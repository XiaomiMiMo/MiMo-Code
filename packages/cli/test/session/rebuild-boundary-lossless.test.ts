import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Session as SessionNs } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { TaskRegistry } from "../../src/task/registry"
import { ActorRegistry } from "../../src/actor/registry"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { PartTable } from "../../src/session/session.sql"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Memory.defaultLayer,
    SessionNs.defaultLayer,
    TaskRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    SessionCheckpoint.defaultLayer,
  ),
)

const seedAssistantWithTool = Effect.fn("RebuildLosslessTest.seed")(function* (
  sessionID: SessionID,
  time: number,
  tool: string,
  output: string,
) {
  const sessions = yield* SessionNs.Service
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    agent: "build",
    parentID: MessageID.ascending(),
    providerID: ref.providerID,
    modelID: ref.modelID,
    mode: "build",
    path: { cwd: "/tmp/example", root: "/tmp/example" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: time },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "tool",
    callID: `call-${msg.id}`,
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: tool,
      metadata: {},
      time: { start: time, end: time + 1 },
    },
  })
  return msg
})

function storedParts(sessionID: SessionID) {
  return Database.use((db) =>
    db.select({ id: PartTable.id, data: PartTable.data }).from(PartTable).where(eq(PartTable.session_id, sessionID)).all(),
  )
}

describe("rebuild boundary", () => {
  it.live(
    "leaves every tool output after the watermark unchanged in the database",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const checkpoint = yield* SessionCheckpoint.Service
        const info = yield* sessions.create({})

        // insertRebuildBoundary only inserts a boundary when checkpoint.md renders.
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(checkpointPath(info.id)), { recursive: true })
          await Bun.write(checkpointPath(info.id), "## §1 Active intent\n\nrebuild boundary test\n")
        })

        const t0 = 1_700_000_000_000
        const boundary = yield* seedAssistantWithTool(info.id, t0, "read", "PRE_BOUNDARY_READ")
        for (const [offset, tool] of ["read", "bash", "grep", "edit"].entries())
          yield* seedAssistantWithTool(info.id, t0 + 100 + offset, tool, `POST_BOUNDARY_${tool.toUpperCase()}_OUTPUT`)
        const before = storedParts(info.id)
        expect(before).toHaveLength(5)

        const inserted = yield* checkpoint.insertRebuildBoundary({
          sessionID: info.id,
          boundary: boundary.id,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })
        expect(inserted).toBe(true)

        const after = new Map(storedParts(info.id).map((row) => [row.id, row.data]))
        expect(after.size).toBeGreaterThan(before.length)
        const changed = before
          .filter((row) => !Bun.deepEquals(after.get(row.id), row.data))
          .map((row) => ({ id: row.id, after: after.get(row.id) }))
        expect(changed).toEqual([])
      }),
    ),
  )
})
