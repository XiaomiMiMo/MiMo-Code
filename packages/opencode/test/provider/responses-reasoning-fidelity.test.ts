import type { OpenAIResponsesReasoning } from "../../src/provider/sdk/copilot/responses/openai-responses-api-types"
import { expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createOpenaiCompatible } from "../../src/provider/sdk/copilot"
import { reasoningStream } from "../../src/provider/sdk/copilot/responses/reasoning"
import { convertToOpenAIResponsesInput } from "../../src/provider/sdk/copilot/responses/convert-to-openai-responses-input"
const item = {
  type: "reasoning",
  id: "rs_example",
  status: "completed",
  summary: [{ type: "summary_text", text: "Brief summary." }],
  content: [{ type: "reasoning_text", text: "Full reasoning." }],
  encrypted_content: "final-encrypted",
} satisfies OpenAIResponsesReasoning
const completed = { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3 } } }
async function stream(events: object[]) {
  const sdk = createOpenaiCompatible({
    name: "openai",
    fetch: (async () =>
      new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch,
  })
  const result = await sdk
    .responses("mimo-test")
    .doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] })
  const parts: LanguageModelV3StreamPart[] = []
  await result.stream.pipeTo(
    new WritableStream({
      write(part) {
        parts.push(part)
      },
    }),
  )
  expect(parts.filter((p) => p.type === "error")).toEqual([])
  return parts
}
// [TP-R11-11] OpenAI fields stay independent across stream, storage metadata and replay.
for (const mode of ["stream", "final-only", "completed-only"] as const)
  test(`reasoning item round trip: ${mode}`, async () => {
    const parts = await stream([
      ...(mode === "stream"
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "reasoning", id: item.id, encrypted_content: "partial-encrypted" },
            },
            {
              type: "response.reasoning_text.delta",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              delta: "Full ",
            },
            {
              type: "response.reasoning_summary_text.delta",
              output_index: 0,
              item_id: item.id,
              summary_index: 0,
              delta: "Brief ",
            },
          ]
        : []),
      ...(mode !== "completed-only" ? [{ type: "response.output_item.done", output_index: 0, item }] : []),
      { ...completed, response: { ...completed.response, output: [item] } },
    ])
    const ends = parts.filter((p) => p.type === "reasoning-end")
    expect(ends).toHaveLength(2)
    expect(new Set(ends.map((p) => p.id)).size).toBe(2)
    expect(ends.map((p) => p.providerMetadata?.openai.reasoningChannel).sort()).toEqual(["content", "summary"])
    expect(ends.map((p) => p.providerMetadata?.openai.reasoningText).sort()).toEqual([
      "Brief summary.",
      "Full reasoning.",
    ])
    expect(ends.map((p) => p.providerMetadata?.openai.reasoningItem).filter(Boolean)).toEqual([item])
    for (const store of [false, true]) {
      const converted = await convertToOpenAIResponsesInput({
        prompt: [
          {
            role: "assistant",
            content: ends.map((p) => ({
              type: "reasoning" as const,
              text: String(p.providerMetadata?.openai.reasoningText),
              providerOptions: p.providerMetadata,
            })),
          },
        ],
        systemMessageMode: "system",
        store,
        providerOptionsKey: "openai",
        hasLocalShellTool: false,
      })
      expect(converted.input).toEqual(store ? [{ type: "item_reference", id: item.id }] : [item])
    }
  })
test("non-streaming reasoning retains content, summary, ciphertext and status", async () => {
  const sdk = createOpenaiCompatible({
    name: "openai",
    fetch: (async () =>
      Response.json({
        id: "response_example",
        created_at: 1,
        model: "mimo-test",
        output: [item],
        usage: { input_tokens: 2, output_tokens: 3 },
      })) as unknown as typeof fetch,
  })
  const result = await sdk
    .responses("mimo-test")
    .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] })
  const reasoning = result.content.filter((p) => p.type === "reasoning")
  expect(reasoning.map((p) => p.text).sort()).toEqual(["Brief summary.", "Full reasoning."])
  expect(reasoning.map((p) => p.providerMetadata?.openai.reasoningItem).filter(Boolean)).toEqual([item])
})

test("part.done recovers missing deltas and an unfinished stream retains ordered parts", async () => {
  const parts = await stream([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: item.id, summary: [], content: [], status: "in_progress" },
    },
    { type: "response.reasoning_text.delta", output_index: 0, item_id: item.id, content_index: 1, delta: "Second" },
    {
      type: "response.reasoning_summary_text.done",
      output_index: 0,
      item_id: item.id,
      summary_index: 0,
      text: "Summary.",
    },
    { type: "response.reasoning_text.done", output_index: 0, item_id: item.id, content_index: 0, text: "First." },
    {
      type: "response.content_part.done",
      output_index: 0,
      item_id: item.id,
      content_index: 1,
      part: { type: "reasoning_text", text: "Second." },
    },
  ])
  const ends = parts.filter((p) => p.type === "reasoning-end")
  expect(ends.map((p) => p.providerMetadata?.openai.reasoningItem).filter(Boolean)).toEqual([
    {
      type: "reasoning",
      id: item.id,
      status: "in_progress",
      summary: [{ type: "summary_text", text: "Summary." }],
      content: [
        { type: "reasoning_text", text: "First." },
        { type: "reasoning_text", text: "Second." },
      ],
    },
  ])
})

test("terminal text replaces conflicting partials and duplicate terminals do not duplicate items", async () => {
  const parts = await stream([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: item.id, encrypted_content: "partial" },
    },
    { type: "response.reasoning_text.delta", item_id: item.id, content_index: 0, delta: "Superseded text." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { ...completed, response: { ...completed.response, output: [item] } },
  ])
  const ends = parts.filter((p) => p.type === "reasoning-end")
  expect(ends).toHaveLength(2)
  expect(
    ends.find((p) => p.providerMetadata?.openai.reasoningChannel === "content")?.providerMetadata?.openai.reasoningText,
  ).toBe("Full reasoning.")
  expect(ends.map((p) => p.providerMetadata?.openai.reasoningItem).filter(Boolean)).toEqual([item])
  expect(ends.every((p) => p.providerMetadata?.openai.reasoningEncryptedContent === "final-encrypted")).toBe(true)
})

for (const variant of [
  { type: "reasoning", id: "rs_cipher", summary: [], encrypted_content: "cipher", status: "completed" },
  { type: "reasoning", id: "rs_content", summary: [], content: [{ type: "reasoning_text", text: "Only full text." }] },
  { type: "reasoning", id: "rs_empty", summary: [], content: [] },
  { type: "reasoning", id: "rs_null", summary: [], content: null, status: null, encrypted_content: null },
])
  test(`streaming and non-streaming retain single-field/empty variant ${variant.id}`, async () => {
    const parts = await stream([{ type: "response.output_item.done", output_index: 0, item: variant }, completed])
    const ends = parts.filter((p) => p.type === "reasoning-end")
    expect(ends.map((p) => p.providerMetadata?.openai.reasoningItem).filter(Boolean)).toEqual([variant])
    const sdk = createOpenaiCompatible({
      name: "openai",
      fetch: (async () =>
        Response.json({
          id: "resp_variant",
          created_at: 1,
          model: "mimo-test",
          output: [variant],
          usage: { input_tokens: 1, output_tokens: 1 },
        })) as unknown as typeof fetch,
    })
    const result = await sdk
      .responses("mimo-test")
      .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] })
    expect(
      result.content
        .filter((p) => p.type === "reasoning")
        .map((p) => p.providerMetadata?.openai.reasoningItem)
        .filter(Boolean),
    ).toEqual([variant])
    const converted = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "assistant",
          content: ends.map((p) => ({
            type: "reasoning" as const,
            text: String(p.providerMetadata?.openai.reasoningText),
            providerOptions: p.providerMetadata,
          })),
        },
      ],
      systemMessageMode: "system",
      store: false,
      providerOptionsKey: "openai",
      hasLocalShellTool: false,
    })
    expect(JSON.parse(JSON.stringify(converted.input))).toEqual([
      variant.id === "rs_null" ? { type: "reasoning", id: "rs_null", summary: [], encrypted_content: null } : variant,
    ])
  })

for (const content of [[], null])
  test(`sparse terminal preserves initial content ${JSON.stringify(content)}`, async () => {
    const parts = await stream([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: item.id, content } },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: item.id } },
      completed,
    ])
    expect(
      parts
        .filter((p) => p.type === "reasoning-end")
        .map((p) => p.providerMetadata?.openai.reasoningItem)
        .filter(Boolean),
    ).toEqual([{ type: "reasoning", id: item.id, summary: [], content }])
  })

test("authoritative empty arrays clear partial text without replaying it", async () => {
  const empty = { type: "reasoning", id: item.id, summary: [], content: null }
  const parts = await stream([
    { type: "response.reasoning_text.delta", item_id: item.id, content_index: 0, delta: "Discarded." },
    { type: "response.reasoning_summary_text.delta", item_id: item.id, summary_index: 0, delta: "Discarded summary." },
    { type: "response.output_item.done", output_index: 0, item: empty },
    completed,
  ])
  const ends = parts.filter((p) => p.type === "reasoning-end")
  expect(ends.map((p) => p.providerMetadata?.openai.reasoningText)).toEqual(["", ""])
  expect(ends.map((p) => p.providerMetadata?.openai.reasoningItem).filter(Boolean)).toEqual([empty])
})

test("Copilot rotating IDs retain independent output indices after an orphan delta", () => {
  const parser = reasoningStream(true)
  const parts: LanguageModelV3StreamPart[] = []
  const sink = {
    enqueue: (part: LanguageModelV3StreamPart) => {
      parts.push(part)
    },
  }
  for (const event of [
    { type: "response.reasoning_text.delta", item_id: "rs_first", content_index: 0, delta: "First." },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_first" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "reasoning", id: "rs_second" } },
    {
      type: "response.reasoning_text.delta",
      output_index: 1,
      item_id: "rs_second_rotated",
      content_index: 0,
      delta: "Second.",
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      item_id: "rs_first_rotated",
      summary_index: 0,
      delta: "First summary.",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_first_done", encrypted_content: "first-cipher" },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "reasoning", id: "rs_second_done", encrypted_content: "second-cipher" },
    },
  ])
    parser.handle(event, sink)
  parser.flush(sink)
  expect(
    parts
      .filter((p) => p.type === "reasoning-end")
      .map((p) => p.providerMetadata?.openai.reasoningItem)
      .filter(Boolean),
  ).toEqual([
    {
      type: "reasoning",
      id: "rs_first",
      content: [{ type: "reasoning_text", text: "First." }],
      summary: [{ type: "summary_text", text: "First summary." }],
      encrypted_content: "first-cipher",
    },
    {
      type: "reasoning",
      id: "rs_second",
      content: [{ type: "reasoning_text", text: "Second." }],
      summary: [],
      encrypted_content: "second-cipher",
    },
  ])
})

test("legacy reasoning history remains readable without inventing full-text provenance", async () => {
  const converted = await convertToOpenAIResponsesInput({
    prompt: [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Legacy reasoning.",
            providerOptions: { openai: { itemId: "rs_legacy", reasoningEncryptedContent: "legacy-cipher" } },
          },
        ],
      },
    ],
    systemMessageMode: "system",
    store: false,
    providerOptionsKey: "openai",
    hasLocalShellTool: false,
  })
  expect(converted.input).toEqual([
    {
      type: "reasoning",
      id: "rs_legacy",
      summary: [{ type: "summary_text", text: "Legacy reasoning." }],
      encrypted_content: "legacy-cipher",
    },
  ])
})

test("Copilot replays the openai metadata emitted by its own Responses adapter", async () => {
  const sdk = createOpenaiCompatible({
    name: "github-copilot",
    fetch: (async () =>
      Response.json({
        id: "response_example",
        created_at: 1,
        model: "gpt-example",
        output: [item],
        usage: { input_tokens: 2, output_tokens: 3 },
      })) as unknown as typeof fetch,
  })
  const result = await sdk
    .responses("gpt-example")
    .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] })
  const converted = await convertToOpenAIResponsesInput({
    prompt: [
      {
        role: "assistant",
        content: result.content
          .filter((p) => p.type === "reasoning")
          .map((p) => ({ type: "reasoning", text: p.text, providerOptions: p.providerMetadata })),
      },
    ],
    systemMessageMode: "system",
    store: false,
    providerOptionsKey: "copilot",
    hasLocalShellTool: false,
  })
  expect(converted.input).toEqual([item])
  expect(converted.warnings).toEqual([])
})

test("interrupted reasoning without a terminal item retains the received text channels", async () => {
  const converted = await convertToOpenAIResponsesInput({
    prompt: [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Partial full text.",
            providerOptions: { openai: { itemId: "rs_interrupted", reasoningChannel: "content" } },
          },
          {
            type: "reasoning",
            text: "Partial summary.",
            providerOptions: { openai: { itemId: "rs_interrupted", reasoningChannel: "summary" } },
          },
        ],
      },
    ],
    systemMessageMode: "system",
    store: false,
    providerOptionsKey: "openai",
    hasLocalShellTool: false,
  })
  expect(converted.input).toEqual([
    {
      type: "reasoning",
      id: "rs_interrupted",
      content: [{ type: "reasoning_text", text: "Partial full text." }],
      summary: [{ type: "summary_text", text: "Partial summary." }],
    },
  ])
})
