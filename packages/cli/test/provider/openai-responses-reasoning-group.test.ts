import { describe, expect, test } from "bun:test"
import { createAzure } from "@ai-sdk/azure"
import { createOpenAI } from "@ai-sdk/openai"
import { streamText, wrapLanguageModel, type ModelMessage } from "ai"
import type * as Provider from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as ProviderTransform from "../../src/provider/transform"

function makeFetch(handler: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect })
}

function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

function minimalTextStream(text = "ok") {
  return sse([
    {
      type: "response.created",
      response: { id: "resp_next", created_at: 1_755_000_001, model: "test/model" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_next", role: "assistant", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_next",
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_next", role: "assistant", content: [{ type: "output_text", text }] },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_next",
        incomplete_details: null,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ])
}

function parseBody(init?: RequestInit): { input: Array<Record<string, unknown>> } {
  if (typeof init?.body !== "string") throw new Error("Expected string JSON request body")
  return JSON.parse(init.body)
}

function makeModel(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: ModelID.make("test/model"),
    providerID: ProviderID.make("openai"),
    api: {
      id: "test/model",
      url: "https://example.invalid/v1",
      npm: "@ai-sdk/openai",
    },
    name: "Test Model",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 16_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    ...overrides,
  }
}

async function captureOpenAIWireBody(input: {
  messages: ModelMessage[]
  store?: boolean
  model?: Provider.Model
}) {
  const bodies: Array<{ input: Array<Record<string, unknown>> }> = []
  const store = input.store ?? false
  const model = input.model ?? makeModel()
  const mockFetch = makeFetch(async (_url, init) => {
    bodies.push(parseBody(init))
    return minimalTextStream()
  })
  const openai = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://example.invalid/v1",
    fetch: mockFetch,
  })
  const options = { store }
  const wrapped = wrapLanguageModel({
    model: openai.responses(model.api.id),
    middleware: [
      {
        specificationVersion: "v3",
        async transformParams(args) {
          if (args.type === "generate" || args.type === "stream") {
            // @ts-expect-error ProviderTransform.message accepts ModelMessage[] on v3 prompt
            args.params.prompt = ProviderTransform.message(args.params.prompt, model, options)
          }
          return args.params
        },
      },
    ],
  })

  const result = streamText({
    model: wrapped,
    messages: input.messages,
    providerOptions: ProviderTransform.providerOptions(model, options),
  })
  await result.text
  expect(bodies).toHaveLength(1)
  return bodies[0]
}

describe("OpenAI Responses stateless reasoning grouping", () => {
  test("re-groups multi-summary reasoning carrying duplicate encrypted_content into one block with preserved id", async () => {
    const encrypted = "gAAAAAB_example_ciphertext_payload"
    const body = await captureOpenAIWireBody({
      messages: [
        { role: "user", content: "Run the task" },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "**Clarifying task binding instructions**\nFirst summary body.",
              providerOptions: {
                openai: { itemId: "rs_turn1", reasoningEncryptedContent: encrypted },
              },
            },
            {
              type: "reasoning",
              text: "**Verifying output paths**\nSecond summary body.",
              providerOptions: {
                openai: { itemId: "rs_turn1", reasoningEncryptedContent: encrypted },
              },
            },
            {
              type: "text",
              text: "Working on it.",
              providerOptions: { openai: { itemId: "msg_turn1" } },
            },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "task",
              input: { action: "list" },
              providerOptions: { openai: { itemId: "fc_turn1" } },
            },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call_1", toolName: "task", output: { type: "text", value: "ok" } },
          ],
        },
      ],
    })

    const reasoningItems = body.input.filter((item) => item.type === "reasoning")
    expect(reasoningItems).toHaveLength(1)
    expect(reasoningItems[0]).toEqual({
      type: "reasoning",
      id: "rs_turn1",
      encrypted_content: encrypted,
      summary: [
        { type: "summary_text", text: "**Clarifying task binding instructions**\nFirst summary body." },
        { type: "summary_text", text: "**Verifying output paths**\nSecond summary body." },
      ],
    })

    const assistantText = body.input.find((item) => item.role === "assistant")
    expect(assistantText?.id).toBeUndefined()
    const fnCall = body.input.find((item) => item.type === "function_call")
    expect(fnCall?.id).toBeUndefined()
  })

  test("preserves earlier summary parts when only the last summary carries encrypted_content", async () => {
    const encrypted = "gAAAAAB_standard_sse_ciphertext"
    const body = await captureOpenAIWireBody({
      messages: [
        { role: "user", content: "Check paths" },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "**Clarifying task binding instructions**",
              providerOptions: { openai: { itemId: "rs_sse1" } },
            },
            {
              type: "reasoning",
              text: "**Verifying output paths**",
              providerOptions: {
                openai: { itemId: "rs_sse1", reasoningEncryptedContent: encrypted },
              },
            },
            { type: "text", text: "Done." },
          ],
        },
        { role: "user", content: "Continue" },
      ],
    })

    const reasoningItems = body.input.filter((item) => item.type === "reasoning")
    expect(reasoningItems).toHaveLength(1)
    expect(reasoningItems[0]).toEqual({
      type: "reasoning",
      id: "rs_sse1",
      encrypted_content: encrypted,
      summary: [
        { type: "summary_text", text: "**Clarifying task binding instructions**" },
        { type: "summary_text", text: "**Verifying output paths**" },
      ],
    })
  })

  test("keeps distinct reasoning items separate and preserves store=true item_reference", async () => {
    const stateless = await captureOpenAIWireBody({
      store: false,
      messages: [
        { role: "user", content: "Compare" },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Block 1 part 1",
              providerOptions: { openai: { itemId: "rs_a", reasoningEncryptedContent: "enc_a" } },
            },
            {
              type: "reasoning",
              text: "Block 1 part 2",
              providerOptions: { openai: { itemId: "rs_a", reasoningEncryptedContent: "enc_a" } },
            },
            {
              type: "reasoning",
              text: "Block 2 part 1",
              providerOptions: { openai: { itemId: "rs_b", reasoningEncryptedContent: "enc_b" } },
            },
            { type: "text", text: "Done" },
          ],
        },
        { role: "user", content: "Follow up" },
      ],
    })

    const reasoningItems = stateless.input.filter((item) => item.type === "reasoning")
    expect(reasoningItems).toEqual([
      {
        type: "reasoning",
        id: "rs_a",
        encrypted_content: "enc_a",
        summary: [
          { type: "summary_text", text: "Block 1 part 1" },
          { type: "summary_text", text: "Block 1 part 2" },
        ],
      },
      {
        type: "reasoning",
        id: "rs_b",
        encrypted_content: "enc_b",
        summary: [{ type: "summary_text", text: "Block 2 part 1" }],
      },
    ])

    const stateful = await captureOpenAIWireBody({
      store: true,
      messages: [
        { role: "user", content: "Compare" },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Block 1 part 1",
              providerOptions: { openai: { itemId: "rs_a", reasoningEncryptedContent: "enc_a" } },
            },
            {
              type: "reasoning",
              text: "Block 1 part 2",
              providerOptions: { openai: { itemId: "rs_a", reasoningEncryptedContent: "enc_a" } },
            },
            { type: "text", text: "Done", providerOptions: { openai: { itemId: "msg_a" } } },
          ],
        },
        { role: "user", content: "Follow up" },
      ],
    })

    expect(stateful.input.filter((item) => item.type === "item_reference")).toEqual([
      { type: "item_reference", id: "rs_a" },
      { type: "item_reference", id: "msg_a" },
    ])
  })

  test("applies the same stateless grouping via stock @ai-sdk/azure (@ai-sdk/openai/internal)", async () => {
    const encrypted = "gAAAAAB_azure_ciphertext"
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = []
    const azureModel = makeModel({
      providerID: ProviderID.make("azure"),
      api: {
        id: "test/model",
        url: "https://example.invalid/openai",
        npm: "@ai-sdk/azure",
      },
    })
    const mockFetch = makeFetch(async (_url, init) => {
      bodies.push(parseBody(init))
      return minimalTextStream()
    })
    const azure = createAzure({
      apiKey: "test-key",
      baseURL: "https://example.invalid/openai",
      fetch: mockFetch,
    })
    const options = { store: false }
    const wrapped = wrapLanguageModel({
      model: azure.responses(azureModel.api.id),
      middleware: [
        {
          specificationVersion: "v3",
          async transformParams(args) {
            if (args.type === "generate" || args.type === "stream") {
              // @ts-expect-error ProviderTransform.message accepts ModelMessage[] on v3 prompt
              args.params.prompt = ProviderTransform.message(args.params.prompt, azureModel, options)
            }
            return args.params
          },
        },
      ],
    })

    const result = streamText({
      model: wrapped,
      messages: [
        { role: "user", content: "Start" },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Azure summary 1",
              providerOptions: { azure: { itemId: "rs_az1", reasoningEncryptedContent: encrypted } },
            },
            {
              type: "reasoning",
              text: "Azure summary 2",
              providerOptions: { azure: { itemId: "rs_az1", reasoningEncryptedContent: encrypted } },
            },
            { type: "text", text: "Hi", providerOptions: { azure: { itemId: "msg_az1" } } },
          ],
        },
        { role: "user", content: "Next" },
      ],
      providerOptions: ProviderTransform.providerOptions(azureModel, options),
    })
    await result.text

    expect(bodies).toHaveLength(1)
    const reasoningItems = bodies[0].input.filter((item) => item.type === "reasoning")
    expect(reasoningItems).toHaveLength(1)
    expect(reasoningItems[0]).toEqual({
      type: "reasoning",
      id: "rs_az1",
      encrypted_content: encrypted,
      summary: [
        { type: "summary_text", text: "Azure summary 1" },
        { type: "summary_text", text: "Azure summary 2" },
      ],
    })
    expect(bodies[0].input.find((item) => item.role === "assistant")?.id).toBeUndefined()
  })

  test("round-trips a real streamed multi-summary reasoning turn into a single wire block on turn 2", async () => {
    const encrypted = "gAAAAAB_roundtrip_ciphertext"
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = []
    let turn = 0
    const model = makeModel()
    const mockFetch = makeFetch(async (_url, init) => {
      bodies.push(parseBody(init))
      turn += 1
      if (turn === 1) {
        return sse([
          {
            type: "response.created",
            response: { id: "resp_1", created_at: 1_755_000_000, model: "test/model" },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "reasoning", id: "rs_live", encrypted_content: null },
          },
          {
            type: "response.reasoning_summary_part.added",
            item_id: "rs_live",
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs_live",
            output_index: 0,
            summary_index: 0,
            delta: "**Clarifying task binding instructions**",
          },
          {
            type: "response.reasoning_summary_part.added",
            item_id: "rs_live",
            output_index: 0,
            summary_index: 1,
            part: { type: "summary_text", text: "" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs_live",
            output_index: 0,
            summary_index: 1,
            delta: "**Verifying output paths**",
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "rs_live",
              encrypted_content: encrypted,
              summary: [
                { type: "summary_text", text: "**Clarifying task binding instructions**" },
                { type: "summary_text", text: "**Verifying output paths**" },
              ],
            },
          },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { type: "message", id: "msg_live", role: "assistant", content: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_live",
            output_index: 1,
            content_index: 0,
            delta: "Step 1 done.",
            logprobs: [],
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              type: "message",
              id: "msg_live",
              role: "assistant",
              content: [{ type: "output_text", text: "Step 1 done." }],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              incomplete_details: null,
              usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            },
          },
        ])
      }
      return minimalTextStream("Step 2 done.")
    })
    const openai = createOpenAI({
      apiKey: "test-key",
      baseURL: "https://example.invalid/v1",
      fetch: mockFetch,
    })

    const options = { store: false }
    const wrapped = wrapLanguageModel({
      model: openai.responses(model.api.id),
      middleware: [
        {
          specificationVersion: "v3",
          async transformParams(args) {
            if (args.type === "generate" || args.type === "stream") {
              // @ts-expect-error ProviderTransform.message accepts ModelMessage[] on v3 prompt
              args.params.prompt = ProviderTransform.message(args.params.prompt, model, options)
            }
            return args.params
          },
        },
      ],
    })

    const turn1 = streamText({
      model: wrapped,
      messages: [{ role: "user", content: "Do step 1" }],
      providerOptions: ProviderTransform.providerOptions(model, options),
    })
    const turn1Response = await turn1.response

    const turn2 = streamText({
      model: wrapped,
      messages: [
        { role: "user", content: "Do step 1" },
        ...turn1Response.messages,
        { role: "user", content: "Do step 2" },
      ],
      providerOptions: ProviderTransform.providerOptions(model, options),
    })
    await turn2.text

    expect(bodies).toHaveLength(2)
    const reasoningItems = bodies[1].input.filter((item) => item.type === "reasoning")
    expect(reasoningItems).toHaveLength(1)
    expect(reasoningItems[0]).toEqual({
      type: "reasoning",
      id: "rs_live",
      encrypted_content: encrypted,
      summary: [
        { type: "summary_text", text: "**Clarifying task binding instructions**" },
        { type: "summary_text", text: "**Verifying output paths**" },
      ],
    })
    expect(bodies[1].input.find((item) => item.role === "assistant")?.id).toBeUndefined()
  })

  test("round-trips standard SSE (with reasoning_summary_part.done) without dropping earlier summaries", async () => {
    const encrypted = "gAAAAAB_standard_sse_roundtrip"
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = []
    let turn = 0
    const model = makeModel({ providerID: ProviderID.make("custom-openai-proxy") })
    const mockFetch = makeFetch(async (_url, init) => {
      bodies.push(parseBody(init))
      turn += 1
      if (turn === 1) {
        return sse([
          {
            type: "response.created",
            response: { id: "resp_sse1", created_at: 1_755_000_000, model: "test/model" },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "reasoning", id: "rs_std", encrypted_content: null },
          },
          {
            type: "response.reasoning_summary_part.added",
            item_id: "rs_std",
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs_std",
            output_index: 0,
            summary_index: 0,
            delta: "**First summary**",
          },
          {
            type: "response.reasoning_summary_part.done",
            item_id: "rs_std",
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: "**First summary**" },
          },
          {
            type: "response.reasoning_summary_part.added",
            item_id: "rs_std",
            output_index: 0,
            summary_index: 1,
            part: { type: "summary_text", text: "" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs_std",
            output_index: 0,
            summary_index: 1,
            delta: "**Second summary**",
          },
          {
            type: "response.reasoning_summary_part.done",
            item_id: "rs_std",
            output_index: 0,
            summary_index: 1,
            part: { type: "summary_text", text: "**Second summary**" },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "rs_std",
              encrypted_content: encrypted,
              summary: [
                { type: "summary_text", text: "**First summary**" },
                { type: "summary_text", text: "**Second summary**" },
              ],
            },
          },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { type: "message", id: "msg_std", role: "assistant", content: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_std",
            output_index: 1,
            content_index: 0,
            delta: "Done.",
            logprobs: [],
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              type: "message",
              id: "msg_std",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_sse1",
              incomplete_details: null,
              usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            },
          },
        ])
      }
      return minimalTextStream("Follow-up done.")
    })
    const openai = createOpenAI({
      apiKey: "test-key",
      baseURL: "https://example.invalid/v1",
      fetch: mockFetch,
    })

    const options = { store: false }
    const wrapped = wrapLanguageModel({
      model: openai.responses(model.api.id),
      middleware: [
        {
          specificationVersion: "v3",
          async transformParams(args) {
            if (args.type === "generate" || args.type === "stream") {
              // @ts-expect-error ProviderTransform.message accepts ModelMessage[] on v3 prompt
              args.params.prompt = ProviderTransform.message(args.params.prompt, model, options)
            }
            return args.params
          },
        },
      ],
    })

    const turn1 = streamText({
      model: wrapped,
      messages: [{ role: "user", content: "Start" }],
      providerOptions: ProviderTransform.providerOptions(model, options),
    })
    const turn1Response = await turn1.response

    const turn2 = streamText({
      model: wrapped,
      messages: [
        { role: "user", content: "Start" },
        ...turn1Response.messages,
        { role: "user", content: "Continue" },
      ],
      providerOptions: ProviderTransform.providerOptions(model, options),
    })
    await turn2.text

    expect(bodies).toHaveLength(2)
    const reasoningItems = bodies[1].input.filter((item) => item.type === "reasoning")
    expect(reasoningItems).toHaveLength(1)
    expect(reasoningItems[0]).toEqual({
      type: "reasoning",
      id: "rs_std",
      encrypted_content: encrypted,
      summary: [
        { type: "summary_text", text: "**First summary**" },
        { type: "summary_text", text: "**Second summary**" },
      ],
    })
    expect(bodies[1].input.find((item) => item.role === "assistant")?.id).toBeUndefined()
  })
})
