import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { wrapLanguageModel } from "ai"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { ProviderTransform } from "../../src/provider"
import { ProviderTest } from "../fake/provider"
import { ModelID } from "../../src/provider/schema"
import { openAIExecMiddleware } from "../../src/provider/openai-exec"

test("[TP-R11-05] standard Responses round-trips exec, image output, phase and encrypted reasoning", async () => {
  const code = 'text("line 1\\nline 2");\ntext("done")'
  const tools = [
    {
      type: "function" as const,
      name: "exec",
      description: "Run JavaScript",
      inputSchema: { type: "object" as const, properties: { code: { type: "string" as const } }, required: ["code"] },
    },
  ]
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_test", encrypted_content: "test-encrypted" },
    },
    {
      type: "response.reasoning_summary_part.added",
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      delta: "Check the file.",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_test",
        encrypted_content: "test-encrypted",
        summary: [{ type: "summary_text", text: "Check the file." }],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_test", phase: "commentary" },
    },
    { type: "response.output_text.delta", item_id: "msg_test", delta: "Checking now." },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "message", id: "msg_test", phase: "commentary" },
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { type: "custom_tool_call", id: "ct_test", call_id: "call_test", name: "exec", input: "" },
    },
    ...[code.slice(0, 7), code.slice(7)].map((delta) => ({
      type: "response.custom_tool_call_input.delta",
      output_index: 2,
      item_id: "ct_test",
      delta,
    })),
    {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        type: "custom_tool_call",
        id: "ct_test",
        call_id: "call_test",
        name: "exec",
        input: code,
        status: "completed",
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 6 } } },
  ]
  const bodies: Record<string, unknown>[] = []
  const sdk = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    fetch: (async (url, init) => {
      expect(String(url)).toBe("https://example.test/v1/responses")
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      })
    }) as typeof fetch,
  })
  const model = wrapLanguageModel({ model: sdk.responses("test-model"), middleware: openAIExecMiddleware })
  const options = {
    tools,
    providerOptions: ProviderTransform.providerOptions(
      ProviderTest.model({
        id: ModelID.make("mimo-test"),
        api: { id: "mimo-test", npm: "@ai-sdk/openai", url: "https://example.test/v1" },
      }),
      {},
    ),
  }
  const response = await model.doStream({
    ...options,
    prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
  })
  const parts: LanguageModelV3StreamPart[] = []
  const reader = response.stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    parts.push(next.value)
  }
  expect(parts.filter((p) => p.type === "error")).toEqual([])
  expect(bodies[0].reasoning).toEqual({ summary: "auto" })
  expect(bodies[0].include).toContain("reasoning.encrypted_content")
  expect(bodies[0].tools).toEqual([{ type: "custom", name: "exec", description: "Run JavaScript" }])
  const call = parts.find((p) => p.type === "tool-call")!
  if (call.type !== "tool-call") throw new Error("missing exec")
  expect(JSON.parse(call.input)).toEqual({ code })
  expect(
    JSON.parse(
      parts
        .filter((p) => p.type === "tool-input-delta")
        .map((p) => p.delta)
        .join(""),
    ),
  ).toEqual({ code })
  const text = parts.find((p) => p.type === "text-end")!
  expect(text.providerMetadata?.openai?.phase).toBe("commentary")
  const reasoning = parts.find((p) => p.type === "reasoning-end")!
  expect(reasoning.providerMetadata?.openai?.reasoningEncryptedContent).toBe("test-encrypted")
  const next = await model.doStream({
    ...options,
    prompt: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Check the file.", providerOptions: reasoning.providerMetadata },
          { type: "text", text: "Checking now.", providerOptions: text.providerMetadata },
          {
            type: "tool-call",
            toolName: "exec",
            toolCallId: "call_test",
            input: { code },
            providerOptions: call.providerMetadata,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "exec",
            toolCallId: "call_test",
            output: {
              type: "content",
              value: [
                { type: "text", text: "done" },
                { type: "image-data", data: "dGVzdA==", mediaType: "image/png" },
              ],
            },
          },
        ],
      },
    ],
  })
  await next.stream.pipeTo(new WritableStream({ write() {} }))
  expect(bodies[1].input).toContainEqual(expect.objectContaining({ type: "custom_tool_call", input: code }))
  expect(bodies[1].input).toContainEqual(expect.objectContaining({ role: "assistant", phase: "commentary" }))
  expect(bodies[1].input).toContainEqual(
    expect.objectContaining({ type: "reasoning", encrypted_content: "test-encrypted" }),
  )
  expect(bodies[1].input).toContainEqual(
    expect.objectContaining({
      type: "custom_tool_call_output",
      output: [
        { type: "input_text", text: "done" },
        { type: "input_image", image_url: "data:image/png;base64,dGVzdA==" },
      ],
    }),
  )
})

test("standard Responses keeps direct tools and adapts non-streaming exec", async () => {
  const bodies: Record<string, unknown>[] = []
  const sdk = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        id: "resp_test",
        created_at: 1,
        model: "test-model",
        output: [
          {
            type: "custom_tool_call",
            id: "ct_test",
            call_id: "call_test",
            name: "exec",
            input: 'text("ok")',
            status: "completed",
          },
          {
            type: "function_call",
            id: "fn_test",
            call_id: "call_direct",
            name: "cua_repl_js",
            arguments: '{"code":"await cua.getState()"}',
            status: "completed",
          },
        ],
        usage: { input_tokens: 4, output_tokens: 6 },
      })
    }) as typeof fetch,
  })
  const model = wrapLanguageModel({ model: sdk.responses("test-model"), middleware: openAIExecMiddleware })
  const result = await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    tools: ["exec", "cua_repl_js"].map((name) => ({
      type: "function" as const,
      name,
      inputSchema: { type: "object", properties: { code: { type: "string" } } },
    })),
    toolChoice: { type: "tool", toolName: "exec" },
  })
  expect(bodies[0].tool_choice).toEqual({ type: "custom", name: "exec" })
  expect(bodies[0].tools).toContainEqual(expect.objectContaining({ type: "function", name: "cua_repl_js" }))
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: "tool-call", toolName: "exec", input: '{"code":"text(\\"ok\\")"}' }),
  )
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: "tool-call", toolName: "cua_repl_js", input: '{"code":"await cua.getState()"}' }),
  )
})

test("[TP-R11-06] standard SDK preserves explicit end_turn and opt-in plaintext reasoning", async () => {
  for (const allowUnencryptedReasoning of [false, true]) {
    for (const endTurn of [false, true, undefined]) {
      const bodies: Record<string, unknown>[] = []
      const sdk = createOpenAI({
        apiKey: "test-key",
        fetch: (async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          bodies.push(body)
          const response = {
            id: "resp_boundary",
            end_turn: endTurn,
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }
          return body.stream
            ? new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
                headers: { "Content-Type": "text/event-stream" },
              })
            : Response.json(response)
        }) as typeof fetch,
      })
      const model = wrapLanguageModel({ model: sdk.responses("test-model"), middleware: openAIExecMiddleware })
      const options = {
        prompt: [
          {
            role: "assistant" as const,
            content: [
              {
                type: "reasoning" as const,
                text: "Test summary",
                providerOptions: { openai: {} },
              },
            ],
          },
        ],
        providerOptions: { openai: { store: false, allowUnencryptedReasoning } },
      }
      const result = await model.doGenerate(options)
      expect(result.providerMetadata?.openai?.endTurn).toBe(endTurn)
      const { stream } = await model.doStream(options)
      const parts: LanguageModelV3StreamPart[] = []
      await stream.pipeTo(
        new WritableStream({
          write(part) {
            parts.push(part)
          },
        }),
      )
      expect(parts.find((p) => p.type === "finish")?.providerMetadata?.openai?.endTurn).toBe(endTurn)
      for (const body of bodies) {
        expect(body.input).toEqual(
          allowUnencryptedReasoning
            ? [{ type: "reasoning", summary: [{ type: "summary_text", text: "Test summary" }] }]
            : [],
        )
      }
    }
  }
})
