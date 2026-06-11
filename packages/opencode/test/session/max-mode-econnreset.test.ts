import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { runCandidate, judge, type MaxStepInput } from "../../src/session/max-mode"
import type { LLM } from "../../src/session/llm"

/**
 * Integration tests for the ECONNRESET fix: drive the REAL runCandidate / judge
 * with a mock llm.stream that emits an AI-SDK-style `error` stream PART (the SDK
 * does not throw on transient failures — it yields {type:"error"} then ends the
 * stream normally). These assert that:
 *   1. a transient error part is retried (not silently swallowed),
 *   2. retry uses a fresh accumulator (no duplicated text),
 *   3. a non-transient error part falls through to the catch fallback.
 *
 * The mock stream yields synchronously-constructed events, so the only real
 * wall-clock cost is persistentRetrySchedule's first backoff (~500ms/attempt).
 */

const econnreset = () => Object.assign(new Error("socket connection closed unexpectedly"), { code: "ECONNRESET" })
const httpBadRequest = () => Object.assign(new Error("Bad Request"), { status: 400 })

/** Build a mock LLM whose stream fails `failTimes` times (error part) then succeeds. */
function mockLLM(opts: {
  failTimes: number
  makeError: () => Error
  goodEvents: LLM.Event[]
  errorEvents?: LLM.Event[]
}): { llm: LLM.Interface; attempts: () => number } {
  let attempt = 0
  const llm = {
    buildSystemArray: () => Effect.succeed([]),
    stream: (_input: any): Stream.Stream<LLM.Event, unknown> => {
      const thisAttempt = attempt++
      const events: LLM.Event[] =
        thisAttempt < opts.failTimes
          ? [...(opts.errorEvents ?? []), { type: "error", error: opts.makeError() } as LLM.Event]
          : opts.goodEvents
      return Stream.fromIterable(events)
    },
  } as unknown as LLM.Interface
  return { llm, attempts: () => attempt }
}

function baseInput(llm: LLM.Interface): MaxStepInput {
  return {
    handle: {} as any,
    llm,
    user: {} as any,
    agent: {} as any,
    model: {} as any,
    sessionID: "ses_test",
    system: [],
    messages: [],
    tools: {},
  }
}

describe("max-mode ECONNRESET handling (integration)", () => {
  test("candidate retries a transient error part and recovers with a fresh accumulator", async () => {
    // Each attempt's "good" path emits text then finishes. On failing attempts
    // we ALSO emit a text-delta before the error part, to prove the retry does
    // not concatenate partial text from the failed attempt.
    const { llm, attempts } = mockLLM({
      failTimes: 2,
      makeError: econnreset,
      errorEvents: [{ type: "text-delta", text: "PARTIAL " } as LLM.Event],
      goodEvents: [
        { type: "reasoning-delta", text: "think" } as LLM.Event,
        { type: "text-delta", text: "final answer" } as LLM.Event,
        { type: "tool-call", toolCallId: "c1", toolName: "read", input: { filePath: "/x" } } as LLM.Event,
        { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2 } } as LLM.Event,
      ],
    })

    const candidate = await Effect.runPromise(runCandidate(baseInput(llm), 0))

    expect(candidate).not.toBeNull()
    expect(attempts()).toBe(3) // 2 failed + 1 success
    // fresh accumulator: NO "PARTIAL " leaked from the failed attempts
    expect(candidate!.text).toBe("final answer")
    expect(candidate!.reasoning).toBe("think")
    expect(candidate!.toolCalls).toHaveLength(1)
    expect(candidate!.toolCalls[0].toolName).toBe("read")
    expect(candidate!.finishReason).toBe("tool-calls")
  })

  test("candidate gives up (returns null) on a non-transient error part", async () => {
    const { llm, attempts } = mockLLM({
      failTimes: 99, // always fail
      makeError: httpBadRequest, // 400 → not transient → must NOT retry
      goodEvents: [],
    })

    const candidate = await Effect.runPromise(runCandidate(baseInput(llm), 0))

    expect(candidate).toBeNull()
    expect(attempts()).toBe(1) // no retry for a 400
  })

  test("judge retries a transient error part instead of collapsing to pick 0", async () => {
    // Two candidates; the judge should pick index 1. It fails once (transient)
    // then succeeds — a non-retrying judge would have returned pick 0.
    const { llm, attempts } = mockLLM({
      failTimes: 1,
      makeError: econnreset,
      goodEvents: [
        { type: "text-delta", text: "1" } as LLM.Event,
        { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } } as LLM.Event,
      ],
    })

    const candidates = [
      { index: 0, reasoning: "", text: "a", toolCalls: [], finishReason: "stop" },
      { index: 1, reasoning: "", text: "b", toolCalls: [], finishReason: "stop" },
    ]

    const result = await Effect.runPromise(judge(baseInput(llm), candidates as any))

    expect(attempts()).toBe(2) // 1 failed + 1 success
    expect(result.pick).toBe(1) // recovered the real pick, not the pick-0 fallback
  })

  test("judge falls back to pick 0 on a non-transient error part", async () => {
    const { llm, attempts } = mockLLM({
      failTimes: 99,
      makeError: httpBadRequest,
      goodEvents: [],
    })

    const candidates = [
      { index: 0, reasoning: "", text: "a", toolCalls: [], finishReason: "stop" },
      { index: 1, reasoning: "", text: "b", toolCalls: [], finishReason: "stop" },
    ]

    const result = await Effect.runPromise(judge(baseInput(llm), candidates as any))

    expect(attempts()).toBe(1) // no retry for a 400
    expect(result.pick).toBe(0) // graceful fallback
  })
})

describe("max-mode defect handling (SSE timeout surfaces as Cause.die)", () => {
  // Unlike an `error` stream PART, the real SSE-timeout / aborted-fetch error is
  // raised deep in the provider stream as a DEFECT (Cause.die). The old code
  // (retry + Effect.catch, no catchCause) let it escape the fiber as an
  // unhandled rejection that killed the whole session — exactly what the
  // eval logs showed (bare `error: SSE read timed out`, no candidate-failed
  // log, no retry). These tests drive the REAL runCandidate / judge with a
  // stream that dies mid-consumption and assert the defect is now contained.

  /** A mock LLM whose stream DIES (defect) `dieTimes` times, then succeeds. */
  function dyingLLM(opts: { dieTimes: number; makeError: () => Error; goodEvents: LLM.Event[] }) {
    let attempt = 0
    const llm = {
      buildSystemArray: () => Effect.succeed([]),
      stream: (_input: any): Stream.Stream<LLM.Event, unknown> => {
        const thisAttempt = attempt++
        if (thisAttempt < opts.dieTimes) {
          // throw inside Stream.tap's Effect.sync => surfaces as a DEFECT,
          // matching how the provider raises SSE timeout mid-stream.
          return Stream.fromIterable([{ type: "text-delta", text: "partial" } as LLM.Event]).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                throw opts.makeError()
              }),
            ),
          )
        }
        return Stream.fromIterable(opts.goodEvents)
      },
    } as unknown as LLM.Interface
    return { llm, attempts: () => attempt }
  }

  const sseTimeout = () => new Error("SSE read timed out")
  // A non-transient defect: not retried, so containment is proven in 1 attempt
  // without waiting out persistentRetrySchedule's ~8min backoff exhaustion.
  const fatalDefect = () => new Error("unexpected internal stream failure")

  test("candidate contains a transient defect and retries to recovery (no fiber crash)", async () => {
    const { llm, attempts } = dyingLLM({
      dieTimes: 2,
      makeError: sseTimeout, // "SSE read timed out" is transient -> retried
      goodEvents: [
        { type: "text-delta", text: "recovered" } as LLM.Event,
        { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } } as LLM.Event,
      ],
    })

    // runPromiseExit, not runPromise: if the defect escaped (old behaviour) this
    // would be a Failure/Die, not a Success.
    const exit = await Effect.runPromiseExit(runCandidate(baseInput(llm), 0))

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).not.toBeNull()
      expect(exit.value!.text).toBe("recovered")
    }
    expect(attempts()).toBe(3) // 2 defect attempts + 1 success
  })

  test("candidate degrades a defect to null instead of crashing the fiber", async () => {
    // Non-transient defect: catchCause contains it and catch degrades to null in
    // ONE attempt (no retry), which is the decisive containment property.
    const { llm, attempts } = dyingLLM({ dieTimes: 99, makeError: fatalDefect, goodEvents: [] })

    const exit = await Effect.runPromiseExit(runCandidate(baseInput(llm), 0))

    // The decisive assertion: the defect is CONTAINED (Success with null),
    // never escaping as a Die that would bubble to the session and kill it.
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBeNull()
    expect(attempts()).toBe(1) // non-transient -> not retried
  })

  test("judge contains a defect and falls back to pick 0", async () => {
    const { llm } = dyingLLM({ dieTimes: 99, makeError: fatalDefect, goodEvents: [] })
    const candidates = [
      { index: 0, reasoning: "", text: "a", toolCalls: [], finishReason: "stop" },
      { index: 1, reasoning: "", text: "b", toolCalls: [], finishReason: "stop" },
    ]

    const exit = await Effect.runPromiseExit(judge(baseInput(llm), candidates as any))

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.pick).toBe(0)
  })
})
