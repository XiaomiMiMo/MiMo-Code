import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"

describe("LLM RL generate result events", () => {
  test("adapts reasoning, text, tool calls, results, usage, and finish metadata", () => {
    const events = LLM.eventsFromGenerateResult({
      steps: [
        {
          content: [
            { type: "reasoning", text: "think", providerMetadata: { test: { signed: true } } },
            { type: "text", text: "answer", providerMetadata: { test: { text: true } } },
            { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" } },
            { type: "tool-result", toolCallId: "call-1", toolName: "read", output: "ok" },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
          providerMetadata: { test: { finish: true } },
        },
      ],
    })

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-end",
      "tool-call",
      "tool-result",
      "finish-step",
      "finish",
    ])
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({
      toolCallId: "call-1",
      toolName: "read",
      input: { path: "a" },
    })
    expect(events.find((event) => event.type === "finish-step")).toMatchObject({
      finishReason: "tool-calls",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      providerMetadata: { test: { finish: true } },
    })
  })
})
