import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { runCandidate, judge, type MaxStepInput } from "../../src/session/max-mode"
import type { LLM } from "../../src/session/llm"
import { SessionRetry } from "../../src/session/retry"

/**
 * [engine-retry-status-density] Max-mode ensemble draws share sessionID and run
 * in parallel. Non-ephemeral llm.stream would publish request-phase
 * session.status{retry} once per attempt on every candidate — default
 * DEFAULT_CANDIDATES(5) × request maxRetries(4) ≈ 20 events, which desktop
 * renders as one "正在重新连接 20" streak that does not look like exponential
 * backoff even though each path's delay schedule is correct.
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
  const calls: Array<{ ephemeral?: boolean; scope: string }> = []
  const llm = {
    buildSystemArray: () => Effect.succeed([]),
    stream: (input: LLM.StreamInput) => {
      calls.push({ ephemeral: input.ephemeral, scope: input.toolChoice === "none" ? "judge" : "candidate" })
      return Stream.fromIterable([
        { type: "text-delta", text: "ok" } as LLM.Event,
        { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } } as LLM.Event,
      ])
    },
  } as unknown as LLM.Interface
  return { llm, calls }
}

describe("max-mode ensemble streams are ephemeral", () => {
  test("candidate llm.stream passes ephemeral:true so request retries skip session.status", async () => {
    const { llm, calls } = captureLLM()
    await Effect.runPromise(runCandidate(baseInput(llm), 0))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.ephemeral).toBe(true)
  })

  test("judge llm.stream passes ephemeral:true", async () => {
    const { llm, calls } = captureLLM()
    const candidates = [
      { index: 0, reasoning: "r", text: "t", toolCalls: [], finishReason: "stop" as const },
      { index: 1, reasoning: "r2", text: "t2", toolCalls: [], finishReason: "stop" as const },
    ]
    await Effect.runPromise(judge(baseInput(llm), candidates))
    expect(calls.some((c) => c.scope === "judge" && c.ephemeral === true)).toBe(true)
  })

  test("default request budget cannot produce 20 publishes from a single non-parallel path in 32s", () => {
    // Documented upper bound for ONE request-phase ladder (no Retry-After hint).
    const resolved = SessionRetry.resolve(undefined, "test")
    const decision = {
      retryable: true as const,
      phase: "request" as const,
      scope: "request" as const,
      kind: "network" as const,
      message: "network",
    }
    const budget = SessionRetry.budgetFor(resolved, decision)
    expect(budget.maxRetries).toBe(4)
    const delays = [1, 2, 3, 4].map((attempt) =>
      SessionRetry.retryDelay(attempt, decision, budget.jitterRatio, budget.initialDelayMs, budget.maxDelayMs),
    )
    // 200 * 2^(n-1) with ~10% jitter; sum of waits << 32s, publishes ≤ 4
    expect(delays.length).toBe(4)
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThan(10_000)
    // 5 parallel candidates × 4 request retries is the stacking arithmetic the UI saw
    expect(5 * (budget.maxRetries ?? 0)).toBe(20)
  })
})
