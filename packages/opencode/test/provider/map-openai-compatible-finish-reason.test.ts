import { describe, expect, test } from "bun:test"
import { mapOpenAICompatibleFinishReason } from "../../src/provider/sdk/copilot/chat/map-openai-compatible-finish-reason"

describe("mapOpenAICompatibleFinishReason", () => {
  test("null finish_reason maps to stop (gateway completed normally)", () => {
    expect(mapOpenAICompatibleFinishReason(null)).toBe("stop")
  })

  test("undefined finish_reason maps to stop (stream ended without signal)", () => {
    expect(mapOpenAICompatibleFinishReason(undefined)).toBe("stop")
  })

  test("stop maps to stop (no regression)", () => {
    expect(mapOpenAICompatibleFinishReason("stop")).toBe("stop")
  })

  test("length maps to length (no regression)", () => {
    expect(mapOpenAICompatibleFinishReason("length")).toBe("length")
  })

  test("tool_calls maps to tool-calls (no regression)", () => {
    expect(mapOpenAICompatibleFinishReason("tool_calls")).toBe("tool-calls")
  })

  test("other maps to other (no regression)", () => {
    expect(mapOpenAICompatibleFinishReason("other")).toBe("other")
  })

  test("content_filter maps to content-filter (no regression)", () => {
    expect(mapOpenAICompatibleFinishReason("content_filter")).toBe("content-filter")
  })

  test("empty string falls through to other", () => {
    expect(mapOpenAICompatibleFinishReason("")).toBe("other")
  })
})
