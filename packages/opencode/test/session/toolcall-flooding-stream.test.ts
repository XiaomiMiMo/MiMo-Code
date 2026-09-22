import { expect, test } from "bun:test"
import type { LanguageModelV3StreamPart, LanguageModelV3ToolCall } from "@ai-sdk/provider"
import { jsonSchema, streamText, tool, wrapLanguageModel } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import {
  guardToolCallStream,
  ToolCallFloodingError,
  TOOLCALL_FLOODING_REMINDER,
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

test("the actual SDK executes all 16 calls only after provider finish", async () => {
  const input = source()
  const executed: string[] = []
  const result = streamText({
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
  for (const index of Array.from({ length: 16 }, (_, index) => index)) input.controller.enqueue(call(String(index)))
  input.controller.enqueue({ type: "text-start", id: "text" })
  input.controller.enqueue({ type: "text-delta", id: "text", delta: "Still generating" })
  const reader = result.fullStream.getReader()
  while (true) {
    const event = await reader.read()
    if (event.value?.type === "text-delta") break
    expect(event.done).toBe(false)
  }
  expect(executed).toEqual([])
  input.controller.enqueue({ type: "text-end", id: "text" })
  input.controller.enqueue(finish)
  input.controller.close()
  while (!(await reader.read()).done) {}
  expect(executed).toEqual(Array.from({ length: 16 }, (_, index) => String(index)))
})

test("call 17 aborts an unfinished source before its arguments arrive", async () => {
  const input = source()
  const reading = collect(guardToolCallStream(input.stream))
  for (const index of Array.from({ length: 17 }, (_, index) => index)) {
    input.controller.enqueue({ type: "tool-input-start", id: String(index), toolName: "write" })
    if (index < 16) {
      input.controller.enqueue({ type: "tool-input-delta", id: String(index), delta: '{"value":"test"}' })
      input.controller.enqueue(call(String(index)))
    }
  }
  const events = await reading
  expect(input.state.cancelled).toBe(true)
  expect(events.filter((event) => event.type === "tool-call")).toEqual([call("0")])
  expect(events.filter((event) => event.type === "tool-input-start")).toHaveLength(17)
  const error = events.find((event) => event.type === "error")
  expect(error?.error).toBeInstanceOf(ToolCallFloodingError)
  if (!(error?.error instanceof ToolCallFloodingError)) throw new Error("Missing flooding error")
  expect(error.error.calls).toHaveLength(17)
  expect(error.error.calls.at(-1)?.input).toBe("")
})

test("complete-only calls and repeated provider call IDs cannot bypass the cap", async () => {
  for (const duplicate of [false, true]) {
    const input = source()
    const reading = collect(guardToolCallStream(input.stream))
    for (const index of Array.from({ length: 17 }, (_, index) => index)) {
      input.controller.enqueue(call(duplicate ? "same" : String(index)))
    }
    const events = await reading
    expect(events.filter((event) => event.type === "tool-call")).toEqual(duplicate ? [] : [call("0")])
    expect(events.find((event) => event.type === "error")?.error).toBeInstanceOf(ToolCallFloodingError)
    expect(input.state.cancelled).toBe(true)
  }
})

test("start and completion count once, and independent requests have independent buffers", async () => {
  const first = source()
  const second = source()
  const firstReading = collect(guardToolCallStream(first.stream))
  const secondReading = collect(guardToolCallStream(second.stream))
  for (const input of [first, second]) {
    for (const index of Array.from({ length: 16 }, (_, index) => index)) {
      input.controller.enqueue({ type: "tool-input-start", id: String(index), toolName: "write" })
      input.controller.enqueue(call(String(index)))
    }
  }
  second.controller.enqueue(finish)
  second.controller.close()
  expect((await secondReading).filter((event) => event.type === "tool-call")).toHaveLength(16)
  first.controller.enqueue(finish)
  first.controller.close()
  expect((await firstReading).filter((event) => event.type === "tool-call")).toHaveLength(16)
})

for (const ending of ["eof", "error", "throw"] as const) {
  test(`${ending} before finish never releases buffered tools`, async () => {
    const input = source()
    const events: LanguageModelV3StreamPart[] = []
    const reading = (async () => {
      const reader = guardToolCallStream(input.stream).getReader()
      while (true) {
        const event = await reader.read()
        if (event.done) break
        events.push(event.value)
      }
    })()
    input.controller.enqueue(call("first"))
    input.controller.enqueue({ type: "text-start", id: "text" })
    input.controller.enqueue({ type: "text-delta", id: "text", delta: "before failure" })
    if (ending === "eof") input.controller.close()
    if (ending === "error") input.controller.enqueue({ type: "error", error: new Error("transport failed") })
    if (ending === "throw") input.controller.error(new Error("transport failed"))
    if (ending === "throw") {
      expect(await reading.catch((error: unknown) => error)).toMatchObject({ message: "transport failed" })
    }
    if (ending !== "throw") await reading
    expect(events.some((event) => event.type === "tool-call")).toBe(false)
    if (ending !== "throw") expect(events.some((event) => event.type === "error")).toBe(true)
  })
}

test("downstream cancellation discards buffered tools and cancels the provider", async () => {
  const input = source()
  const reader = guardToolCallStream(input.stream).getReader()
  input.controller.enqueue(call("first"))
  expect((await reader.read()).value?.type).toBe("tool-input-start")
  await reader.cancel()
  expect(input.state.cancelled).toBe(true)
  expect((await reader.read()).done).toBe(true)
})

test("recovery repeats the current system prompt tool-call guidance verbatim", async () => {
  const prompt = await Bun.file(new URL("../../src/session/prompt/default.txt", import.meta.url)).text()
  const guidance = prompt.split("\n").find((line) => line.includes("Prefer 1–3 tool calls per step."))
  expect(guidance).toBeDefined()
  expect(TOOLCALL_FLOODING_REMINDER).toContain(guidance!.replace(/^- /, ""))
})

test("the opt-out flag defaults off and accepts the existing boolean grammar", () => {
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

test("disabling the production middleware restores SDK execution during generation", async () => {
  const previous = process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
  process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = "true"
  const input = source()
  try {
    const result = streamText({
      model: wrapLanguageModel({
        model: new MockLanguageModelV3({ doStream: async () => ({ stream: input.stream }) }),
        middleware: toolCallFloodingMiddleware,
      }),
      prompt: "Write files",
      tools: { write: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "written" }) },
    })
    input.controller.enqueue(call("first"))
    const reader = result.fullStream.getReader()
    while (true) {
      const event = await reader.read()
      expect(event.done).toBe(false)
      if (event.value?.type === "tool-result") break
    }
    input.controller.enqueue(finish)
    input.controller.close()
    while (!(await reader.read()).done) {}
  } finally {
    if (previous == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
    else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous
  }
})

for (const incomplete of [false, true]) {
  test(`flooding with delta-only inputs admits ${incomplete ? "no incomplete call" : "only the first call"}`, async () => {
    const input = source()
    const reading = collect(guardToolCallStream(input.stream))
    for (const index of Array.from({ length: 17 }, (_, index) => index)) {
      input.controller.enqueue({ type: "tool-input-start", id: String(index), toolName: "write" })
      if (index < 16)
        input.controller.enqueue({
          type: "tool-input-delta",
          id: String(index),
          delta: index === 0 && incomplete ? '{"value":' : JSON.stringify({ value: String(index) }),
        })
    }
    const events = await reading
    expect(input.state.cancelled).toBe(true)
    expect(events.filter((event) => event.type === "tool-call")).toEqual(incomplete ? [] : [call("0")])
  })
}

test("flooding never replays a provider-executed first call as a client call", async () => {
  const input = source()
  const reading = collect(guardToolCallStream(input.stream))
  input.controller.enqueue({
    type: "tool-call",
    toolCallId: "0",
    toolName: "write",
    input: '{"value":"0"}',
    providerExecuted: true,
  })
  for (const index of Array.from({ length: 16 }, (_, index) => index + 1)) input.controller.enqueue(call(String(index)))
  const events = await reading
  expect(events.filter((event) => event.type === "tool-call")).toHaveLength(0)
  expect(input.state.cancelled).toBe(true)
})

test("the actual SDK lets the first flooded call finish after upstream cancellation", async () => {
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
          return "first result"
        },
      }),
    },
  })
  for (const index of Array.from({ length: 17 }, (_, index) => index)) input.controller.enqueue(call(String(index)))
  const reader = result.fullStream.getReader()
  while (true) {
    const event = await reader.read()
    expect(event.done).toBe(false)
    if (event.value?.type === "error") break
  }
  expect(input.state.cancelled).toBe(true)
  release()
  const events = []
  while (true) {
    const event = await reader.read()
    if (event.done) break
    events.push(event.value)
  }
  expect(executed).toEqual(["0"])
  expect(events.filter((event) => event.type === "tool-result")).toMatchObject([
    { toolCallId: "0", output: "first result" },
  ])
})
