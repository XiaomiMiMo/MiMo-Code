import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { runCandidate, judge, type Candidate, type MaxStepInput } from "../../src/session/max-mode"
import type { LLM } from "../../src/session/llm"

function expectCandidate(value: Candidate | null | "text-repeat"): Candidate {
  if (!value || value === "text-repeat") throw new Error(`expected candidate, got ${String(value)}`)
  return value
}

/** Drive the real max-mode paths with provider errors and assert one attempt. */

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

describe("max-mode single-attempt error handling", () => {
  test("candidate preserves the model-visible active tool subset", async () => {
    let captured: LLM.StreamInput | undefined
    const llm = {
      buildSystemArray: () => Effect.succeed([]),
      stream: (input: LLM.StreamInput) => {
        captured = input
        return Stream.fromIterable([
          { type: "text-delta", text: "done" } as LLM.Event,
          { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } } as LLM.Event,
        ])
      },
    } as LLM.Interface
    const input = baseInput(llm)
    input.tools = {
      visible: { description: "visible" } as any,
      hidden_mcp: { description: "hidden" } as any,
    }
    input.activeTools = ["visible"]

    expectCandidate(await Effect.runPromise(runCandidate(input, 0)))

    expect(captured?.activeTools).toEqual(["visible"])
    expect(Object.keys(captured?.tools ?? {})).toEqual(["visible", "hidden_mcp"])
  })

  test("candidate discards a transient error part without another request", async () => {
    const { llm, attempts } = mockLLM({
      failTimes: 1,
      makeError: econnreset,
      errorEvents: [{ type: "text-delta", text: "PARTIAL " } as LLM.Event],
      goodEvents: [
        { type: "reasoning-delta", text: "think" } as LLM.Event,
        { type: "text-delta", text: "final answer" } as LLM.Event,
        { type: "tool-call", toolCallId: "c1", toolName: "read", input: { filePath: "/x" } } as LLM.Event,
        { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2 } } as LLM.Event,
      ],
    })

    expect(await Effect.runPromise(runCandidate(baseInput(llm), 0))).toBeNull()
    expect(attempts()).toBe(1)
  })

  test("candidate gives up (returns null) on a non-transient error part", async () => {
    const { llm, attempts } = mockLLM({
      failTimes: 99, // always fail
      makeError: httpBadRequest,
      goodEvents: [],
    })

    const candidate = await Effect.runPromise(runCandidate(baseInput(llm), 0))

    expect(candidate).toBeNull()
    expect(attempts()).toBe(1)
  })

  test("judge falls back after a transient error without another request", async () => {
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

    expect(attempts()).toBe(1)
    expect(result.pick).toBe(0)
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

    expect(attempts()).toBe(1)
    expect(result.pick).toBe(0)
  })
})

describe("max-mode defect handling (SSE timeout surfaces as Cause.die)", () => {
  // Unlike an `error` stream part, provider errors can surface as defects.
  // These tests assert they are contained without issuing another request.

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
  const fatalDefect = () => new Error("unexpected internal stream failure")

  test("candidate contains a transient defect without another request", async () => {
    const { llm, attempts } = dyingLLM({
      dieTimes: 1,
      makeError: sseTimeout,
      goodEvents: [
        { type: "text-delta", text: "recovered" } as LLM.Event,
        { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } } as LLM.Event,
      ],
    })

    const exit = await Effect.runPromiseExit(runCandidate(baseInput(llm), 0))

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBeNull()
    expect(attempts()).toBe(1)
  })

  test("candidate degrades a defect to null instead of crashing the fiber", async () => {
    const { llm, attempts } = dyingLLM({ dieTimes: 99, makeError: fatalDefect, goodEvents: [] })

    const exit = await Effect.runPromiseExit(runCandidate(baseInput(llm), 0))

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBeNull()
    expect(attempts()).toBe(1)
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
