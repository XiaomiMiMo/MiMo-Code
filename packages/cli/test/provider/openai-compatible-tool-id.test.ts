import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test"
import { stepCountIs, streamText, tool } from "ai"
import z from "zod"

const commonJS: typeof import("@ai-sdk/openai-compatible") = createRequire(import.meta.url)("@ai-sdk/openai-compatible")

function response(deltas: unknown[][]) {
  return new Response(
    [
      ...deltas.map((tool_calls) => ({ choices: [{ delta: { tool_calls } }] })),
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe.each([
  ["ESM", createOpenAICompatible],
  ["CommonJS", commonJS.createOpenAICompatible],
] as const)("openai-compatible tool IDs (%s)", (_format, create) => {
  async function stream(deltas: unknown[][]) {
    const result = await create({
      name: "test",
      baseURL: "https://example.test/v1",
      fetch: Object.assign(async () => response(deltas), { preconnect: fetch.preconnect }),
    })("test/model").doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Read the file." }] }] })
    return convertReadableStreamToArray(result.stream)
  }

  test.each([undefined, null, ""])("generates one stable ID when the upstream ID is %s", async (id) => {
    const parts = await stream([
      [{ index: 0, id, function: { name: "read", arguments: '{"path":' } }],
      [{ index: 0, function: { arguments: '"/tmp/example"}' } }],
    ])
    const call = parts.find((part) => part.type === "tool-call")
    if (!call) throw new Error("Expected a tool call")
    expect(typeof call.toolCallId).toBe("string")
    expect(call.toolCallId).not.toBe("")
    expect(call.toolName).toBe("read")
    expect(call.input).toBe('{"path":"/tmp/example"}')
    expect(parts.filter((part) => part.type.startsWith("tool-input"))).toEqual([
      { type: "tool-input-start", id: call.toolCallId, toolName: "read" },
      { type: "tool-input-delta", id: call.toolCallId, delta: '{"path":"/tmp/example"}' },
      { type: "tool-input-end", id: call.toolCallId },
    ])
  })

  test("uses a late upstream ID without losing buffered arguments", async () => {
    const parts = await stream([
      [{ index: 0, function: { name: "read", arguments: '{"path":' } }],
      [{ index: 0, id: "call_late", function: { arguments: '"/tmp/example"' } }],
      [{ index: 0, function: { arguments: "}" } }],
    ])
    expect(parts.filter((part) => part.type.startsWith("tool-"))).toEqual([
      { type: "tool-input-start", id: "call_late", toolName: "read" },
      { type: "tool-input-delta", id: "call_late", delta: '{"path":"/tmp/example"' },
      { type: "tool-input-delta", id: "call_late", delta: "}" },
      { type: "tool-input-end", id: "call_late" },
      { type: "tool-call", toolCallId: "call_late", toolName: "read", input: '{"path":"/tmp/example"}' },
    ])
  })

  test("buffers an empty opener until the ID and name arrive", async () => {
    const parts = await stream([
      [{ index: 0, id: null, function: { name: null, arguments: "" } }],
      [{ index: 0, id: "call_late", function: { name: "read", arguments: "{}" } }],
    ])
    expect(parts.filter((part) => part.type === "tool-call")).toEqual([
      { type: "tool-call", toolCallId: "call_late", toolName: "read", input: "{}" },
    ])
  })

  test("keeps interleaved indexed calls separate", async () => {
    const parts = await stream([
      [
        { index: 2, function: { name: "read", arguments: '{"path":' } },
        { index: 0, function: { name: "read", arguments: '{"path":' } },
      ],
      [{ index: 0, id: "call_first", function: { arguments: '"/tmp/example/first"}' } }],
      [{ index: 2, function: { arguments: '"/tmp/example/second"}' } }],
    ])
    const calls = parts.filter((part) => part.type === "tool-call")
    expect(calls.map((call) => ({ toolName: call.toolName, input: call.input }))).toEqual([
      { toolName: "read", input: '{"path":"/tmp/example/first"}' },
      { toolName: "read", input: '{"path":"/tmp/example/second"}' },
    ])
    expect(calls[0]?.toolCallId).toBe("call_first")
    expect(typeof calls[1]?.toolCallId).toBe("string")
    expect(calls[1]?.toolCallId).not.toBe("")
    expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(2)
    expect(parts.filter((part) => part.type === "tool-input-start")).toHaveLength(2)
    expect(parts.filter((part) => part.type === "tool-input-end")).toHaveLength(2)
  })

  test("preserves ordinary streaming IDs and arguments", async () => {
    const parts = await stream([
      [{ index: 0, id: "call_original", function: { name: "read", arguments: '{"path":' } }],
      [{ index: 0, function: { arguments: '"/tmp/example"}' } }],
    ])
    expect(parts.filter((part) => part.type.startsWith("tool-"))).toEqual([
      { type: "tool-input-start", id: "call_original", toolName: "read" },
      { type: "tool-input-delta", id: "call_original", delta: '{"path":' },
      { type: "tool-input-delta", id: "call_original", delta: '"/tmp/example"}' },
      { type: "tool-input-end", id: "call_original" },
      { type: "tool-call", toolCallId: "call_original", toolName: "read", input: '{"path":"/tmp/example"}' },
    ])
  })

  test("still rejects a tool call that never supplies a name", async () => {
    await expect(stream([[{ index: 0, id: "call_invalid", function: { arguments: "{}" } }]])).rejects.toThrow(
      "Expected 'function.name' to be a string.",
    )
  })

  test("still rejects a non-string upstream ID", async () => {
    const parts = await stream([[{ index: 0, id: 123, function: { name: "read", arguments: "{}" } }]])
    expect(parts.filter((part) => part.type === "error")).toHaveLength(1)
    expect(parts.filter((part) => part.type.startsWith("tool-"))).toEqual([])
  })

  test("preserves complete calls from providers that omit indexes", async () => {
    const parts = await stream([
      [{ id: "call_first", function: { name: "read", arguments: "{}" } }],
      [{ id: "call_second", function: { name: "read", arguments: "{}" } }],
    ])
    expect(parts.filter((part) => part.type === "tool-call")).toEqual([
      { type: "tool-call", toolCallId: "call_first", toolName: "read", input: "{}" },
      { type: "tool-call", toolCallId: "call_second", toolName: "read", input: "{}" },
    ])
  })

  test("preserves argument snapshots and thought signatures while waiting for an ID", async () => {
    const parts = await stream([
      [
        {
          index: 0,
          function: { name: "read", arguments: "{}" },
          extra_content: { google: { thought_signature: "test-signature" } },
        },
      ],
      [{ index: 0, function: { arguments: '{"path":"/tmp/example"}' } }],
      [{ index: 0, id: "call_late", function: { arguments: "" } }],
    ])
    expect(parts.filter((part) => part.type === "tool-call")).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_late",
        toolName: "read",
        input: '{"path":"/tmp/example"}',
        providerMetadata: { test: { thoughtSignature: "test-signature" } },
      },
    ])
  })

  test("executes the tool and sends the same generated ID with its result", async () => {
    const requests: Array<{
      messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>
    }> = []
    const inputs: string[] = []
    const provider = create({
      name: "test",
      baseURL: "https://example.test/v1",
      fetch: Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)))
          if (requests.length === 1) {
            return response([[{ index: 0, function: { name: "read", arguments: '{"path":"/tmp/example"}' } }]])
          }
          return new Response(
            'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          )
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const result = streamText({
      model: provider("test/model"),
      prompt: "Read the file.",
      maxRetries: 0,
      stopWhen: stepCountIs(2),
      tools: {
        read: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async (input) => {
            inputs.push(input.path)
            return "file contents"
          },
        }),
      },
    })
    expect(await result.text).toBe("Done.")
    expect(inputs).toEqual(["/tmp/example"])
    expect(requests).toHaveLength(2)
    const id = requests[1].messages.find((message) => message.role === "assistant")?.tool_calls?.[0].id
    expect(id).toEqual(expect.any(String))
    expect(id).not.toBe("")
    expect(requests[1].messages.find((message) => message.role === "tool")?.tool_call_id).toBe(id)
  })
})
