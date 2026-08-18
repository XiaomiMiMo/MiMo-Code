import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LLM } from "../../src/session/llm"
import { Session as SessionNs } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as SessionSystemSnapshot from "../../src/session/system-snapshot"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, LLM.defaultLayer, CrossSpawnSpawner.defaultLayer))

function agent(prompt: string): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    prompt,
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

describe("LLM session system snapshot integration", () => {
  it.live("[TP-R16-01][TP-R16-02][TP-R16-05] stable block is reused while current-turn system stays live", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const llm = yield* LLM.Service
        const session = yield* sessions.create({})
        const model = ProviderTest.model()
        const user = (system: string): MessageV2.User => ({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
          system,
        })

        const first = yield* llm.buildSystemArray({
          agent: agent("stable-first"),
          model,
          system: ["addition-one"],
          user: user("turn-one"),
          sessionID: session.id,
        })
        const reopened = yield* llm.buildSystemArray({
          agent: agent("reassembled-different"),
          model,
          system: ["addition-two"],
          user: user("turn-two"),
          sessionID: session.id,
        })

        expect(first.length).toBe(2)
        expect(first[0]).toContain("stable-first")
        expect(first[1]).toContain("addition-one\nturn-one")
        expect(reopened[0]).toBe(first[0])
        expect(reopened[0]).not.toContain("reassembled-different")
        expect(reopened[1]).toContain("addition-two\nturn-two")
        expect(reopened[1]).not.toContain("addition-one")

        const identity: SessionSystemSnapshot.SessionSystemSnapshotIdentity = {
          protocol: SessionSystemSnapshot.SESSION_SYSTEM_SNAPSHOT_PROTOCOL,
          sessionID: session.id,
          providerID: model.providerID,
          modelID: model.id,
          agent: "build",
          agentID: "main",
          edition: process.env["MIMO_EDITION"] ?? "unscoped",
          checkpoint: true,
        }
        expect(yield* Effect.promise(() => SessionSystemSnapshot.read(identity))).toBe(first[0])

        yield* sessions.remove(session.id)
        expect(yield* Effect.promise(() => SessionSystemSnapshot.read(identity))).toBeUndefined()

        const parent = yield* sessions.create({ title: "snapshot parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "snapshot child" })
        const snapshotIdentity = (sessionID: typeof parent.id): SessionSystemSnapshot.SessionSystemSnapshotIdentity => ({
          ...identity,
          sessionID,
        })
        yield* Effect.promise(() => SessionSystemSnapshot.publish(snapshotIdentity(parent.id), "parent"))
        yield* Effect.promise(() => SessionSystemSnapshot.publish(snapshotIdentity(child.id), "child"))
        yield* sessions.remove(parent.id)
        expect(yield* Effect.promise(() => SessionSystemSnapshot.read(snapshotIdentity(parent.id)))).toBeUndefined()
        expect(yield* Effect.promise(() => SessionSystemSnapshot.read(snapshotIdentity(child.id)))).toBeUndefined()
      }),
    ),
    20_000,
  )
})
