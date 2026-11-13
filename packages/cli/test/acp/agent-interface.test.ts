import { describe, expect, test } from "bun:test"
import { ACP } from "../../src/acp/agent"
import type { ACPConfig } from "../../src/acp/types"
import type { Agent as ACPAgent, AgentSideConnection } from "@agentclientprotocol/sdk"

/**
 * Type-level test: This line will fail to compile if ACP.Agent
 * doesn't properly implement the ACPAgent interface.
 *
 * The SDK checks for methods like `agent.unstable_setSessionModel` at runtime
 * and throws "Method not found" if they're missing. TypeScript allows optional
 * interface methods to be omitted, but the SDK still expects them.
 *
 * @see https://github.com/agentclientprotocol/typescript-sdk/commit/7072d3f
 */
type _AssertAgentImplementsACPAgent = ACP.Agent extends ACPAgent ? true : never
const _typeCheck: _AssertAgentImplementsACPAgent = true

/**
 * Runtime verification that optional methods the SDK expects are actually implemented.
 * The SDK's router checks `if (!agent.methodName)` and throws MethodNotFound if missing.
 */
describe("acp.agent interface compliance", () => {
  // Extract method names from the ACPAgent interface type
  type ACPAgentMethods = keyof ACPAgent

  // Methods that the SDK's router explicitly checks for at runtime
  const sdkCheckedMethods: ACPAgentMethods[] = [
    // Required
    "initialize",
    "newSession",
    "prompt",
    "cancel",
    // Optional but checked by SDK router
    "loadSession",
    "setSessionMode",
    "authenticate",
    // Unstable - SDK checks these with unstable_ prefix
    "listSessions",
    "unstable_forkSession",
    "unstable_resumeSession",
    "unstable_setSessionModel",
  ]

  test("Agent implements all SDK-checked methods", () => {
    for (const method of sdkCheckedMethods) {
      expect(typeof ACP.Agent.prototype[method as keyof typeof ACP.Agent.prototype], `Missing method: ${method}`).toBe(
        "function",
      )
    }
  })
})

describe("acp.agent initialize", () => {
  // initialize only reads its params; the SDK is touched solely by the event
  // subscription the constructor starts, so hand it a stream that never yields.
  const sdk = {
    global: {
      event: async () => ({
        stream: (async function* () {
          await new Promise(() => {})
        })(),
      }),
    },
  } as unknown as ACPConfig["sdk"]
  const agent = new ACP.Agent({} as AgentSideConnection, { sdk })

  test("advertises a login method that names the mimo binary", async () => {
    const result = await agent.initialize({ protocolVersion: 1 })
    expect(result.authMethods?.[0]?.description).toBe("Run `mimo auth login` in the terminal")
  })

  test("launches mimo, not opencode, for terminal-auth clients", async () => {
    const result = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { _meta: { "terminal-auth": true } },
    })
    expect(result.authMethods?.[0]?._meta?.["terminal-auth"]).toMatchObject({
      command: "mimo",
      args: ["auth", "login"],
    })
  })
})
