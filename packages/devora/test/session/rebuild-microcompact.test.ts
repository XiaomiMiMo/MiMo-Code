import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Session as SessionNs } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { TaskRegistry } from "../../src/task/registry"
import { ActorRegistry } from "../../src/actor/registry"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"
import type { MessageV2 } from "../../src/session/message-v2"

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

async function seedAssistantWithTool(
  sessionID: SessionID,
  time: number,
  toolName: string,
  output: string,
) {
  const parentID = MessageID.ascending()
  const msg = await Effect.runPromise(
    SessionNs.Service.use((s) =>
      s.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        agent: "build",
        parentID,
        providerID: ref.providerID,
        modelID: ref.modelID,
        mode: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: time },
      }),
    ).pipe(Effect.provide(SessionNs.defaultLayer)),
  )
  const part = await Effect.runPromise(
    SessionNs.Service.use((s) =>
      s.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "tool",
        callID: `call-${msg.id}`,
        tool: toolName,
        state: {
          status: "completed",
          input: {},
          output,
          title: toolName,
          metadata: {},
          time: { start: time, end: time + 1 },
        },
      }),
    ).pipe(Effect.provide(SessionNs.defaultLayer)),
  )
  return { msg, part }
}

describe("rebuild microcompact", () => {
  it.live(
    "clears completed compactable tool_result strictly newer than boundary; preserves non-compactable and pre-boundary",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const cp = yield* SessionCheckpoint.Service
        const info = yield* ssn.create({})

        // Seed checkpoint.md so renderRebuildContext returns non-empty (else
        // insertRebuildBoundary short-circuits and microcompact never runs).
        yield* Effect.promise(async () => {
          await fs.mkdir(
            checkpointPath(info.id).replace(/\/[^/]+$/, ""),
            { recursive: true },
          )
          await Bun.write(checkpointPath(info.id), "## §1 Active intent\n\nrebuild microcompact test\n")
        })

        const t0 = 1_700_000_000_000
        // Pre-boundary: read tool with body — should NOT be cleared.
        const pre = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, t0, "read", "PRE_BODY"),
        )
        // Boundary marker is inserted at boundaryTime + 1; "boundary" is the
        // first kept message ID from computeBoundary's perspective, but
        // insertRebuildBoundary uses boundaryCreatedAt + 1 for the marker time.
        // Anything strictly newer than that time is the post-boundary tail.
        const boundaryTime = t0 + 10
        // Post-boundary, compactable: read + bash + edit → all 3 must be cleared.
        const postRead = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, boundaryTime + 5, "read", "POST_READ_BODY"),
        )
        const postBash = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, boundaryTime + 6, "bash", "POST_BASH_BODY"),
        )
        const postEdit = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, boundaryTime + 7, "edit", "POST_EDIT_BODY"),
        )
        // Post-boundary, non-compactable: actor + task + todowrite → preserved.
        const postActor = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, boundaryTime + 8, "actor", "POST_ACTOR_BODY"),
        )
        const postTask = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, boundaryTime + 9, "task", "POST_TASK_BODY"),
        )
        const postTodo = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, boundaryTime + 10, "todowrite", "POST_TODO_BODY"),
        )

        const inserted = yield* cp.insertRebuildBoundary({
          sessionID: info.id,
          boundary: pre.msg.id,
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
          boundaryCreatedAt: boundaryTime,
        })
        expect(inserted).toBe(true)

        const all = yield* ssn.messages({ sessionID: info.id })
        const findPart = (msgID: typeof pre.msg.id) =>
          all.find((m) => m.info.id === msgID)?.parts.find((p) => p.type === "tool")

        const preTool = findPart(pre.msg.id)
        const postReadTool = findPart(postRead.msg.id)
        const postBashTool = findPart(postBash.msg.id)
        const postEditTool = findPart(postEdit.msg.id)
        const postActorTool = findPart(postActor.msg.id)
        const postTaskTool = findPart(postTask.msg.id)
        const postTodoTool = findPart(postTodo.msg.id)

        const compactedOf = (p?: MessageV2.Part) =>
          p && p.type === "tool" && p.state.status === "completed"
            ? p.state.time.compacted
            : undefined

        // Pre-boundary tool: NOT cleared (msg time <= boundaryTime).
        expect(compactedOf(preTool)).toBeUndefined()
        // Post-boundary compactable: cleared.
        expect(compactedOf(postReadTool)).toBeGreaterThan(0)
        expect(compactedOf(postBashTool)).toBeGreaterThan(0)
        expect(compactedOf(postEditTool)).toBeGreaterThan(0)
        // Post-boundary non-compactable: NOT cleared.
        expect(compactedOf(postActorTool)).toBeUndefined()
        expect(compactedOf(postTaskTool)).toBeUndefined()
        expect(compactedOf(postTodoTool)).toBeUndefined()
      }),
    ),
  )

  it.live(
    "no-op when no post-boundary compactable tool parts exist",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const cp = yield* SessionCheckpoint.Service
        const info = yield* ssn.create({})

        yield* Effect.promise(async () => {
          await fs.mkdir(
            checkpointPath(info.id).replace(/\/[^/]+$/, ""),
            { recursive: true },
          )
          await Bun.write(checkpointPath(info.id), "## §1 Active intent\n\nno-op test\n")
        })

        const t0 = 1_700_000_000_000
        const pre = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, t0, "read", "PRE_BODY"),
        )

        const inserted = yield* cp.insertRebuildBoundary({
          sessionID: info.id,
          boundary: pre.msg.id,
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
          boundaryCreatedAt: t0 + 100,
        })
        expect(inserted).toBe(true)

        const all = yield* ssn.messages({ sessionID: info.id })
        const preTool = all
          .find((m) => m.info.id === pre.msg.id)
          ?.parts.find((p) => p.type === "tool")
        expect(
          preTool && preTool.state.status === "completed"
            ? preTool.state.time.compacted
            : undefined,
        ).toBeUndefined()
      }),
    ),
  )

  // C1 regression: boundaryCreatedAt undefined + boundary id present in DB.
  // Helper must look up the boundary message's time.created instead of
  // falling back to 0 (which would clear every compactable tool result).
  it.live(
    "boundaryCreatedAt undefined: looks up boundary time from DB and clears only post-boundary",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const cp = yield* SessionCheckpoint.Service
        const info = yield* ssn.create({})

        yield* Effect.promise(async () => {
          await fs.mkdir(checkpointPath(info.id).replace(/\/[^/]+$/, ""), { recursive: true })
          await Bun.write(checkpointPath(info.id), "## §1 Active intent\n\nC1 lookup test\n")
        })

        const t0 = 1_700_000_000_000
        const pre = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, t0, "read", "PRE_BODY"),
        )
        const post = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, t0 + 1000, "read", "POST_BODY"),
        )

        // boundaryCreatedAt INTENTIONALLY OMITTED — exercises the fallback
        // path that should look up pre.msg.id in allMsgs and use its time.
        const inserted = yield* cp.insertRebuildBoundary({
          sessionID: info.id,
          boundary: pre.msg.id,
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
        })
        expect(inserted).toBe(true)

        const all = yield* ssn.messages({ sessionID: info.id })
        const findTool = (id: typeof pre.msg.id) =>
          all.find((m) => m.info.id === id)?.parts.find((p) => p.type === "tool")
        const compactedOf = (p?: MessageV2.Part) =>
          p && p.type === "tool" && p.state.status === "completed" ? p.state.time.compacted : undefined

        // Pre-boundary: NOT cleared (lookup found pre.msg's time correctly).
        expect(compactedOf(findTool(pre.msg.id))).toBeUndefined()
        // Post-boundary: cleared.
        expect(compactedOf(findTool(post.msg.id))).toBeGreaterThan(0)
      }),
    ),
  )

  // C1 regression: boundaryCreatedAt undefined AND boundary id not in DB.
  // Helper must skip microcompact entirely (fail-closed). The previous
  // fallback to 0 cleared EVERY completed compactable tool result.
  it.live(
    "boundaryCreatedAt undefined AND unknown boundary id: skip microcompact (fail-closed)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const cp = yield* SessionCheckpoint.Service
        const info = yield* ssn.create({})

        yield* Effect.promise(async () => {
          await fs.mkdir(checkpointPath(info.id).replace(/\/[^/]+$/, ""), { recursive: true })
          await Bun.write(checkpointPath(info.id), "## §1 Active intent\n\nC1 fail-closed test\n")
        })

        const t0 = 1_700_000_000_000
        const a = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, t0, "read", "A_BODY"),
        )
        const b = yield* Effect.promise(() =>
          seedAssistantWithTool(info.id, t0 + 100, "bash", "B_BODY"),
        )

        const inserted = yield* cp.insertRebuildBoundary({
          sessionID: info.id,
          boundary: MessageID.ascending(),
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
        })
        expect(inserted).toBe(true)

        const all = yield* ssn.messages({ sessionID: info.id })
        const findTool = (id: typeof a.msg.id) =>
          all.find((m) => m.info.id === id)?.parts.find((p) => p.type === "tool")
        const compactedOf = (p?: MessageV2.Part) =>
          p && p.type === "tool" && p.state.status === "completed" ? p.state.time.compacted : undefined

        // Both should be PRESERVED — fail-closed prevents whole-DB clear.
        expect(compactedOf(findTool(a.msg.id))).toBeUndefined()
        expect(compactedOf(findTool(b.msg.id))).toBeUndefined()
      }),
    ),
  )
})
