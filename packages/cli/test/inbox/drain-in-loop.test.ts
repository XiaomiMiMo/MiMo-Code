import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Inbox } from "../../src/inbox"
import * as Controller from "../../src/inbox/controller"
import { resolveDrainSeed } from "../../src/inbox/inbox"
import { MAX_CLAIM_PER_STEP } from "../../src/inbox/schema"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { ActorRegistry } from "../../src/actor/registry"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Database, eq } from "../../src/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(Inbox.defaultLayer, Controller.defaultLayer, Session.defaultLayer, ActorRegistry.defaultLayer, CrossSpawnSpawner.defaultLayer))
const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const register = (sessionID: SessionID, actorID = "main", mode: "peer" | "subagent" = "subagent") =>
  ActorRegistry.Service.use((registry) => registry.register({
    sessionID, actorID, mode, agent: "general", description: "receiver", contextMode: "none", background: true, lifecycle: "persistent",
  }))
const user = (sessionID: SessionID, agentID = "main"): MessageV2.User => ({
  id: MessageID.ascending(), sessionID, agentID, role: "user", agent: "general", model, time: { created: Date.now() },
})

describe("Inbox unified admission", () => {
  // inbox (c)
  it.live("prompt and agent input share a claim boundary and durable message references", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const controller = yield* Controller.Service
    const inbox = yield* Inbox.Service
    const session = yield* sessions.create()
    const message = user(session.id)
    const prompt = yield* controller.accept({ lane: { sessionID: session.id, agentID: "main" }, message,
      parts: [{ id: PartID.ascending(), sessionID: session.id, messageID: message.id, type: "text", text: "prompt input" }], type: "prompt" })
    const sent = yield* inbox.accept({ receiverSessionID: session.id, receiverActorID: "main", senderSessionID: session.id,
      senderActorID: "sender", content: "agent input" })
    const rows = Database.use((db) => db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, session.id)).all())
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.content === null && row.input_message_id !== null && row.state === "accepted")).toBe(true)
    const messages = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
    expect(MessageV2.renderedOrder(messages, rows, session.id, new Set(), () => { throw new Error("Unexpected input load") })).toEqual([])
    const claim = yield* controller.claimNext({ sessionID: session.id, agentID: "main" }, 1)
    expect(claim?.receipts.map((receipt) => receipt.inputMessageID)).toEqual([prompt.inputMessageID, sent.inputMessageID])
    expect(messages[1].info.role === "user" && messages[1].info.provenance).toEqual({ source: "agent", senderSessionID: session.id, senderActorID: "sender" })
    expect(messages[1].parts).toEqual([expect.objectContaining({ type: "text", synthetic: true,
      text: expect.stringContaining(`from="${session.id}:sender"`) })])
    const claimedRows = Database.use((db) => db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, session.id)).all())
    expect(MessageV2.renderedOrder(messages, claimedRows, session.id, new Set(claim!.receipts.map((receipt) => receipt.id)), () => { throw new Error("Unexpected input load") }))
      .toEqual(messages)
  })))

  it.live("each step claims at most the configured batch and later steps pick up remaining input", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const controller = yield* Controller.Service
    const inbox = yield* Inbox.Service
    const session = yield* sessions.create()
    for (let index = 0; index <= MAX_CLAIM_PER_STEP; index++) yield* inbox.accept({
      receiverSessionID: session.id, receiverActorID: "main", content: `input-${index}`,
    })
    const lane = { sessionID: session.id, agentID: "main" }
    const first = yield* controller.claimNext(lane, 2)
    expect(first?.receipts).toHaveLength(MAX_CLAIM_PER_STEP)
    const next = yield* controller.extendClaim(lane, 2)
    expect(next?.receipts).toHaveLength(1)
    expect(next!.receipts[0].inputMessageID > first!.receipts.at(-1)!.inputMessageID).toBe(true)
    expect(yield* controller.listAccepted(lane)).toEqual([])
  })))

  // inbox (b)
  it.live("any agent admission interrupts input observation without cancelling the receiver", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const registry = yield* ActorRegistry.Service
    const controller = yield* Controller.Service
    const inbox = yield* Inbox.Service
    const session = yield* sessions.create()
    const lane = { sessionID: session.id, agentID: "main" }
    const before = yield* controller.observeInput(lane, -1)
    const wait = yield* controller.observeInput(lane, before).pipe(Effect.forkChild)
    yield* inbox.accept({ receiverSessionID: session.id, receiverActorID: "main", type: "actor_notification", content: "child completed" })
    expect(yield* Fiber.join(wait)).toBe(before + 1)
    expect((yield* registry.get(session.id, "main"))?.lastOutcome).toBeUndefined()
  })))

  // inbox (i)
  it.live("coordinating main resolves only its own slice while standing peers search across slices", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const registry = yield* ActorRegistry.Service
    const inbox = yield* Inbox.Service
    const session = yield* sessions.create()
    yield* sessions.updateMessage(user(session.id, "child"))
    expect(yield* resolveDrainSeed(sessions, registry, session.id, "main")).toBeUndefined()
    const notification = yield* inbox.accept({ receiverSessionID: session.id, receiverActorID: "main", content: "child completed", type: "actor_notification" })
    const main = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
    expect(main[0].info.id).toBe(notification.inputMessageID)
    expect(main[0].info.agent).toBe("system")
    expect(yield* resolveDrainSeed(sessions, registry, session.id, "main")).toBeUndefined()
    yield* register(session.id, "peer", "peer")
    expect(yield* resolveDrainSeed(sessions, registry, session.id, "peer")).toEqual({ agent: "general", model })
  })))

  it.live("AdmissionGuard rejects cancelled and stale input before writing messages", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const controller = yield* Controller.Service
    const inbox = yield* Inbox.Service
    const session = yield* sessions.create()
    const input = { receiverSessionID: session.id, receiverActorID: "main", content: "guarded" }
    const cancelled = yield* inbox.accept(input, { isCancelled: () => true }).pipe(Effect.exit)
    expect(cancelled._tag).toBe("Failure")
    const epoch = yield* controller.getEpoch(session.id)
    yield* controller.abortSession(session.id)
    const stale = yield* inbox.accept(input, { expectedEpoch: epoch }).pipe(Effect.exit)
    expect(stale._tag).toBe("Failure")
    expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
    expect(yield* controller.observeInput({ sessionID: session.id, agentID: "main" }, -1)).toBe(0)
  })))

  it.live("terminal notifications during stop are admitted then settled without execution", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const controller = yield* Controller.Service
    const inbox = yield* Inbox.Service
    const session = yield* sessions.create()
    const notification = yield* controller.withStop(session.id, Effect.gen(function* () {
      yield* controller.abortSession(session.id)
      const notification = yield* inbox.accept({ receiverSessionID: session.id, receiverActorID: "main", type: "actor_notification", content: "cancelled" })
      expect((yield* controller.getReceipt(notification.inboxID)).state).toBe("accepted")
      expect(yield* controller.claimNext({ sessionID: session.id, agentID: "main" }, 3)).toBeUndefined()
      return notification
    }))
    const receipt = yield* controller.getReceipt(notification.inboxID)
    expect(receipt.state).toBe("cancelled")
    expect(receipt.outcome).toBe("never_ran")
    expect(yield* controller.observeInput(receipt.lane, -1)).toBe(1)
    expect(yield* controller.claimNext(receipt.lane, 3)).toBeUndefined()
    expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(1)
  })))
})
