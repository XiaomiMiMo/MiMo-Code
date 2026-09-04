import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import {
  sessionMutatedMainWorktrees,
  sessionHasAutoWorktreeNotice,
} from "../../src/tool/auto-worktree-hint"

function toolPart(tool: string, metadata: Record<string, unknown>, status = "completed"): MessageV2.Part {
  return {
    id: "prt_test",
    sessionID: "ses_test" as any,
    messageID: "msg_test" as any,
    type: "tool",
    tool,
    callID: "call_test",
    state: {
      status: status as "completed",
      input: {},
      output: "",
      title: tool,
      metadata,
      time: { start: 0, end: 1 },
    },
  } as unknown as MessageV2.Part
}

function withParts(parts: MessageV2.Part[], role: "user" | "assistant" = "assistant"): MessageV2.WithParts {
  return {
    info: {
      id: "msg_test" as any,
      sessionID: "ses_test" as any,
      role,
      parentID: undefined,
      agentID: undefined,
      time: { created: 0 },
      error: undefined,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      modelID: "m",
      providerID: "p",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as any,
    parts,
  }
}

describe("sessionMutatedMainWorktrees bash exit gate", () => {
  test("failed bash (non-zero exit) does not count", () => {
    const msgs = [withParts([toolPart("bash", { mainWorktreeHits: ["/repo"], exit: 1 })])]
    expect(sessionMutatedMainWorktrees(msgs)).toEqual([])
  })

  test("successful bash (exit 0) is eligible", () => {
    const failed = [withParts([toolPart("bash", { mainWorktreeHits: ["/repo"], exit: 1 })])]
    const ok = [withParts([toolPart("bash", { mainWorktreeHits: ["/repo"], exit: 0 })])]
    expect(sessionMutatedMainWorktrees(failed)).toEqual([])
    expect(sessionMutatedMainWorktrees(ok)).toEqual(["/repo"])
  })
})

describe("sessionHasAutoWorktreeNotice", () => {
  test("finds a notice on any user message, not only the last", () => {
    const notice = {
      id: "prt_n" as any,
      sessionID: "ses_test" as any,
      messageID: "msg_a" as any,
      type: "text" as const,
      text: "<system-reminder>\nAuto-Worktree Notice\n</system-reminder>",
      synthetic: true,
    }
    const msgs = [
      withParts([notice], "user"),
      withParts([], "assistant"),
      withParts([], "user"),
    ]
    expect(sessionHasAutoWorktreeNotice(msgs)).toBe(true)
  })

  test("false when no notice exists", () => {
    const msgs = [withParts([], "user")]
    expect(sessionHasAutoWorktreeNotice(msgs)).toBe(false)
  })
})
