import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { viewExecSubtools } from "../../src/tool/tool-script"

void Log.init({ print: false })

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

const env = Layer.mergeAll(SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

const seedMixed = Effect.fn("seedMixed")(function* (sessionID: SessionID) {
  const ssn = yield* SessionNs.Service
  const mainUserID = MessageID.ascending()
  yield* ssn.updateMessage({
    id: mainUserID,
    role: "user" as const,
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: mainUserID,
    sessionID,
    type: "text",
    text: "main",
  })
  const subUserID = MessageID.ascending()
  yield* ssn.updateMessage({
    id: subUserID,
    role: "user" as const,
    sessionID,
    agentID: "explore-1",
    agent: "explore",
    model: ref,
    time: { created: Date.now() + 1 },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: subUserID,
    sessionID,
    type: "text",
    text: "explore",
  })
  return { mainUserID, subUserID }
})

describe("MessageV2.page / stream — default slice contract", () => {
  it.live(
    "default (no agentID) returns ONLY main slice",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const { mainUserID } = yield* seedMixed(info.id)

        const defaultPage = MessageV2.page({ sessionID: info.id, limit: 10 })
        const defaultStream = Array.from(MessageV2.stream(info.id))

        expect(defaultPage.items.map((m) => m.info.id)).toEqual([mainUserID])
        expect(defaultStream.map((m) => m.info.id)).toEqual([mainUserID])
      }),
    ),
  )

  it.live(
    'agentID: "*" returns every slice',
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const { mainUserID, subUserID } = yield* seedMixed(info.id)

        const allPage = MessageV2.page({ sessionID: info.id, limit: 10, agentID: "*" })
        const allStream = Array.from(MessageV2.stream(info.id, { agentID: "*" }))
        const ids = allPage.items.map((m) => m.info.id).sort()
        expect(ids).toEqual([mainUserID, subUserID].sort())
        expect(allStream.map((m) => m.info.id).sort()).toEqual([mainUserID, subUserID].sort())
      }),
    ),
  )

  it.live(
    'agentID: "explore-1" returns only that subagent slice',
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const { subUserID } = yield* seedMixed(info.id)

        const subPage = MessageV2.page({ sessionID: info.id, limit: 10, agentID: "explore-1" })
        expect(subPage.items.map((m) => m.info.id)).toEqual([subUserID])
      }),
    ),
  )

  it.live(
    "round-trips exec sub_parts through the SQLite-backed message part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const messageID = MessageID.ascending()
        yield* ssn.updateMessage({
          id: messageID,
          role: "user" as const,
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        const metadata = {
          exec_schema: 1,
          sub_parts: [
            {
              seq: 1,
              type: "tool" as const,
              callID: "exec:1",
              tool: "actor",
              state: {
                status: "completed" as const,
                input: { operation: { action: "spawn" } },
                title: "Child",
                output: "started",
                metadata: { sessionId: "ses_child", actorId: "general-1" },
                time: { start: 1, end: 2 },
              },
            },
          ],
        }
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "tool" as const,
          callID: "exec",
          tool: "exec",
          state: {
            status: "completed" as const,
            input: { code: "return 1" },
            output: "1",
            title: "1 tool calls",
            metadata,
            time: { start: 1, end: 2 },
          },
        })

        const part = MessageV2.page({ sessionID: info.id, limit: 10 }).items[0]?.parts.find((item) => item.type === "tool")
        expect(part?.type).toBe("tool")
        expect(part?.type === "tool" && part.state.status !== "pending" ? viewExecSubtools(part.state.metadata) : []).toEqual(metadata.sub_parts)
      }),
    ),
  )
})
