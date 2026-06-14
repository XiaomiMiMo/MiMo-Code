import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { buildLLMRequestPrefix } from "../../src/session/llm-request-prefix"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import type { Agent } from "../../src/agent/agent"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function makeAgent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
}

describe("buildLLMRequestPrefix", () => {
  test("two consecutive calls with identical inputs produce deep-equal output", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Create a session
        const session = await AppRuntime.runPromise(
          SessionNs.Service.use((svc) => svc.create({})),
        )

        // Insert a user message
        const userID = MessageID.ascending()
        await AppRuntime.runPromise(
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
        await AppRuntime.runPromise(
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

        const msgs = await AppRuntime.runPromise(
          SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })),
        )

        // Use a fake model so no real provider config is required
        const model = ProviderTest.model({
          id: ModelID.make("gpt-5.2"),
          providerID: ProviderID.make("openai"),
        })
        const agent = makeAgent()

        // Call twice with identical inputs
        const a = await AppRuntime.runPromise(
          buildLLMRequestPrefix({
            sessionID: session.id,
            agent,
            model,
            msgs,
            additions: [],
          }),
        )
        const b = await AppRuntime.runPromise(
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
      },
    })
  })

  test("inheritedMessages grows monotonically and prefix-aligns as msgs grow", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(
          SessionNs.Service.use((svc) => svc.create({})),
        )

        // Build 3 messages (user + asst + asst) so msgs has length 3 at end
        for (let i = 0; i < 3; i++) {
          const id = MessageID.ascending()
          const role = i === 0 ? "user" : "assistant"
          await AppRuntime.runPromise(
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
          await AppRuntime.runPromise(
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

        const allMsgs = await AppRuntime.runPromise(
          SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })),
        )
        const agent = makeAgent()
        const model = ProviderTest.model()

        // Simulate three runLoop iterations: msgs grows 1 → 2 → 3
        const r1 = await AppRuntime.runPromise(
          buildLLMRequestPrefix({
            sessionID: session.id,
            agent,
            model,
            msgs: allMsgs.slice(0, 1),
            additions: [],
          }),
        )
        const r2 = await AppRuntime.runPromise(
          buildLLMRequestPrefix({
            sessionID: session.id,
            agent,
            model,
            msgs: allMsgs.slice(0, 2),
            additions: [],
          }),
        )
        const r3 = await AppRuntime.runPromise(
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
        expect(r2.inheritedMessages.slice(0, r1.inheritedMessages.length))
          .toEqual(r1.inheritedMessages)
        expect(r3.inheritedMessages.slice(0, r2.inheritedMessages.length))
          .toEqual(r2.inheritedMessages)
      },
    })
  })
})

describe("prefix ordering for cache optimization", () => {
  function extractSystemText(system: string[]): string {
    return system.join("\n")
  }

  function findFirstDivergence(a: string, b: string): number {
    const minLen = Math.min(a.length, b.length)
    for (let i = 0; i < minLen; i++) {
      if (a[i] !== b[i]) return i
    }
    return minLen
  }

  async function buildPrefix(dir: string, additions: string[]) {
    return await Instance.provide({
      directory: dir,
      fn: async () => {
        const session = await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create({})))
        const userID = MessageID.ascending()
        await AppRuntime.runPromise(
          SessionNs.Service.use((svc) =>
            svc.updateMessage({
              id: userID, sessionID: session.id, role: "user",
              time: { created: Date.now() }, agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
              tools: {}, mode: "",
            } as unknown as MessageV2.Info),
          ),
        )
        await AppRuntime.runPromise(
          SessionNs.Service.use((svc) =>
            svc.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: userID, type: "text", text: "hello" }),
          ),
        )
        const msgs = await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.messages({ sessionID: session.id })))
        return AppRuntime.runPromise(
          buildLLMRequestPrefix({ sessionID: session.id, agent: makeAgent(), model: ProviderTest.model(), msgs, additions }),
        )
      },
    })
  }

  test("environmentParts splits stable identity before dynamic env, and both appear in correct order in system prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await buildPrefix(tmp.path, [
      "You are MiMo Code Agent",            // stable identity
      "IMPORTANT: language rule",            // stable language
      "Skills block here",                   // skills
      "Instructions from: /proj/AGENTS.md",  // project-specific
      "Working directory: /some/path",       // dynamic env
      `Today's date: ${new Date().toDateString()}`, // dynamic env
    ])
    const text = extractSystemText(result.system)

    // Verify stable parts appear before dynamic parts
    const stableMarkers = ["You are MiMo Code Agent", "IMPORTANT: language rule"]
    const dynamicMarkers = ["Working directory: /some/path", "Today's date:"]
    const lastStable = Math.max(...stableMarkers.map((m) => text.indexOf(m)))
    const firstDynamic = Math.min(...dynamicMarkers.map((m) => text.indexOf(m)))
    expect(lastStable).toBeLessThan(firstDynamic)

    // Verify all parts present
    expect(text).toContain("Skills block here")
    expect(text).toContain("Instructions from: /proj/AGENTS.md")
  })

  test("two projects with different instructions share stable prefix but diverge after it", async () => {
    await using tmpA = await tmpdir({ git: true })
    await using tmpB = await tmpdir({ git: true })

    const stable = ["You are MiMo Code Agent", "IMPORTANT: language rule"]
    const resultA = await buildPrefix(tmpA.path, [...stable, "Instructions from: /proj-a\nProject A rules", `Working directory: ${tmpA.path}`])
    const resultB = await buildPrefix(tmpB.path, [...stable, "Instructions from: /proj-b\nProject B rules", `Working directory: ${tmpB.path}`])

    const textA = extractSystemText(resultA.system)
    const textB = extractSystemText(resultB.system)

    expect(textA).not.toEqual(textB)

    const sharedPrefix = "You are MiMo Code Agent\nIMPORTANT: language rule"
    const posA = textA.indexOf(sharedPrefix)
    const posB = textB.indexOf(sharedPrefix)
    expect(posA).toBe(posB)
    expect(posA).toBeGreaterThan(-1)

    const divergeIdx = findFirstDivergence(textA, textB)
    expect(divergeIdx).toBeGreaterThan(posA + sharedPrefix.length)
  })
})
