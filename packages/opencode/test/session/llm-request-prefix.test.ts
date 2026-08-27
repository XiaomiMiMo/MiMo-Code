import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { tool, jsonSchema, type Tool as AITool } from "ai"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { buildLLMRequestPrefix } from "../../src/session/llm-request-prefix"
import { ToolRegistry } from "../../src/tool"
import { MCP } from "../../src/mcp"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import type { Agent } from "../../src/agent/agent"

void Log.init({ print: false })

function makeAgent(overrides: Partial<Agent.Info> = {}): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
    ...overrides,
  } satisfies Agent.Info
}

// A stand-in MCP.Service that returns a fixed tool set, mirroring the pattern in
// prompt-effect.test.ts. `MCP.tools()` output is context-independent, so a fixed
// map faithfully reproduces what the real service hands resolveTools.
function mcpLayer(tools: (context?: MCP.TurnContext) => Record<string, AITool> = () => ({})) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      tools: (context) => Effect.sync(() => tools(context)),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth"),
      authenticate: () => Effect.die("unexpected MCP auth"),
      finishAuth: () => Effect.die("unexpected MCP auth"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

function mcpTool(description: string): AITool {
  // Real MCP tools always carry an execute closure (convertMcpTool); the prefix
  // builder mirrors resolveTools in skipping non-executable entries, so the
  // fixture must provide one to reflect a genuine connected server.
  return tool({
    description,
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () => ({ output: "" }),
  })
}

// A non-GPT model: GPT-family models route MCP through mcp-tool-search and
// collapse built-ins behind the `exec` gateway, which is not the case the dump
// showed (MiMo model listing exa_* tools directly). Use a plain id so the prefix
// enumerates built-ins and MCP tools the same way the parent request does.
function nonGptModel() {
  const id = ModelID.make("mimo-v2.5-pro")
  return ProviderTest.model({ id, api: { id, url: "https://example.com", npm: "@ai-sdk/openai" } })
}

function testLayer(mcp = mcpLayer()) {
  return Layer.mergeAll(SessionNs.defaultLayer, LLM.defaultLayer, ToolRegistry.defaultLayer, mcp)
}

async function withServices(
  directory: string,
  fn: (
    rt: ManagedRuntime.ManagedRuntime<
      SessionNs.Service | LLM.Service | ToolRegistry.Service | MCP.Service,
      never
    >,
  ) => Promise<void>,
  mcp = mcpLayer(),
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer(mcp))
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
        await Instance.dispose()
      }
    },
  })
}

async function seedUserMessage(
  rt: ManagedRuntime.ManagedRuntime<SessionNs.Service, never>,
  tools: Record<string, boolean> = {},
) {
  const session = await rt.runPromise(SessionNs.Service.use((svc) => svc.create({})))
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
        tools,
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
  return { session, msgs }
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

  test("captured prefix includes connected MCP tools (fork/checkpoint parity with parent)", async () => {
    await using tmp = await tmpdir({ git: true })
    const mcp = mcpLayer(() => ({
      exa_web_search_exa: mcpTool("Search the web"),
      exa_web_fetch_exa: mcpTool("Fetch a URL"),
    }))
    await withServices(
      tmp.path,
      async (rt) => {
        const { session, msgs } = await seedUserMessage(rt)
        const prefix = await rt.runPromise(
          buildLLMRequestPrefix({
            sessionID: session.id,
            agent: makeAgent(),
            model: nonGptModel(),
            msgs,
            additions: [],
          }),
        )
        // The two MCP tools must be present alongside the built-ins — before the
        // fix the prefix carried built-ins only, so ForkContext.tools diverged
        // from the parent's resolveTools() the moment any MCP server existed.
        expect(Object.keys(prefix.tools)).toContain("exa_web_search_exa")
        expect(Object.keys(prefix.tools)).toContain("exa_web_fetch_exa")
        expect(Object.keys(prefix.tools).length).toBeGreaterThan(2)
      },
      mcp,
    )
  })

  test("captured prefix drops MCP tools denied by the merged permission ruleset", async () => {
    await using tmp = await tmpdir({ git: true })
    const mcp = mcpLayer(() => ({
      exa_web_search_exa: mcpTool("Search the web"),
      exa_web_fetch_exa: mcpTool("Fetch a URL"),
    }))
    await withServices(
      tmp.path,
      async (rt) => {
        const { session, msgs } = await seedUserMessage(rt)
        const prefix = await rt.runPromise(
          buildLLMRequestPrefix({
            sessionID: session.id,
            agent: makeAgent({
              permission: [
                { permission: "*", pattern: "*", action: "allow" },
                { permission: "exa_web_fetch_exa", pattern: "*", action: "deny" },
              ],
            }),
            model: nonGptModel(),
            msgs,
            additions: [],
          }),
        )
        expect(Object.keys(prefix.tools)).toContain("exa_web_search_exa")
        expect(Object.keys(prefix.tools)).not.toContain("exa_web_fetch_exa")
      },
      mcp,
    )
  })

  test("captured prefix drops MCP tools toggled off for the turn", async () => {
    await using tmp = await tmpdir({ git: true })
    const mcp = mcpLayer(() => ({
      exa_web_search_exa: mcpTool("Search the web"),
      exa_web_fetch_exa: mcpTool("Fetch a URL"),
    }))
    await withServices(
      tmp.path,
      async (rt) => {
        // The prefix builder reads the per-turn toggle from the last user
        // message's `tools` map, the same field LLM.resolveTools prunes the
        // parent's wire set by — so the fork prefix drops it identically.
        const { session, msgs } = await seedUserMessage(rt, { exa_web_fetch_exa: false })
        const prefix = await rt.runPromise(
          buildLLMRequestPrefix({
            sessionID: session.id,
            agent: makeAgent(),
            model: nonGptModel(),
            msgs,
            additions: [],
          }),
        )
        expect(Object.keys(prefix.tools)).toContain("exa_web_search_exa")
        expect(Object.keys(prefix.tools)).not.toContain("exa_web_fetch_exa")
      },
      mcp,
    )
  })

  test("captured prefix omits MCP tools under the GPT/Codex toolset (parent reaches them via mcp-tool-search, not the wire)", async () => {
    await using tmp = await tmpdir({ git: true })
    const mcp = mcpLayer(() => ({
      exa_web_search_exa: mcpTool("Search the web"),
      exa_web_fetch_exa: mcpTool("Fetch a URL"),
    }))
    await withServices(
      tmp.path,
      async (rt) => {
        const { session, msgs } = await seedUserMessage(rt)
        const prefix = await rt.runPromise(
          buildLLMRequestPrefix({
            sessionID: session.id,
            agent: makeAgent(),
            // Default ProviderTest model id is "gpt-5.2" → usesGPTToolset === true.
            model: ProviderTest.model(),
            msgs,
            additions: [],
          }),
        )
        // Under the GPT toolset MCP tools never enter activeTools (they go through
        // mcp-tool-search), so the parent emits zero MCP definitions on the wire.
        // The prefix must match — listing them here would re-break cache parity.
        expect(Object.keys(prefix.tools)).not.toContain("exa_web_search_exa")
        expect(Object.keys(prefix.tools)).not.toContain("exa_web_fetch_exa")
      },
      mcp,
    )
  })
})
