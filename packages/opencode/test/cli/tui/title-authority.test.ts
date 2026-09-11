import { expect, test } from "bun:test"
import type { Session } from "@mimo-ai/sdk/v2"
import { mergeSessionTitle, titleReadback, unchangedTitle } from "../../../src/cli/cmd/tui/util/session-title"

test("unchanged opening title is a no-op unless resolving a conflict", () => {
  expect(unchangedTitle(" Untitled ", "Untitled", false)).toBe(true)
  expect(unchangedTitle("Opening", "Opening", false)).toBe(true)
  expect(unchangedTitle("AI replacement", "Opening", false)).toBe(false)
  expect(unchangedTitle("Opening", "Opening", true)).toBe(false)
  expect(unchangedTitle("", undefined, false)).toBe(false)
})

const base = { id: "ses_test", title: "Saved", titleSource: "user", titleRevision: 3 } as Session
// [TP-ST-R3-07, TP-ST-R11-03] All TUI snapshot paths use this reducer.
test("TUI ignores older/incomplete titles and detects equal revision disagreement", () => {
  let conflicts = 0
  const incoming = { ...base, title: "Old", titleRevision: 2 }
  expect(mergeSessionTitle(base, incoming).title).toBe("Saved")
  expect(
    mergeSessionTitle(base, { ...base, title: "Unknown", titleSource: undefined } as unknown as Session).title,
  ).toBe("Saved")
  expect(
    mergeSessionTitle(base, { ...base }, () => {
      conflicts++
    }),
  ).toEqual(base)
  expect(conflicts).toBe(0)
  expect(
    mergeSessionTitle(base, { ...base, title: "Disagrees" }, () => {
      conflicts++
    }).title,
  ).toBe("Saved")
  expect(conflicts).toBe(1)
  expect(mergeSessionTitle(base, { ...base, title: "New", titleRevision: 4 }).title).toBe("New")
})

// [TP-ST-R3-06, TP-ST-R2-07] A known 409 is not a successful identical rename.
test("lost response may confirm current value, while a known 409 always remains a conflict", () => {
  expect(titleReadback(2, "Saved", base, false)).toBe("saved")
  expect(titleReadback(2, "Saved", base, true)).toBe("conflict")
  expect(titleReadback(2, "My draft", base, false)).toBe("conflict")
  expect(titleReadback(2, "My draft", { ...base, titleSource: "generated" }, false)).toBe("unconfirmed")
})
