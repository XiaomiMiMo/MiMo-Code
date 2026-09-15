import { test, expect } from "bun:test"
import { extract } from "../../src/history/extract"

test("extract tool output does not pre-clean media (cleaning happens before index write)", () => {
  const part = {
    type: "tool",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "echo" },
      output: "data:text/plain;base64,AAAA",
    },
  } as never
  const r = extract(part)
  expect(r?.body).toContain("data:text/plain;base64")
})
