import { expect, test } from "bun:test"
import { shouldAutoResumeAfterTools } from "../../src/session/processor"

const completed = { state: { status: "completed" } }
const running = { state: { status: "running" } }
const pending = { state: { status: "pending" } }

test("[auto-resume after tools] completed tool + retryable transport → resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [completed],
    }),
  ).toBe(true)
})

test("[auto-resume after tools] still retrySafe (no tool yet) → no auto-resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: true,
      decision: { retryable: true },
      toolParts: [],
    }),
  ).toBe(false)
})

test("[auto-resume after tools] terminal error → no auto-resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: false },
      toolParts: [completed],
    }),
  ).toBe(false)
})

test("[auto-resume after tools] in-flight tool → no auto-resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [completed, running],
    }),
  ).toBe(false)
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [pending],
    }),
  ).toBe(false)
})

test("[auto-resume after tools] tool-call seen but none completed → no auto-resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [running],
    }),
  ).toBe(false)
})

test("[auto-resume after tools] aborted → no auto-resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [completed],
      aborted: true,
    }),
  ).toBe(false)
})

test("[auto-resume after tools] finish=stop + final text → no auto-resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [completed],
      finish: "stop",
      hasFinalText: true,
    }),
  ).toBe(false)
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [completed],
      finish: "other",
      hasFinalText: true,
    }),
  ).toBe(false)
})

test("[auto-resume after tools] finish=content-filter / error → no auto-resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [completed],
      finish: "content-filter",
    }),
  ).toBe(false)
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [completed],
      finish: "error",
    }),
  ).toBe(false)
})

test("[auto-resume after tools] finish=tool-calls + completed tools → resume", () => {
  expect(
    shouldAutoResumeAfterTools({
      retrySafe: false,
      decision: { retryable: true },
      toolParts: [completed],
      finish: "tool-calls",
    }),
  ).toBe(true)
})
