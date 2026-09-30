import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { runCandidate, judge, type MaxStepInput } from "../../src/session/max-mode"
import type { LLM } from "../../src/session/llm"

/**
 * Runtime contract for max-mode ensemble streams (not a source-string scan).
 * - must NOT set ephemeral (multi-purpose: plugins/affinity/OTel/system)
 * - MUST set quietRetryDiagnostics so N parallel request ladders do not flood
 *   Session.Event.RetryAttempt on the shared sessionID
 */

function baseInput(llm: LLM.Interface): MaxStepInput {
  return {
    handle: {} as any,
    llm,
    user: {} as any,
    agent: {} as any,
    model: { providerID: "test", api: { id: "test-model" } } as any,
    sessionID: "ses_test",
    system: [],
    messages: [],
    tools: {},
  }
}

function captureLLM() {
  const calls: LLM.StreamInput[] = []
  const llm = {
    buildSystemArray: () => Effect.succeed([]),
    stream: (input: LLM.StreamInput) => {
      calls.push(input)
      return Stream.fromIterable([
        { type: "text-delta", text: "ok" } as LLM.Event,
        {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        } as unknown as LLM.Event,
      ])
    },
  } as unknown as LLM.Interface
  return { llm, calls }
}

describe("max-mode ensemble stream input contract", () => {
  test("candidate stream: quietRetryDiagnostics=true, ephemeral unset/false", async () => {
    const { llm, calls } = captureLLM()
    await Effect.runPromise(runCandidate(baseInput(llm), 0))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.quietRetryDiagnostics).toBe(true)
    expect(calls[0]?.retryScope).toBe("max-candidate")
    expect(calls[0]?.ephemeral).toBeFalsy()
  })

  test("judge stream: quietRetryDiagnostics=true, ephemeral unset/false", async () => {
    const { llm, calls } = captureLLM()
    const candidates = [
      { index: 0, reasoning: "r", text: "t", toolCalls: [], finishReason: "stop" as const },
      { index: 1, reasoning: "r2", text: "t2", toolCalls: [], finishReason: "stop" as const },
    ]
    await Effect.runPromise(judge(baseInput(llm), candidates))
    const judgeCall = calls.find((c) => c.toolChoice === "none")
    expect(judgeCall).toBeDefined()
    expect(judgeCall?.quietRetryDiagnostics).toBe(true)
    expect(judgeCall?.retryScope).toBe("max-judge")
    expect(judgeCall?.ephemeral).toBeFalsy()
  })
})
