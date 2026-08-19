import { describe, expect, test } from "bun:test"
import {
  ChatCompletionRequest,
  chunk,
  completion,
  finishReason,
  SpeechRequest,
  speechContentType,
  speechUnsupported,
  toModelMessages,
  toToolChoice,
  unsupported,
  usage,
  usageChunk,
} from "../../src/llm-server/protocol"

const base = { model: "test/test-model", messages: [{ role: "user" as const, content: "hi" }] }

function parse(body: unknown) {
  const result = ChatCompletionRequest.safeParse(body)
  if (!result.success) throw new Error(result.error.issues.map((i) => i.message).join("; "))
  return result.data
}

describe("request validation policy", () => {
  test("keeps unknown fields out of the parsed request instead of rejecting them", () => {
    // The primary use case is pointing a stock OpenAI client at this server, and
    // those clients send these fields unconditionally.
    const req = parse({
      ...base,
      parallel_tool_calls: true,
      store: false,
      metadata: { run: "1" },
      service_tier: "auto",
      modalities: ["text"],
    })
    expect(req.model).toBe("test/test-model")
    expect(req).not.toHaveProperty("parallel_tool_calls")
    expect(req).not.toHaveProperty("store")
    expect(req).not.toHaveProperty("metadata")
    expect(req).not.toHaveProperty("service_tier")
  })

  test("accepts the no-op defaults an untouched client sends", () => {
    const req = parse({ ...base, n: 1, presence_penalty: 0, frequency_penalty: 0, user: "someone" })
    expect(unsupported(req)).toBeUndefined()
  })

  test("refuses fields that would silently change the result", () => {
    expect(unsupported(parse({ ...base, n: 2 }))).toContain("n > 1")
    expect(unsupported(parse({ ...base, logprobs: true }))).toContain("logprobs")
    expect(unsupported(parse({ ...base, top_logprobs: 3 }))).toContain("top_logprobs")
    expect(unsupported(parse({ ...base, logit_bias: { "123": 5 } }))).toContain("logit_bias")
    expect(unsupported(parse({ ...base, response_format: { type: "json_object" } }))).toContain("response_format")
  })

  test("refuses verbosity rather than dropping a field the caller sent deliberately", () => {
    // Unlike reasoning effort there is no provider-agnostic mapping for it, and it
    // changes the answer, so silence is the one unacceptable outcome.
    expect(unsupported(parse({ ...base, verbosity: "low" }))).toContain("verbosity")
    expect(unsupported(parse({ ...base, verbosity: "low" }))).toContain("provider_options")
  })

  test("reasoning_effort is accepted at the schema level and resolved per model later", () => {
    // Deliberately not an enum: providers extend the set (none/xhigh/max), so the
    // check belongs where the model is known.
    expect(parse({ ...base, reasoning_effort: "high" }).reasoning_effort).toBe("high")
    expect(unsupported(parse({ ...base, reasoning_effort: "high" }))).toBeUndefined()
  })

  test("an empty logit_bias is not a request for anything", () => {
    expect(unsupported(parse({ ...base, logit_bias: {} }))).toBeUndefined()
  })

  test("still rejects structurally invalid requests", () => {
    expect(ChatCompletionRequest.safeParse({ model: "", messages: [] }).success).toBe(false)
    expect(ChatCompletionRequest.safeParse({ ...base, temperature: 9 }).success).toBe(false)
    expect(ChatCompletionRequest.safeParse({ messages: base.messages }).success).toBe(false)
  })
})

describe("message conversion", () => {
  test("maps developer role onto system", () => {
    expect(toModelMessages(parse({ ...base, messages: [{ role: "developer", content: "rules" }] }).messages)).toEqual([
      { role: "system", content: "rules" },
    ])
  })

  test("flattens an array of text parts into one string", () => {
    const messages = parse({
      ...base,
      messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
    }).messages
    expect(toModelMessages(messages)).toEqual([{ role: "system", content: "ab" }])
  })

  test("splits a data: image URL into inline base64 plus its media type", () => {
    const messages = parse({
      ...base,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } }],
        },
      ],
    }).messages
    expect(toModelMessages(messages)).toEqual([
      { role: "user", content: [{ type: "image", image: "AAAB", mediaType: "image/png" }] },
    ])
  })

  test("leaves a remote image as a URL for the provider to fetch", () => {
    const messages = parse({
      ...base,
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
      ],
    }).messages
    const converted = toModelMessages(messages)
    expect(converted[0]!.role).toBe("user")
    expect(converted[0]!.content).toEqual([{ type: "image", image: new URL("https://example.com/a.png") }])
  })

  test("recovers the tool name a role:tool message omits", () => {
    // OpenAI keys tool results by tool_call_id only; ToolResultPart requires the
    // name, so it has to come from the assistant turn that made the call.
    const messages = parse({
      ...base,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"BJ"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    }).messages
    const converted = toModelMessages(messages)
    expect(converted[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "BJ" } }],
    })
    expect(converted[2]).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "get_weather", output: { type: "text", value: "sunny" } },
      ],
    })
  })

  test("carries assistant text and tool calls in one message", () => {
    const messages = parse({
      ...base,
      messages: [
        {
          role: "assistant",
          content: "checking",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
      ],
    }).messages
    expect(toModelMessages(messages)[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool-call", toolCallId: "c1", toolName: "f", input: {} },
      ],
    })
  })

  test("replays assistant reasoning as a reasoning part, ahead of text and tool calls", () => {
    // Providers that interleave thinking with tool use read the ORDER, not just the
    // set, so reasoning has to come first. Dropping it silently degrades the next turn.
    const messages = parse({
      ...base,
      messages: [
        {
          role: "assistant",
          content: "checking",
          reasoning_content: "the user wants the weather",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
      ],
    }).messages
    expect(toModelMessages(messages)[0]).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "the user wants the weather" },
        { type: "text", text: "checking" },
        { type: "tool-call", toolCallId: "c1", toolName: "f", input: {} },
      ],
    })
  })

  test("reasoning alone still produces a part array, not a bare string", () => {
    const messages = parse({
      ...base,
      messages: [{ role: "assistant", content: "answer", reasoning_content: "thought" }],
    }).messages
    expect(toModelMessages(messages)[0]).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thought" },
        { type: "text", text: "answer" },
      ],
    })
  })

  test("keeps unparseable tool arguments as raw text rather than throwing", () => {
    // The request is replaying history the model itself produced; rejecting it
    // would strand the conversation.
    const messages = parse({
      ...base,
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{not json" } }],
        },
      ],
    }).messages
    const content = toModelMessages(messages)[0]!.content
    expect(content).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "f", input: "{not json" }])
  })
})

describe("tool choice", () => {
  test("passes the string forms through and names the tool for the object form", () => {
    expect(toToolChoice(undefined)).toBeUndefined()
    expect(toToolChoice("auto")).toBe("auto")
    expect(toToolChoice("none")).toBe("none")
    expect(toToolChoice("required")).toBe("required")
    expect(toToolChoice({ type: "function", function: { name: "f" } })).toEqual({ type: "tool", toolName: "f" })
  })
})

describe("finish reason", () => {
  test("translates the SDK vocabulary into OpenAI's", () => {
    expect(finishReason("tool-calls")).toBe("tool_calls")
    expect(finishReason("length")).toBe("length")
    expect(finishReason("content-filter")).toBe("content_filter")
    expect(finishReason("stop")).toBe("stop")
    // Everything else collapses to stop: OpenAI has no vocabulary for them.
    expect(finishReason("error")).toBe("stop")
    expect(finishReason("other")).toBe("stop")
    expect(finishReason(undefined)).toBe("stop")
  })
})

describe("usage", () => {
  test("reports zeros rather than omitting counts when usage is absent", () => {
    expect(usage(undefined)).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  })

  test("derives the total when the provider does not report one", () => {
    expect(usage({ inputTokens: 3, outputTokens: 4 } as never)).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    })
  })

  test("surfaces cache reads and reasoning tokens under OpenAI's detail keys", () => {
    expect(
      usage({
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        inputTokenDetails: { cacheReadTokens: 8 },
        outputTokenDetails: { reasoningTokens: 1 },
      } as never),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 1 },
    })
  })
})

describe("response bodies", () => {
  const shared = { id: "chatcmpl-1", model: "test/test-model", created: 100 }

  test("uses null content when the turn produced only tool calls", () => {
    const body = completion({
      ...shared,
      text: "",
      toolCalls: [{ id: "c1", name: "f", input: { a: 1 } }],
      finishReason: "tool-calls",
      usage: undefined,
    })
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]!.message.content).toBeNull()
    expect(body.choices[0]!.finish_reason).toBe("tool_calls")
    expect(body.choices[0]!.message).toMatchObject({
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
    })
  })

  test("omits the tool_calls key entirely for a plain text answer", () => {
    const body = completion({ ...shared, text: "hello", toolCalls: [], finishReason: "stop", usage: undefined })
    expect(body.choices[0]!.message.content).toBe("hello")
    expect(body.choices[0]!.message).not.toHaveProperty("tool_calls")
  })

  test("a non-terminal chunk reports a null finish_reason and carries no usage", () => {
    const frame = chunk({ ...shared, delta: { content: "a" } })
    expect(frame.object).toBe("chat.completion.chunk")
    expect(frame.choices[0]!.finish_reason).toBeNull()
    expect(frame).not.toHaveProperty("usage")
  })

  test("the usage-only chunk carries an empty choices array, as OpenAI sends it", () => {
    const frame = usageChunk({ ...shared, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never })
    expect(frame.choices).toEqual([])
    expect(frame.usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 1 })
  })
})

describe("speech requests", () => {
  const speech = { model: "test/test-tts", input: "hello" }

  test("accepts OpenAI's shape and ignores unknown fields", () => {
    const req = SpeechRequest.parse({ ...speech, voice: "alloy", response_format: "wav", speed: 1.5, unknown: 1 })
    expect(req.voice).toBe("alloy")
    expect(req.response_format).toBe("wav")
    expect(req).not.toHaveProperty("unknown")
  })

  test("rejects an empty input and an out-of-range speed", () => {
    expect(SpeechRequest.safeParse({ ...speech, input: "" }).success).toBe(false)
    expect(SpeechRequest.safeParse({ ...speech, speed: 9 }).success).toBe(false)
    expect(SpeechRequest.safeParse({ ...speech, response_format: "ogg" }).success).toBe(false)
  })

  test("refuses SSE streaming rather than returning one buffer to a client awaiting frames", () => {
    expect(speechUnsupported(SpeechRequest.parse({ ...speech, stream_format: "sse" }))).toContain("stream_format")
    expect(speechUnsupported(SpeechRequest.parse({ ...speech, stream_format: "audio" }))).toBeUndefined()
    expect(speechUnsupported(SpeechRequest.parse(speech))).toBeUndefined()
  })
})

describe("speech content type", () => {
  test("prefers what the provider reported, since that describes the actual bytes", () => {
    expect(speechContentType({ reported: "audio/flac", requested: "mp3" })).toBe("audio/flac")
  })

  test("treats `audio/mp3` as no answer, because that is the SDK's sniff-failed fallback", () => {
    // generateSpeech reports `detectMediaType(bytes) ?? "audio/mp3"`, and a
    // successfully sniffed mp3 is spelled `audio/mpeg`. So `audio/mp3` means "could
    // not tell", and honouring it would relabel a flac the caller asked for.
    expect(speechContentType({ reported: "audio/mp3", requested: "flac" })).toBe("audio/flac")
    expect(speechContentType({ reported: "audio/mp3", requested: "wav" })).toBe("audio/wav")
  })

  test("a genuinely sniffed mp3 is honoured, since it arrives as audio/mpeg", () => {
    expect(speechContentType({ reported: "audio/mpeg", requested: "flac" })).toBe("audio/mpeg")
  })

  test("never emits the non-standard audio/mp3 alias, even when that is all it got", () => {
    expect(speechContentType({ reported: "audio/mp3" })).toBe("audio/mpeg")
  })

  test("falls back to the requested format when the provider reports nothing", () => {
    expect(speechContentType({ requested: "wav" })).toBe("audio/wav")
    expect(speechContentType({ requested: "opus" })).toBe("audio/opus")
  })

  test("declines to name an unrecognized format rather than mislabeling it", () => {
    expect(speechContentType({ requested: "weird" })).toBe("application/octet-stream")
  })

  test("defaults to mp3 when neither side said anything", () => {
    expect(speechContentType({})).toBe("audio/mpeg")
  })
})
