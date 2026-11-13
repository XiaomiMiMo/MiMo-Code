import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Inbox } from "../../src/inbox"
import * as Controller from "../../src/inbox/controller"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(Inbox.defaultLayer, Controller.defaultLayer, Session.defaultLayer, ActorRegistry.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("MCP event admission", () => {
  it.live("deduplicates and defers external events until the next claim", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const controller = yield* Controller.Service
    const inbox = yield* Inbox.Service
    const session = yield* sessions.create()
    const lane = { sessionID: session.id, agentID: "main" }
    const id = MessageID.ascending()
    const input = {
      lane,
      message: { id, sessionID: session.id, agentID: "main", role: "user" as const, agent: "general", model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") }, time: { created: Date.now() } },
      parts: [{ id: PartID.ascending(), sessionID: session.id, messageID: id, type: "text" as const, text: "regular prompt" }],
      type: "prompt",
    }
    yield* controller.accept(input)
    const first = yield* controller.claimNext(lane, 1)
    expect(first?.receipts).toHaveLength(1)
    const event = { receiverSessionID: session.id, receiverActorID: "main", content: "New external MCP event; inspect the connected server.", type: "mcp_event", idempotencyKey: "example-event-id", externalOrigin: { server: "example", event: "message.created", eventId: "evt-1" } }
    const receipt = yield* inbox.accept(event)
    const duplicate = yield* inbox.accept(event)
    expect(duplicate.inboxID).toBe(receipt.inboxID)
    expect(yield* controller.extendClaim(lane, 1)).toBeUndefined()
    const pending = yield* controller.listAccepted(lane)
    expect(pending.map((item) => item.id)).toEqual([receipt.inboxID])
    const messages = yield* sessions.messages({ sessionID: session.id })
    const eventMessage = messages.find((message) => message.info.id === receipt.inputMessageID)
    expect(eventMessage?.info.role === "user" && eventMessage.info.provenance).toEqual({ machine: "mcp-events:example" })
    expect(eventMessage?.parts[0]).toMatchObject({ synthetic: true, metadata: { origin: { kind: "mcp-event", server: "example" } } })
    const next = yield* controller.claimNext(lane, 2)
    expect(next?.receipts.map((item) => item.id)).toContain(receipt.inboxID)
  })))
})
