import { expect, test } from "bun:test"
import { decide, budgetFor, resolve } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"

test("ETIMEDOUT APIError(Request timed out) is network persist-retry", () => {
  const err = new MessageV2.APIError({
    message: "Request timed out",
    isRetryable: true,
    metadata: { code: "ETIMEDOUT" },
  }).toObject()
  const decision = decide(err, "stream", "live-step")
  expect(decision.retryable).toBe(true)
  expect(decision.kind).toBe("network")
  const budget = budgetFor(resolve(undefined), decision)
  expect(budget.mode).toBe("persistent")
})

test("raw ETIMEDOUT Error is network persist-retry", () => {
  const err = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })
  const decision = decide(err, "request", "request")
  expect(decision.retryable).toBe(true)
  expect(decision.kind).toBe("network")
  expect(budgetFor(resolve(undefined), decision).mode).toBe("persistent")
})
