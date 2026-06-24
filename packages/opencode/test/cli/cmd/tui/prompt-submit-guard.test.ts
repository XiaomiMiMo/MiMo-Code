import { describe, expect, test } from "bun:test"
import { createPromptSubmitGuard } from "../../../../src/cli/cmd/tui/component/prompt/submit-guard"

describe("prompt submit guard", () => {
  test("blocks duplicate submits until the active run returns idle", () => {
    const guard = createPromptSubmitGuard()

    expect(guard.tryStart("idle")).toBe(true)
    expect(guard.tryStart("idle")).toBe(false)

    guard.update("busy")
    expect(guard.tryStart("busy")).toBe(false)

    guard.update("idle")
    expect(guard.tryStart("idle")).toBe(true)
  })

  test("releases when prompt dispatch fails before a run starts", () => {
    const guard = createPromptSubmitGuard()

    expect(guard.tryStart("idle")).toBe(true)
    guard.fail()

    expect(guard.tryStart("idle")).toBe(true)
  })

  test("can release if no run status arrives after dispatch", () => {
    const guard = createPromptSubmitGuard()

    expect(guard.tryStart("idle")).toBe(true)
    guard.releaseIfUnstarted("idle")

    expect(guard.tryStart("idle")).toBe(true)
  })
})
