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
