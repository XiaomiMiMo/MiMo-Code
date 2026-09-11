import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText, tool } from "ai"
import z from "zod"

// Independent reproduction of the `@ai-sdk/openai-compatible@2.0.41` patch
// (`patches/@ai-sdk%2Fopenai-compatible@2.0.41.patch`, branch
// fix/mcp-tool-args-stream). Exercises the REAL patched stream parser
// end-to-end: mock SSE → provider `doStream` → `ai` core tool execution.
//
// Defect being fixed: a provider that emits OVERLAPPING complete-JSON argument
// snapshots (OpenRouter buffered mode) triggered the parser's premature
// finalize on the FIRST parseable snapshot (`{}`), so the tool `execute`
// received an empty object. The patch tracks `lastValidDelta` = the LAST
// complete snapshot and falls back to it at flush when the concatenated
// accumulator is not parseable.

interface Captured {
  name: string
  input: unknown
}

function chunk(delta: Record<string, unknown>, finishReason?: string): string {
  const payload = {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseResponse(lines: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line))
      controller.close()
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const FULL_ARGS = JSON.stringify({
  p0: "a",
  p1: "b",
  p2: "c",
  p3: "d",
  p4: "e",
  p5: "f",
})

function overlappingSnapshotsLines(): string[] {
  const snapshots = [
    "{}",
    JSON.stringify({ p0: "a" }),
    JSON.stringify({ p0: "a", p1: "b" }),
    JSON.stringify({ p0: "a", p1: "b", p2: "c" }),
    JSON.stringify({ p0: "a", p1: "b", p2: "c", p3: "d" }),
    JSON.stringify({ p0: "a", p1: "b", p2: "c", p3: "d", p4: "e" }),
    FULL_ARGS,
  ]
  return [
    chunk({ role: "assistant" }),
    chunk({
      tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "calc", arguments: snapshots[0] } },
      ],
    }),
    ...snapshots.slice(1).map((args) =>
      chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
    ),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ]
}

function incrementalPrefixLines(): string[] {
  return [
    chunk({ role: "assistant" }),
    chunk({
      tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "calc", arguments: '{"p0":"a"' } },
      ],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ',"p1":"b"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ',"p2":"c"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ',"p3":"d"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ',"p4":"e"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ',"p5":"f"}' } }] }),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ]
}

async function run(lines: string[]): Promise<Captured> {
  const captured: Captured = { name: "", input: null }
  const provider = createOpenAICompatible({
    baseURL: "http://mock/v1",
    name: "mock",
    apiKey: "test-key",
    fetch: (async () => sseResponse(lines)) as any,
  })
  const model = provider.languageModel("mock-model")

  const result = streamText({
    model,
    prompt: "run calc",
    toolChoice: "required",
    tools: {
      calc: tool({
        description: "Calc",
        inputSchema: z.object({
          p0: z.string(),
          p1: z.string(),
          p2: z.string(),
          p3: z.string(),
          p4: z.string(),
          p5: z.string(),
        }),
        execute: async (input) => {
          captured.name = "calc"
          captured.input = input
          return "ok"
        },
      }),
    },
  })

  // Consume the full stream so the tool loop runs to completion.
  await result.toolResults
  expect(captured.name).toBe("calc")
  return captured
}

describe("openai-compatible patch: lastValidDelta", () => {
  test("OVERLAPPING complete-JSON snapshots → execute receives ALL 6 args", async () => {
    const captured = await run(overlappingSnapshotsLines())
    expect(captured.input).toEqual({
      p0: "a",
      p1: "b",
      p2: "c",
      p3: "d",
      p4: "e",
      p5: "f",
    })
  })

  test("incremental-prefix streaming still works → execute receives ALL 6 args", async () => {
    const captured = await run(incrementalPrefixLines())
    expect(captured.input).toEqual({
      p0: "a",
      p1: "b",
      p2: "c",
      p3: "d",
      p4: "e",
      p5: "f",
    })
  })
})
