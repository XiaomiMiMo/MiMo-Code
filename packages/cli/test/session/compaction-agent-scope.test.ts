import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import * as Compaction from "../../src/session/compaction"
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

describe("compaction scope is (session_id, agent_id)", () => {
  test("create({sessionID, agentID}) inserts a compaction-boundary part tagged with that agent_id", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        // Main thread: 3 messages (agent_id IS NULL)
        await addUser(session.id, "main-1")
        await addUser(session.id, "main-2")
        await addUser(session.id, "main-3")

        // Subagent "writer-1": 3 messages
        await addUser(session.id, "writer-msg-1", "writer-1")
        await addUser(session.id, "writer-msg-2", "writer-1")
        await addUser(session.id, "writer-msg-3", "writer-1")

        // Insert a compaction boundary scoped to writer-1.
        await Compaction.create({
          sessionID: session.id,
          agent: "compaction",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          auto: true,
          agentID: "writer-1",
        })

        // After compaction: writer-1's filterCompacted slice begins at the
        // synthetic boundary (which is also tagged with agent_id = "writer-1"),
        // skipping prior writer-1 history.
        const writerMsgs = await Effect.runPromise(
          MessageV2.filterCompactedEffect(session.id, { agentID: "writer-1" }),
        )
        // Expect: only the boundary message remains in writer-1's view
        // (filterCompacted stops at the first compaction part walking back
        // newest → oldest).
        expect(writerMsgs).toHaveLength(1)
        expect(writerMsgs[0].info.role).toBe("user")
        expect(writerMsgs[0].info.agentID).toBe("writer-1")
        const boundaryPart = writerMsgs[0].parts.find((p) => p.type === "compaction")
        expect(boundaryPart).toBeDefined()
        expect((boundaryPart as MessageV2.CompactionPart).auto).toBe(true)

        // Main agent's view (agent_id IS NULL) is untouched: still 3 messages,
        // no compaction boundary.
        const mainMsgs = await Effect.runPromise(
          MessageV2.filterCompactedEffect(session.id, { agentID: "main" }),
        )
        expect(mainMsgs).toHaveLength(3)
        expect(mainMsgs.map((m) => (m.parts[0] as MessageV2.TextPart).text)).toEqual([
          "main-1",
          "main-2",
          "main-3",
        ])
        for (const m of mainMsgs) {
          expect(m.info.agentID).toBe("main")
          expect(m.parts.some((p) => p.type === "compaction")).toBe(false)
        }

        await svc.remove(session.id)
      },
    })
  })

  test("sessions.messages with agentID returns subagent boundary; without agentID it does not", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        // Subagent "sub-1" has conversation history
        await addUser(session.id, "sub-msg-1", "sub-1")
        await addUser(session.id, "sub-msg-2", "sub-1")

        // Insert a compaction boundary scoped to sub-1
        await Compaction.create({
          sessionID: session.id,
          agent: "compaction",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          auto: true,
          agentID: "sub-1",
        })

        // With agentID: boundary is visible in the subagent's slice
        const subMsgs = await run(
          SessionNs.Service.use((s) => s.messages({ sessionID: session.id, agentID: "sub-1" })),
        )
        const boundaryInSub = subMsgs.find((m) =>
          m.parts.some((p) => p.type === "compaction"),
        )
        expect(boundaryInSub).toBeDefined()
        expect(boundaryInSub!.info.agentID).toBe("sub-1")

        // Without agentID (defaults to "main"): boundary is NOT visible.
        // This was the bug — compaction.process() used to query without
        // agentID and then failed to find the subagent's boundary.
        const mainMsgs = await run(
          SessionNs.Service.use((s) => s.messages({ sessionID: session.id })),
        )
        const boundaryInMain = mainMsgs.find((m) =>
          m.parts.some((p) => p.type === "compaction"),
        )
        expect(boundaryInMain).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("compacting writer-1 leaves writer-2's history untouched", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        await addUser(session.id, "writer-1-a", "writer-1")
        await addUser(session.id, "writer-1-b", "writer-1")
        await addUser(session.id, "writer-2-a", "writer-2")
        await addUser(session.id, "writer-2-b", "writer-2")

        await Compaction.create({
          sessionID: session.id,
          agent: "compaction",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          auto: true,
          agentID: "writer-1",
        })

        // writer-2 unchanged: 2 messages, no boundary.
        const w2Msgs = await Effect.runPromise(
          MessageV2.filterCompactedEffect(session.id, { agentID: "writer-2" }),
        )
        expect(w2Msgs).toHaveLength(2)
        expect(w2Msgs.map((m) => (m.parts[0] as MessageV2.TextPart).text)).toEqual([
          "writer-2-a",
          "writer-2-b",
        ])
        for (const m of w2Msgs) {
          expect(m.parts.some((p) => p.type === "compaction")).toBe(false)
        }

        // writer-1 is compacted: its slice now starts at the boundary.
        const w1Msgs = await Effect.runPromise(
          MessageV2.filterCompactedEffect(session.id, { agentID: "writer-1" }),
        )
        expect(w1Msgs).toHaveLength(1)
        expect(w1Msgs[0].parts.some((p) => p.type === "compaction")).toBe(true)
        expect(w1Msgs[0].info.agentID).toBe("writer-1")

        await svc.remove(session.id)
      },
    })
  })
})
