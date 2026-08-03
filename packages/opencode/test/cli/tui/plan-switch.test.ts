import { describe, expect, test } from "bun:test"
import type { ToolPart } from "../../../src/session/message-v2"
import { planSwitchTarget } from "../../../src/cli/cmd/tui/routes/session/plan-switch"

function completed(tool: string, switched?: boolean) {
  return {
    tool,
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "",
      metadata: switched === undefined ? {} : { switched },
      time: { start: 0, end: 1 },
    },
  } satisfies Pick<ToolPart, "tool" | "state">
}

describe("planSwitchTarget", () => {
  test("switches only when plan_exit reports success", () => {
    expect(planSwitchTarget(completed("plan_exit", true))).toBe("build")
  })

  test("does not switch when plan exit is declined", () => {
    expect(planSwitchTarget(completed("plan_exit", false))).toBeUndefined()
  })

  test("does not switch without explicit switched metadata", () => {
    expect(planSwitchTarget(completed("plan_exit"))).toBeUndefined()
  })

  test("ignores unfinished and unrelated tools", () => {
    expect(
      planSwitchTarget({
        tool: "plan_exit",
        state: { status: "running", input: {}, metadata: { switched: true }, time: { start: 0 } },
      }),
    ).toBeUndefined()
    expect(planSwitchTarget(completed("plan_enter", true))).toBeUndefined()
    expect(planSwitchTarget(completed("question", true))).toBeUndefined()
  })
})
