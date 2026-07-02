import { expect, test } from "bun:test"
import { selectContinueSessionID } from "../../src/cli/continue-session"

test("selectContinueSessionID skips auto system sessions", () => {
  expect(
    selectContinueSessionID([
      {
        id: "ses_auto_dream",
        title: "Auto Dream",
        time: { updated: 300 },
      },
      {
        id: "ses_auto_distill",
        title: "Auto Distill",
        time: { updated: 200 },
      },
      {
        id: "ses_work",
        title: "Working session",
        time: { updated: 100 },
      },
    ]),
  ).toBe("ses_work")
})

test("selectContinueSessionID skips child sessions", () => {
  expect(
    selectContinueSessionID([
      {
        id: "ses_child",
        title: "checkpoint-writer",
        parentID: "ses_parent",
        time: { updated: 300 },
      },
      {
        id: "ses_parent",
        title: "Working session",
        time: { updated: 100 },
      },
    ]),
  ).toBe("ses_parent")
})
