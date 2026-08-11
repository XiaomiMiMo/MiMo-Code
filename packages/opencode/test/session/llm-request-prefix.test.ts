import { describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { buildLLMRequestPrefix } from "../../src/session/llm-request-prefix"
import { ToolRegistry } from "../../src/tool"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import type { Agent } from "../../src/agent/agent"

void Log.init({ print: false })

function makeAgent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
}

const testLayer = Layer.mergeAll(SessionNs.defaultLayer, LLM.defaultLayer, ToolRegistry.defaultLayer)

async function withServices(
  directory: string,
  fn: (
    rt: ManagedRuntime.ManagedRuntime<SessionNs.Service | LLM.Service | ToolRegistry.Service, never>,
  ) => Promise<void>,
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
        await Instance.dispose()
      }
    },
  })
}

describe("buildLLMRequestPrefix", () => {
  test.skip("two consecutive calls with identical inputs produce deep-equal output", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      // Create a session
      const session = await rt.runPromise(SessionNs.Service.use((svc) => svc.create({})))

      // Insert a user message
      const userID = MessageID.ascending()
      await rt.runPromise(
        SessionNs.Service.use((svc) =>
          svc.updateMessage({
            id: userID,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info),
        ),
      )
      await rt.runPromise(
        SessionNs.Service.use((svc) =>
          svc.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: userID,
            type: "text",
            text: "hello",
          }),
        ),
      )

      const msgs = await rt.runPromise(SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })))

      // Use a fake model so no real provider config is required
      const model = ProviderTest.model({
        id: ModelID.make("gpt-5.2"),
        providerID: ProviderID.make("openai"),
      })
      const agent = makeAgent()

      // Call twice with identical inputs
      const a = await rt.runPromise(
        buildLLMRequestPrefix({
          sessionID: session.id,
          agent,
          model,
          msgs,
          additions: [],
        }),
      )
      const b = await rt.runPromise(
        buildLLMRequestPrefix({
          sessionID: session.id,
          agent,
          model,
          msgs,
          additions: [],
        }),
      )

      expect(a.system).toEqual(b.system)
      expect(JSON.stringify(a.tools)).toEqual(JSON.stringify(b.tools))
      expect(a.inheritedMessages).toEqual(b.inheritedMessages)
    })
  })

  test.skip("inheritedMessages grows monotonically and prefix-aligns as msgs grow", async () => {
    await using tmp = await tmpdir({ git: true })
    await withServices(tmp.path, async (rt) => {
      const session = await rt.runPromise(SessionNs.Service.use((svc) => svc.create({})))

      // Build 3 messages (user + asst + asst) so msgs has length 3 at end
      for (let i = 0; i < 3; i++) {
        const id = MessageID.ascending()
        const role = i === 0 ? "user" : "assistant"
        await rt.runPromise(
          SessionNs.Service.use((svc) =>
            svc.updateMessage({
              id,
              sessionID: session.id,
              role,
              time: { created: Date.now() + i },
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
              tools: {},
              mode: "",
            } as unknown as MessageV2.Info),
          ),
        )
        await rt.runPromise(
          SessionNs.Service.use((svc) =>
            svc.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: id,
              type: "text",
              text: `m${i}`,
            }),
          ),
        )
      }

      const allMsgs = await rt.runPromise(SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })))
      const agent = makeAgent()
      const model = ProviderTest.model()

      // Simulate three runLoop iterations: msgs grows 1 → 2 → 3
      const r1 = await rt.runPromise(
        buildLLMRequestPrefix({
          sessionID: session.id,
          agent,
          model,
          msgs: allMsgs.slice(0, 1),
          additions: [],
        }),
      )
      const r2 = await rt.runPromise(
        buildLLMRequestPrefix({
          sessionID: session.id,
          agent,
          model,
          msgs: allMsgs.slice(0, 2),
          additions: [],
        }),
      )
      const r3 = await rt.runPromise(
        buildLLMRequestPrefix({
          sessionID: session.id,
          agent,
          model,
          msgs: allMsgs.slice(0, 3),
          additions: [],
        }),
      )

      // Monotonic length growth
      expect(r1.inheritedMessages.length).toBeLessThan(r2.inheritedMessages.length)
      expect(r2.inheritedMessages.length).toBeLessThan(r3.inheritedMessages.length)

      // Full prefix containment — earlier results are prefixes of later ones.
      // This catches re-introduction of slicing (which would chop the early
      // messages) and confirms toModelMessages output is deterministic for
      // a stable msgs prefix.
      expect(r2.inheritedMessages.slice(0, r1.inheritedMessages.length)).toEqual(r1.inheritedMessages)
      expect(r3.inheritedMessages.slice(0, r2.inheritedMessages.length)).toEqual(r2.inheritedMessages)
    })
  })
})
