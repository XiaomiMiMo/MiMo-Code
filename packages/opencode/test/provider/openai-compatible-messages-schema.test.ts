import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "../../src/provider"
import type { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// #2116: SenseNova (and other Python OpenAI-compatible backends) iterate
// `messages` / `function.arguments` with `.items()`. A primitive tool-call
// input serializes as `"0"`, parses back as int, and 400s every model in the
// session. Subagent spawn concatenates a frozen inheritedMessages snapshot
// with the child's own turn — that assembly is what this file asserts.

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("sensenova")

const compatibleModel: Provider.Model = {
  id: ModelID.make("deepseek-v4-flash"),
  providerID,
  api: {
    id: "deepseek-v4-flash",
    url: "https://example.invalid/v1",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "deepseek-v4-flash",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id: MessageID.make(id),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID, modelID: compatibleModel.id },
  } as MessageV2.User
}

function assistantInfo(id: string, parentID: string): MessageV2.Assistant {
  return {
    id: MessageID.make(id),
    sessionID,
    role: "assistant",
    parentID: MessageID.make(parentID),
    time: { created: 1 },
    agent: "build",
    modelID: compatibleModel.id,
    providerID,
    mode: "",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return { id: PartID.make(id), sessionID, messageID: MessageID.make(messageID) }
}

const OPENAI_REPLY = {
  id: "1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

async function outbound(prompt: unknown) {
  let captured: { messages?: unknown[] } | undefined
  const provider = createOpenAICompatible({
    name: "sensenova",
    baseURL: "https://example.invalid/v1",
    apiKey: "test-key",
    fetch: (async (_url: unknown, init: { body: string }) => {
      captured = JSON.parse(init.body)
      return new Response(JSON.stringify(OPENAI_REPLY), { headers: { "content-type": "application/json" } })
    }) as never,
  })
  await provider("deepseek-v4-flash").doGenerate({ prompt } as never)
  return captured!
}

function parsedArguments(messages: unknown[]) {
  return messages.flatMap((msg) => {
    if (!msg || typeof msg !== "object") return []
    const toolCalls = (msg as { tool_calls?: { function?: { arguments?: string } }[] }).tool_calls
    if (!Array.isArray(toolCalls)) return []
    return toolCalls.map((call) => {
      const raw = call.function?.arguments
      return raw === undefined ? undefined : JSON.parse(raw)
    })
  })
}

describe("openai-compatible messages schema (issue #2116)", () => {
  test("CONTROL: a numeric tool-call input ships as arguments JSON number without the transform", async () => {
    const body = await outbound([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: 0 }],
      },
    ])
    expect(parsedArguments(body.messages ?? [])).toEqual([0])
  })

  test("subagent spawn assembly: every message is a dict and every tool-call arguments value is a mapping", async () => {
    const parent: MessageV2.WithParts[] = [
      {
        info: userInfo("m-user"),
        parts: [{ ...basePart("m-user", "u1"), type: "text", text: "use a subagent" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", "m-user"),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "tool",
            callID: "call-num",
            tool: "bash",
            state: {
              status: "completed",
              input: 0 as never,
              output: "ok",
              title: "",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const inherited = await MessageV2.toModelMessages(parent, compatibleModel)
    const ownNew: typeof inherited = [{ role: "user", content: [{ type: "text", text: "child task" }] }]
    // prompt.ts fork path: [...forkCtx.inheritedMessages, ...ownNewModelMsgs]
    const assembled = [...inherited, ...ownNew, 0 as never]
    const transformed = ProviderTransform.message(assembled, compatibleModel, {})
    const body = await outbound(transformed)

    expect(Array.isArray(body.messages)).toBe(true)
    for (const msg of body.messages ?? []) {
      expect(msg && typeof msg === "object" && !Array.isArray(msg)).toBe(true)
      expect(typeof (msg as { role?: unknown }).role).toBe("string")
    }
    for (const args of parsedArguments(body.messages ?? [])) {
      expect(args !== null && typeof args === "object" && !Array.isArray(args)).toBe(true)
    }
  })

  test("ProviderTransform.message drops a stray int in the messages list", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      0,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ] as never
    const result = ProviderTransform.message(msgs, compatibleModel, {})
    expect(result.every((msg) => msg && typeof msg === "object" && typeof msg.role === "string")).toBe(true)
    expect(result.some((msg) => (msg as unknown) === 0)).toBe(false)
  })

  test("ProviderTransform.message wraps a primitive tool-call input", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: 0 }],
      },
    ] as never
    const result = ProviderTransform.message(msgs, compatibleModel, {})
    const assistant = result.find((msg) => msg.role === "assistant")
    const call = Array.isArray(assistant?.content)
      ? assistant.content.find((part) => (part as { type?: string }).type === "tool-call")
      : undefined
    expect((call as { input?: unknown } | undefined)?.input).toEqual({ value: 0 })
  })
})
