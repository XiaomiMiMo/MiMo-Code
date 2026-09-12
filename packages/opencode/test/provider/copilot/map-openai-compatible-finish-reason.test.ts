import { describe, expect, mock, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { mapOpenAICompatibleFinishReason } from "@/provider/sdk/copilot/chat/map-openai-compatible-finish-reason"
import { OpenAICompatibleChatLanguageModel } from "@/provider/sdk/copilot/chat/openai-compatible-chat-language-model"

// Gateways such as opencode.ai/zen/go/v1 (serving muse-spark) never send a
// finish_reason: absent from streaming chunks, null in non-streaming. A
// missing value is a normal completion, so it must map to "stop" — only an
// unrecognized non-empty value is "other" (#2173).
describe("mapOpenAICompatibleFinishReason", () => {
  test("maps a missing finish_reason to stop", () => {
    expect(mapOpenAICompatibleFinishReason(null)).toBe("stop")
    expect(mapOpenAICompatibleFinishReason(undefined)).toBe("stop")
  })

  test("maps recognized values unchanged", () => {
    expect(mapOpenAICompatibleFinishReason("stop")).toBe("stop")
    expect(mapOpenAICompatibleFinishReason("length")).toBe("length")
    expect(mapOpenAICompatibleFinishReason("content_filter")).toBe("content-filter")
    expect(mapOpenAICompatibleFinishReason("tool_calls")).toBe("tool-calls")
    expect(mapOpenAICompatibleFinishReason("function_call")).toBe("tool-calls")
  })

  test("still flags unrecognized non-empty values as other", () => {
    expect(mapOpenAICompatibleFinishReason("weird_reason")).toBe("other")
  })
})

const TEST_PROMPT: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]

// muse-spark-style stream: content deltas arrive but no chunk ever carries a
// finish_reason, and the stream just ends after [DONE].
const MUSE_SPARK_FIXTURE = [
  `data: {"id":"chatcmpl-muse","object":"chat.completion.chunk","created":1756000000,"model":"muse-spark-1.2-contributor","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}`,
  `data: {"id":"chatcmpl-muse","object":"chat.completion.chunk","created":1756000000,"model":"muse-spark-1.2-contributor","choices":[{"index":0,"delta":{"content":" there"}}]}`,
  `data: [DONE]`,
]

async function convertReadableStreamToArray<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader()
  const result: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result.push(value)
  }
  return result
}

describe("doStream without finish_reason", () => {
  test("completes with finish=stop when the gateway never sends one", async () => {
    const fetchFn = mock(async () => {
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of MUSE_SPARK_FIXTURE) {
            controller.enqueue(new TextEncoder().encode(chunk + "\n\n"))
          }
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    })

    const model = new OpenAICompatibleChatLanguageModel("muse-spark-1.2-contributor", {
      provider: "copilot.chat",
      url: () => "https://api.test.com/chat/completions",
      headers: () => ({ Authorization: "Bearer test-token" }),
      fetch: fetchFn as any,
    })

    const { stream } = await model.doStream({
      prompt: TEST_PROMPT,
      includeRawChunks: false,
    })

    const parts = await convertReadableStreamToArray(stream)
    const finish = parts.find((p) => p.type === "finish")

    expect(finish).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
  })
})
