import { expect, test } from "bun:test"
import type { LanguageModelV3StreamPart, LanguageModelV3ToolCall } from "@ai-sdk/provider"
import { jsonSchema, streamText, tool, wrapLanguageModel } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import {
  guardToolCallStream,
  ToolCallFloodingError,
  toolCallFloodingMiddleware,
} from "../../src/session/toolcall-flooding"
import { Flag } from "../../src/flag/flag"

const finish: LanguageModelV3StreamPart = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
}

function call(id: string): LanguageModelV3ToolCall {
  return { type: "tool-call", toolCallId: id, toolName: "write", input: JSON.stringify({ value: id }) }
}

function source() {
  let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  const state = { cancelled: false }
  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    start(value) {
      controller = value
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { controller, stream, state }
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const events: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const event = await reader.read()
    if (event.done) break
    events.push(event.value)
  }
  return events
}

test("complete calls stream through immediately without a generation barrier", async () => {
  const input = source()
  const reading = collect(guardToolCallStream(input.stream))
  for (const index of Array.from({ length: 8 }, (_, index) => index)) input.controller.enqueue(call(String(index)))
  input.controller.enqueue({ type: "text-start", id: "text" })
  input.controller.enqueue({ type: "text-delta", id: "text", delta: "Still generating" })
  input.controller.enqueue(finish)
  input.controller.close()
  const events = await reading
  expect(events.filter((event) => event.type === "tool-call")).toEqual(
    Array.from({ length: 8 }, (_, index) => call(String(index))),
  )
  expect(events.some((event) => event.type === "error")).toBe(false)
})

test("the ninth call aborts generation before it is forwarded", async () => {
  const input = source()
  const reading = collect(guardToolCallStream(input.stream))
  for (const index of Array.from({ length: 9 }, (_, index) => index)) {
    input.controller.enqueue({ type: "tool-input-start", id: String(index), toolName: "write" })
    if (index < 8) input.controller.enqueue(call(String(index)))
  }
  const events = await reading
  expect(input.state.cancelled).toBe(true)
  expect(events.filter((event) => event.type === "tool-call")).toEqual(
    Array.from({ length: 8 }, (_, index) => call(String(index))),
  )
  expect(events.filter((event) => event.type === "tool-input-start")).toHaveLength(8)
  expect(events.find((event) => event.type === "error")?.error).toBeInstanceOf(ToolCallFloodingError)
})

test("complete-only ninth call is also dropped before forward", async () => {
  const input = source()
  const reading = collect(guardToolCallStream(input.stream))
  for (const index of Array.from({ length: 9 }, (_, index) => index)) input.controller.enqueue(call(String(index)))
  const events = await reading
  expect(input.state.cancelled).toBe(true)
  expect(events.filter((event) => event.type === "tool-call")).toEqual(
    Array.from({ length: 8 }, (_, index) => call(String(index))),
  )
  expect(events.find((event) => event.type === "error")?.error).toBeInstanceOf(ToolCallFloodingError)
})

test("start and completion count once for the same call id", async () => {
  const input = source()
  const reading = collect(guardToolCallStream(input.stream))
  for (const index of Array.from({ length: 8 }, (_, index) => index)) {
    input.controller.enqueue({ type: "tool-input-start", id: String(index), toolName: "write" })
    input.controller.enqueue(call(String(index)))
    input.controller.enqueue(call(String(index)))
  }
  input.controller.enqueue(finish)
  input.controller.close()
  const events = await reading
  expect(events.filter((event) => event.type === "tool-call")).toHaveLength(16)
  expect(events.some((event) => event.type === "error")).toBe(false)
})

test("independent requests have independent counts", async () => {
  const first = source()
  const second = source()
  const firstReading = collect(guardToolCallStream(first.stream))
  const secondReading = collect(guardToolCallStream(second.stream))
  for (const input of [first, second]) {
    for (const index of Array.from({ length: 8 }, (_, index) => index)) input.controller.enqueue(call(String(index)))
    input.controller.enqueue(finish)
    input.controller.close()
  }
  expect((await firstReading).filter((event) => event.type === "tool-call")).toHaveLength(8)
  expect((await secondReading).filter((event) => event.type === "tool-call")).toHaveLength(8)
})

test("downstream cancellation cancels the provider", async () => {
  const input = source()
  const reader = guardToolCallStream(input.stream).getReader()
  input.controller.enqueue(call("first"))
  expect((await reader.read()).value?.type).toBe("tool-input-start")
  await reader.cancel()
  expect(input.state.cancelled).toBe(true)
  expect((await reader.read()).done).toBe(true)
})

test("the flood opt-out flag defaults off and accepts the existing boolean grammar", () => {
  const previous = process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
  try {
    delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
    expect(Flag.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT).toBe(false)
    for (const value of ["1", "true"]) {
      process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = value
      expect(Flag.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT).toBe(true)
    }
    for (const value of ["0", "false"]) {
      process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = value
      expect(Flag.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT).toBe(false)
    }
  } finally {
    if (previous == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
    else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous
  }
})

test("the duplicate opt-out flag defaults off and accepts the existing boolean grammar", () => {
  const previous = process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT
  try {
    delete process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT
    expect(Flag.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT).toBe(false)
    for (const value of ["1", "true"]) {
      process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT = value
      expect(Flag.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT).toBe(true)
    }
    for (const value of ["0", "false"]) {
      process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT = value
      expect(Flag.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT).toBe(false)
    }
  } finally {
    if (previous == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT
    else process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT = previous
  }
})

test("disabling flood detection passes every call through", async () => {
  const previous = process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
  process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = "true"
  try {
    const input = source()
    const reading = collect(guardToolCallStream(input.stream))
    for (const index of Array.from({ length: 12 }, (_, index) => index)) input.controller.enqueue(call(String(index)))
    input.controller.enqueue(finish)
    input.controller.close()
    const events = await reading
    expect(input.state.cancelled).toBe(false)
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(12)
    expect(events.some((event) => event.type === "error")).toBe(false)
  } finally {
    if (previous == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
    else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous
  }
})

test("the actual SDK executes the first eight calls and drops the ninth", async () => {
  const input = source()
  const executed: string[] = []
  const result = streamText({
    onError: () => {},
    model: wrapLanguageModel({
      model: new MockLanguageModelV3({ doStream: async () => ({ stream: input.stream }) }),
      middleware: toolCallFloodingMiddleware,
    }),
    prompt: "Write files",
    tools: {
      write: tool({
        inputSchema: jsonSchema<{ value: string }>({
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        }),
        execute: async (args) => {
          executed.push(args.value)
          return "written"
        },
      }),
    },
  })
  for (const index of Array.from({ length: 9 }, (_, index) => index)) input.controller.enqueue(call(String(index)))
  input.controller.enqueue(finish)
  input.controller.close()
  for await (const _ of result.fullStream) void _
  expect(executed).toEqual(Array.from({ length: 8 }, (_, index) => String(index)))
})

test("in-flight tools finish after the ninth-call abort", async () => {
  const input = source()
  const executed: string[] = []
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const result = streamText({
    onError: () => {},
    model: wrapLanguageModel({
      model: new MockLanguageModelV3({ doStream: async () => ({ stream: input.stream }) }),
      middleware: toolCallFloodingMiddleware,
    }),
    prompt: "Write files",
    tools: {
      write: tool({
        inputSchema: jsonSchema<{ value: string }>({
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        }),
        execute: async (args) => {
          executed.push(args.value)
          await waiting
          return `result-${args.value}`
        },
      }),
    },
  })
  for (const index of Array.from({ length: 9 }, (_, index) => index)) input.controller.enqueue(call(String(index)))
  const reader = result.fullStream.getReader()
  while (true) {
    const event = await reader.read()
    if (event.done) break
    if (event.value?.type === "error") break
  }
  expect(input.state.cancelled).toBe(true)
  release()
  const results: string[] = []
  while (true) {
    const event = await reader.read()
    if (event.done) break
    if (event.value?.type === "tool-result") results.push(String(event.value.output))
  }
  expect(executed).toEqual(Array.from({ length: 8 }, (_, index) => String(index)))
  expect(results).toHaveLength(8)
})
