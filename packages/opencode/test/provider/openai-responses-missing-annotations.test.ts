import { describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { createOpenAI } from "@ai-sdk/openai"

// Records @ai-sdk/openai's Responses behavior on the Ark coding-plan wire
// shape: `output_item.added` function_call carries no `arguments` field
// (arguments stream via `function_call_arguments.delta`), and streamed
// `output_text` blocks may omit `annotations`. With the pristine 3.0.84 SDK
// (no bun patch) the added chunk fails zod validation (required `arguments`)
// and is dropped — `tool-input-start` never fires, but `tool-input-end` +
// `tool-call` still stream. The session processor compensates via
// ensureToolCall (see test/session/tool-call-fallback.test.ts).

const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "继续" }] }]

function arkResponse({ withAnnotations }: { withAnnotations: boolean }) {
  const textBlock = withAnnotations
    ? { type: "output_text", text: "好的，开始吧", annotations: [] }
    : { type: "output_text", text: "好的，开始吧" }
  return {
    id: "resp_0217879063262351023f1f6cf081335b7e69d5fdf9a9368e3a67f",
    object: "response",
    created_at: 1_787_906_328,
    max_output_tokens: 32_000,
    model: "deepseek-v4-flash-ga-260731",
    status: "completed",
    output: [
      {
        id: "rs_02178790632898500000000000000000000ffffac15dc98a273d0",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "short reasoning" }],
        status: "completed",
      },
      {
        id: "msg_02178790633547400000000000000000000ffffac15dc98d95218",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [textBlock],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    service_tier: "default",
  }
}

function provider(body: unknown) {
  return createOpenAI({
    apiKey: "test",
    baseURL: "https://ark.test/v1",
    fetch: (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as any,
  })
}

function sseProvider(events: unknown[]) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"
  return createOpenAI({
    apiKey: "test",
    baseURL: "https://ark.test/v1",
    fetch: (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as any,
  })
}

describe("openai responses missing annotations", () => {
  test("accepts an output_text block without annotations (Ark responses shape)", async () => {
    const model = provider(arkResponse({ withAnnotations: false })).responses("deepseek-v4-flash")
    const result = await model.doGenerate({ prompt })
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "好的，开始吧" }))
  })

  test("accepts an output_text block with annotations", async () => {
    const model = provider(arkResponse({ withAnnotations: true })).responses("deepseek-v4-flash")
    const result = await model.doGenerate({ prompt })
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "好的，开始吧" }))
  })

  test("streams an output_text block without annotations without regressing", async () => {
    const events: unknown[] = [
      { type: "response.created", response: { id: "resp_s", created_at: 1, model: "m" } },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "msg_s", type: "message", role: "assistant", status: "in_progress", content: [] },
      },
      { type: "response.content_part.added", content_index: 0, item_id: "msg_s", output_index: 1, part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", content_index: 0, delta: "好的，开始吧", item_id: "msg_s", output_index: 1 },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "msg_s",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "好的，开始吧" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_s",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          output: [
            {
              id: "msg_s",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "好的，开始吧" }],
            },
          ],
        },
      },
    ]
    const model = sseProvider(events).responses("m")
    const result = await model.doStream({ prompt })
    const parts: { type: string; delta?: string }[] = []
    const reader = result.stream.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      parts.push(next.value)
    }
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toContain("好的，开始吧")
  })

  test("function_call without arguments does not crash; tool-call still streams (SDK drops the added chunk)", async () => {
    // Ark streams function_call arguments via `function_call_arguments.delta`,
    // so its `output_item.added` function_call item carries no `arguments`
    // field. With the pristine SDK the added chunk fails zod validation and is
    // dropped (no `tool-input-start`), but the stream still emits
    // `tool-input-end` + `tool-call`. This pins the SDK behavior so a future
    // SDK upgrade that changes it is noticed.
    const events: unknown[] = [
      { type: "response.created", response: { id: "resp_t", created_at: 1, model: "m" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_t", type: "reasoning", status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          call_id: "call_t0k",
          name: "echo_tool",
          type: "function_call",
          id: "fc_t",
          status: "in_progress",
        },
      },
      { type: "response.function_call_arguments.delta", delta: "{\"cmd\":", item_id: "fc_t", output_index: 1 },
      { type: "response.function_call_arguments.done", item_id: "fc_t", output_index: 1, arguments: "{\"cmd\": \"hi\"}" },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          call_id: "call_t0k",
          name: "echo_tool",
          type: "function_call",
          id: "fc_t",
          arguments: "{\"cmd\": \"hi\"}",
          status: "completed",
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_t",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          output: [
            {
              id: "fc_t",
              call_id: "call_t0k",
              name: "echo_tool",
              type: "function_call",
              arguments: "{\"cmd\": \"hi\"}",
            },
          ],
        },
      },
    ]
    const model = sseProvider(events).responses("m")
    const result = await model.doStream({ prompt })
    const parts: { type: string; id?: string; toolCallId?: string; toolName?: string; input?: unknown; providerMetadata?: unknown }[] = []
    const reader = result.stream.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      parts.push(next.value)
    }
    expect(parts.filter((part) => part.type === "tool-input-start")).toEqual([])
    expect(parts.filter((part) => part.type === "tool-call")).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_t0k",
        toolName: "echo_tool",
        input: "{\"cmd\": \"hi\"}",
        providerMetadata: { openai: { itemId: "fc_t" } },
      },
    ])
  })
})
