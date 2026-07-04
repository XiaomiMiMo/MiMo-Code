import { expect, test } from "bun:test"
import type { AssistantMessage } from "@mimo-ai/sdk/v2"
import { contextTokens } from "../../../src/cli/cmd/tui/util/context-tokens"

const message = (input: {
  input: number
  output: number
  reasoning: number
  read: number
  write: number
  summary?: boolean
}) => {
  return {
    role: "assistant",
    summary: input.summary,
    tokens: {
      input: input.input,
      output: input.output,
      reasoning: input.reasoning,
      cache: { read: input.read, write: input.write },
    },
  } as unknown as AssistantMessage
}

test("sums every token class for a normal assistant message", () => {
  const tokens = contextTokens(message({ input: 300, output: 100, reasoning: 50, read: 25, write: 25 }))
  expect(tokens).toBe(500)
})

test("counts only output for a compaction summary message", () => {
  const tokens = contextTokens(
    message({ input: 900000, output: 8000, reasoning: 2000, read: 50000, write: 0, summary: true }),
  )
  expect(tokens).toBe(8000)
})
