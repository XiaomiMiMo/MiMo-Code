import { expect, test } from "bun:test"

const { formatRetryStatusMessage, RETRY_STATUS_MESSAGE_LIMIT } = await import(
  "../../../src/cli/cmd/tui/component/prompt/status-message"
)

test("retry status message renders structured errors on one line", () => {
  const result = formatRetryStatusMessage(`mimo-free bootstrap failed: 429 {
  "error": {
    "code": "429",
    "message": "Too many requests",
    "type": "limitation"
  }
}`)

  expect(result.message).not.toContain("\n")
  expect(result.message).toStartWith("mimo-free bootstrap failed: 429")
  expect(result.truncated).toBe(true)
})

test("retry status message truncates long single-line errors", () => {
  const result = formatRetryStatusMessage("x".repeat(RETRY_STATUS_MESSAGE_LIMIT + 1))

  expect(result.message).toBe("x".repeat(RETRY_STATUS_MESSAGE_LIMIT) + "...")
  expect(result.truncated).toBe(true)
})

test("retry status message keeps short text unchanged", () => {
  const result = formatRetryStatusMessage("Internal server error")

  expect(result.message).toBe("Internal server error")
  expect(result.truncated).toBe(false)
})

test("retry status message keeps the gemini quota shorthand", () => {
  const result = formatRetryStatusMessage("gemini exceeded your current quota")

  expect(result.message).toBe("gemini is way too hot right now")
  expect(result.truncated).toBe(false)
})
