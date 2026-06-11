import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"

const root = path.join(__dirname, "../..")
void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((s) => s.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((s) => s.remove(id)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((s) => s.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((s) => s.updatePart(part)))
  },
}

async function addUser(sessionID: SessionID, text: string, agentID?: string) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    agentID,
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  await svc.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  })
  return id
}

describe("MessageV2.filterCompactedEffect agent_id filter", () => {
  test("undefined agentID returns main-slice messages only (default contract)", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await addUser(session.id, "main-1")
        await addUser(session.id, "actor-a", "actor-a-1")
        await addUser(session.id, "main-2")
        await addUser(session.id, "actor-b", "actor-b-1")

        const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(session.id))
        expect(msgs).toHaveLength(2)
        expect(msgs.map((m) => (m.parts[0] as MessageV2.TextPart).text)).toEqual(["main-1", "main-2"])
        for (const m of msgs) expect(m.info.agentID).toBe("main")

        await svc.remove(session.id)
      },
    })
  })

  test('agentID: "*" returns every slice (explicit full-stream opt-out)', async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await addUser(session.id, "main-1")
        await addUser(session.id, "actor-a", "actor-a-1")
        await addUser(session.id, "main-2")
        await addUser(session.id, "actor-b", "actor-b-1")

        const msgs = await Effect.runPromise(
          MessageV2.filterCompactedEffect(session.id, { agentID: "*" }),
        )
        expect(msgs).toHaveLength(4)
        expect(msgs.map((m) => (m.parts[0] as MessageV2.TextPart).text)).toEqual([
          "main-1",
          "actor-a",
          "main-2",
          "actor-b",
        ])

        await svc.remove(session.id)
      },
    })
  })

  test("'main' agentID returns only main's messages", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await addUser(session.id, "main-1")
        await addUser(session.id, "actor-a", "actor-a-1")
        await addUser(session.id, "main-2")
        await addUser(session.id, "actor-b", "actor-b-1")

        const msgs = await Effect.runPromise(
          MessageV2.filterCompactedEffect(session.id, { agentID: "main" }),
        )
        expect(msgs).toHaveLength(2)
        expect(msgs.map((m) => (m.parts[0] as MessageV2.TextPart).text)).toEqual(["main-1", "main-2"])
        for (const m of msgs) {
          expect(m.info.agentID).toBe("main")
        }

        await svc.remove(session.id)
      },
    })
  })

  test("specific actor agentID returns only that actor's messages", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await addUser(session.id, "main-1")
        await addUser(session.id, "actor-a-msg-1", "actor-a-1")
        await addUser(session.id, "main-2")
        await addUser(session.id, "actor-a-msg-2", "actor-a-1")
        await addUser(session.id, "actor-b", "actor-b-1")

        const msgs = await Effect.runPromise(
          MessageV2.filterCompactedEffect(session.id, { agentID: "actor-a-1" }),
        )
        expect(msgs).toHaveLength(2)
        expect(msgs.map((m) => (m.parts[0] as MessageV2.TextPart).text)).toEqual([
          "actor-a-msg-1",
          "actor-a-msg-2",
        ])
        for (const m of msgs) {
          expect(m.info.agentID).toBe("actor-a-1")
        }

        await svc.remove(session.id)
      },
    })
  })

  test("inherited parent context filters to main thread (agent_id IS NULL)", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const parent = await svc.create({})
        // Mix main-thread and other-actor messages on the parent.
        const parentMain1 = await addUser(parent.id, "parent-main-1")
        await addUser(parent.id, "parent-other-actor", "other-actor-1")
        const parentMain2 = await addUser(parent.id, "parent-main-2")

        const child = await svc.create({
          parentID: parent.id,
          contextFrom: parent.id,
          contextWatermark: parentMain2,
        })
        // Child has its own messages.
        await addUser(child.id, "child-1")

        const msgs = await Effect.runPromise(
          MessageV2.filterCompactedEffect(child.id, {
            contextFrom: parent.id,
            contextWatermark: parentMain2,
          }),
        )

        // Inherited parent messages are scoped to main thread; the
        // other-actor message must be excluded. Plus the child's own
        // message at the end.
        expect(msgs).toHaveLength(3)
        expect(msgs.map((m) => (m.parts[0] as MessageV2.TextPart).text)).toEqual([
          "parent-main-1",
          "parent-main-2",
          "child-1",
        ])
        expect(msgs[0].info.id).toBe(parentMain1)
        expect(msgs[1].info.id).toBe(parentMain2)

        await svc.remove(child.id)
        await svc.remove(parent.id)
      },
    })
  })
})
