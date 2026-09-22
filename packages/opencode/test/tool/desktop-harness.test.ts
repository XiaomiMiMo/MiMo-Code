import { afterEach, expect, test } from "bun:test"
import { usesGPTToolset, isMcpToolSearchEnabled } from "../../src/tool/gpt"

const client = process.env.MIMOCODE_CLIENT
const mode = process.env.MIMOCODE_CODEX_MODE
afterEach(() => {
  if (client === undefined) delete process.env.MIMOCODE_CLIENT
  else process.env.MIMOCODE_CLIENT = client
  if (mode === undefined) delete process.env.MIMOCODE_CODEX_MODE
  else process.env.MIMOCODE_CODEX_MODE = mode
})

// Desktop exec-mode [TP-R4-03]: a session's fixed harness is the authority.
test("Desktop session harness isolates native and exec conversations from model and environment", () => {
  process.env.MIMOCODE_CLIENT = "desktop"
  for (const flag of ["true", "false", ""]) {
    process.env.MIMOCODE_CODEX_MODE = flag
    for (const model of ["test/model", "gpt-5.2", "gpt-oss-120b"]) {
      for (const harness of [undefined, "auto", "default", "codex"] as const) {
        expect(usesGPTToolset(model, harness)).toBe(harness === "codex")
        expect(isMcpToolSearchEnabled(false, harness, model)).toBe(harness === "codex")
      }
    }
  }
})

test("CLI retains process override and model inference", () => {
  process.env.MIMOCODE_CLIENT = "cli"
  delete process.env.MIMOCODE_CODEX_MODE
  expect(usesGPTToolset("gpt-5.2")).toBe(true)
  expect(usesGPTToolset("test/model")).toBe(false)
  process.env.MIMOCODE_CODEX_MODE = "false"
  expect(usesGPTToolset("test/model", "codex")).toBe(false)
})
