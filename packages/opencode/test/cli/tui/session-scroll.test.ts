import { expect, test } from "bun:test"
import { conversationScrollKey } from "../../../src/cli/cmd/tui/routes/session/scroll"

test("conversationScrollKey changes when switching between main and subagent views", () => {
  expect(conversationScrollKey({ sessionID: "ses_1", agentID: "main" })).toBe("ses_1:main")
  expect(conversationScrollKey({ sessionID: "ses_1", agentID: "agent_1" })).toBe("ses_1:agent_1")
})

test("conversationScrollKey defaults missing agentID to main", () => {
  expect(conversationScrollKey({ sessionID: "ses_1" })).toBe("ses_1:main")
})
