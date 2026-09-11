import { describe, expect, test } from "bun:test"
import { unchangedTitle, titleConflict } from "./title-editor-state"

describe("title editor review regressions", () => {
  test("trimmed unchanged draft uses the opening title, not a later AI title", () => {
    expect(unchangedTitle("  Opening title  ", "Opening title")).toBe(true)
    expect(unchangedTitle("AI title", "Opening title")).toBe(false)
  })
  test("extracts the conflict snapshot from SDK error data", () => {
    const current = { sessionID: "ses_a", title: "Other writer", titleSource: "user" as const, titleRevision: 3 }
    expect(titleConflict({ name: "TitleConflictError", data: { current } }, "ses_a")).toEqual(current)
    expect(titleConflict({ name: "TitleConflictError", data: { current } }, "ses_b")).toBeUndefined()
    expect(titleConflict({ name: "OtherError", data: { current } }, "ses_a")).toBeUndefined()
    expect(titleConflict({ data: { current: { ...current, titleRevision: -1 } } }, "ses_a")).toBeUndefined()
  })
})
