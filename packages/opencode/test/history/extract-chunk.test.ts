import { test, expect } from "bun:test"
import { extract } from "../../src/history/extract"

test("extract strips data-URLs before tool-result preview budget", () => {
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
  expect(r).not.toBeNull()
  expect(r!.body).not.toContain("AAAA")
  expect(r!.body).toContain("bash")
})
