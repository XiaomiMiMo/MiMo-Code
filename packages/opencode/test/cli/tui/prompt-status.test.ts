import { expect, test } from "bun:test"
import { visiblePromptStatus } from "../../../src/cli/cmd/tui/component/prompt/status"

test("hides retry status from a previously selected model", () => {
  expect(
    visiblePromptStatus(
      {
        type: "retry",
        attempt: 1,
        message: "quota exceeded",
        next: Date.now() + 1000,
        providerID: "glm",
        modelID: "glm-4.5",
      },
      { providerID: "mimo", modelID: "mimo-auto" },
    ),
  ).toEqual({ type: "idle" })
})

test("keeps retry status for the current model", () => {
  const status = {
    type: "retry" as const,
    attempt: 1,
    message: "quota exceeded",
    next: Date.now() + 1000,
    providerID: "glm",
    modelID: "glm-4.5",
  }

  expect(visiblePromptStatus(status, { providerID: "glm", modelID: "glm-4.5" })).toBe(status)
})
