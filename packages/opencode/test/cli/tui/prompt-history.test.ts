import { describe, expect, test } from "bun:test"
import {
  promptHistoryForScope,
  promptHistoryMatchesScope,
  promptHistoryScopeKey,
  type PromptInfo,
} from "../../../src/cli/cmd/tui/component/prompt/history"

function entry(input: string, scope: Pick<PromptInfo, "sessionID" | "workspaceID"> = {}): PromptInfo {
  return {
    input,
    parts: [],
    ...scope,
  }
}

describe("prompt history scope", () => {
  const history = [
    entry("task a prompt", { sessionID: "session-a", workspaceID: "workspace-1" }),
    entry("task b prompt", { sessionID: "session-b", workspaceID: "workspace-1" }),
    entry("task c prompt", { sessionID: "session-c", workspaceID: "workspace-2" }),
    entry("workspace prompt", { workspaceID: "workspace-1" }),
    entry("legacy prompt"),
  ]

  test("uses session id as the strictest scope", () => {
    expect(promptHistoryScopeKey({ sessionID: "session-b", workspaceID: "workspace-1" })).toBe("session:session-b")
    expect(promptHistoryForScope(history, { sessionID: "session-b", workspaceID: "workspace-1" })).toEqual([history[1]])
  })

  test("uses workspace scope when no session is active", () => {
    expect(promptHistoryScopeKey({ workspaceID: "workspace-1" })).toBe("workspace:workspace-1")
    expect(promptHistoryForScope(history, { workspaceID: "workspace-1" })).toEqual([history[0], history[1], history[3]])
  })

  test("keeps legacy unscoped entries out of restored sessions", () => {
    expect(promptHistoryMatchesScope(history[4], { sessionID: "session-b" })).toBe(false)
    expect(promptHistoryForScope(history, {})).toEqual([history[4]])
  })
})
