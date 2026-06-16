import { test, expect, describe } from "bun:test"
import { parse } from "../../src/session/codex-import"
import { SessionID } from "../../src/session/schema"

const SID = SessionID.descending()

function line(type: string, payload: Record<string, unknown>, timestamp?: string) {
  return JSON.stringify({ timestamp: timestamp ?? "2026-06-01T10:00:00.000Z", type, payload })
}

function sessionMeta(overrides?: Record<string, unknown>) {
  return line("session_meta", {
    id: "019ebc1c-cd85-73b3-96bb-6532c9a372fe",
    timestamp: "2026-06-01T09:00:00.000Z",
    cwd: "/Users/test/project",
    originator: "codex-tui",
    cli_version: "0.140.0",
    source: "cli",
    model_provider: "openai",
    ...overrides,
  })
}

function userMessage(text: string, ts?: string) {
  return line("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }, ts)
}

function assistantMessage(text: string, ts?: string) {
  return line("response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  }, ts)
}

function functionCall(name: string, args: Record<string, unknown>, callId: string, ts?: string) {
  return line("response_item", {
    type: "function_call",
    name,
    arguments: JSON.stringify(args),
    call_id: callId,
  }, ts)
}

function functionCallOutput(callId: string, output: string, ts?: string) {
  return line("response_item", {
    type: "function_call_output",
    call_id: callId,
    output,
  }, ts)
}

function customToolCall(name: string, input: string, callId: string, ts?: string) {
  return line("response_item", {
    type: "custom_tool_call",
    status: "completed",
    name,
    input,
    call_id: callId,
  }, ts)
}

function customToolCallOutput(callId: string, output: string, ts?: string) {
  return line("response_item", {
    type: "custom_tool_call_output",
    call_id: callId,
    output,
  }, ts)
}

function reasoning(summary: string, ts?: string) {
  return line("response_item", {
    type: "reasoning",
    summary: summary ? [{ text: summary }] : [],
    content: null,
    encrypted_content: "encrypted...",
  }, ts)
}

function eventMsg(subtype: string, ts?: string) {
  return line("event_msg", { type: subtype }, ts)
}

// [TP-R1-01] Standard Codex rollout jsonl parsed correctly
describe("codex-import parse", () => {
  test("parses standard conversation with user/assistant messages", () => {
    const text = [
      sessionMeta(),
      userMessage("Hello, help me with this"),
      assistantMessage("Sure, I can help!"),
    ].join("\n")

    const result = parse(text, SID)
    expect(result).toBeDefined()
    expect(result!.cwd).toBe("/Users/test/project")
    expect(result!.title).toBe("Hello, help me with this")
    expect(result!.version).toContain("codex-0.140.0")
    expect(result!.messages).toHaveLength(2)

    const user = result!.messages[0]
    expect(user.info.role).toBe("user")
    expect(user.parts).toHaveLength(1)
    expect(user.parts[0].part.type).toBe("text")

    const assistant = result!.messages[1]
    expect(assistant.info.role).toBe("assistant")
    expect(assistant.parts).toHaveLength(1)
  })

  // [TP-R1-02] Tool use: function_call / function_call_output restored correctly
  test("restores function_call and function_call_output as ToolPart", () => {
    const text = [
      sessionMeta(),
      userMessage("List files"),
      assistantMessage("Let me check"),
      functionCall("exec_command", { cmd: ["ls", "-la"] }, "call_abc"),
      functionCallOutput("call_abc", "file1.txt\nfile2.txt"),
    ].join("\n")

    const result = parse(text, SID)!
    expect(result.messages).toHaveLength(2)

    const assistant = result.messages[1]
    const toolParts = assistant.parts.filter((p) => p.part.type === "tool")
    expect(toolParts).toHaveLength(1)

    const tool = toolParts[0].part
    expect(tool.type).toBe("tool")
    if (tool.type === "tool") {
      expect(tool.tool).toBe("exec_command")
      expect(tool.callID).toBe("call_abc")
      expect(tool.state.status).toBe("completed")
      if (tool.state.status === "completed") {
        expect(tool.state.output).toContain("file1.txt")
      }
    }
  })

  // [TP-R1-02] custom_tool_call (e.g. apply_patch) also restored
  test("restores custom_tool_call as ToolPart", () => {
    const text = [
      sessionMeta(),
      userMessage("Apply fix"),
      assistantMessage("Applying patch"),
      customToolCall("apply_patch", "*** Begin Patch\nsome patch", "call_xyz"),
      customToolCallOutput("call_xyz", '{"output":"Success"}'),
    ].join("\n")

    const result = parse(text, SID)!
    const assistant = result.messages[1]
    const toolParts = assistant.parts.filter((p) => p.part.type === "tool")
    expect(toolParts).toHaveLength(1)
    if (toolParts[0].part.type === "tool") {
      expect(toolParts[0].part.tool).toBe("apply_patch")
      expect(toolParts[0].part.state.status).toBe("completed")
    }
  })

  // [TP-R1-03] Reasoning blocks restored
  test("restores reasoning blocks as reasoning parts", () => {
    const text = [
      sessionMeta(),
      userMessage("Think about this"),
      assistantMessage("Here is my answer"),
      reasoning("I thought about it carefully"),
    ].join("\n")

    const result = parse(text, SID)!
    const assistant = result.messages[1]
    const reasoningParts = assistant.parts.filter((p) => p.part.type === "reasoning")
    expect(reasoningParts).toHaveLength(1)
    if (reasoningParts[0].part.type === "reasoning") {
      expect(reasoningParts[0].part.text).toBe("I thought about it carefully")
    }
  })

  // [TP-R1-05] Empty file returns undefined
  test("returns undefined for empty file", () => {
    expect(parse("", SID)).toBeUndefined()
  })

  // [TP-R1-05] All lines parse failure returns undefined
  test("returns undefined when all lines fail to parse", () => {
    expect(parse("not json\nalso not json\n", SID)).toBeUndefined()
  })

  // [TP-R1-06] Mixed valid/invalid lines: bad lines skipped, good lines parsed
  test("skips malformed lines and parses valid ones", () => {
    const text = [
      sessionMeta(),
      "GARBAGE LINE",
      userMessage("Hello"),
      "{invalid json}",
      assistantMessage("Hi there"),
    ].join("\n")

    const result = parse(text, SID)!
    expect(result.messages).toHaveLength(2)
    expect(result.title).toBe("Hello")
  })

  // [TP-R1-08] Missing cwd in session_meta
  test("handles missing cwd gracefully", () => {
    const text = [
      sessionMeta({ cwd: undefined }),
      userMessage("Hello"),
      assistantMessage("Hi"),
    ].join("\n")

    const result = parse(text, SID)!
    expect(result.cwd).toBe("")
  })

  // [TP-R1-09] Only session_meta with no messages → undefined
  test("returns undefined when only session_meta and no messages", () => {
    const text = [
      sessionMeta(),
      eventMsg("task_started"),
      eventMsg("task_complete"),
    ].join("\n")

    expect(parse(text, SID)).toBeUndefined()
  })

  test("event_msg lines are ignored (no messages created from them)", () => {
    const text = [
      sessionMeta(),
      eventMsg("task_started"),
      userMessage("Hi"),
      eventMsg("agent_message"),
      eventMsg("token_count"),
      assistantMessage("Hello"),
      eventMsg("task_complete"),
    ].join("\n")

    const result = parse(text, SID)!
    expect(result.messages).toHaveLength(2)
  })

  test("developer role messages treated as user", () => {
    const text = [
      sessionMeta(),
      line("response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "System instructions" }],
      }),
      assistantMessage("Understood"),
    ].join("\n")

    const result = parse(text, SID)!
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].info.role).toBe("user")
  })

  test("timestamps are correctly extracted", () => {
    const t1 = "2026-06-01T09:00:00.000Z"
    const t2 = "2026-06-01T10:00:00.000Z"
    const t3 = "2026-06-01T11:00:00.000Z"
    const text = [
      sessionMeta({ timestamp: t1 }),
      userMessage("Hello", t2),
      assistantMessage("Hi", t3),
    ].join("\n")

    const result = parse(text, SID)!
    expect(result.timeCreated).toBe(Date.parse(t1))
    expect(result.timeUpdated).toBe(Date.parse(t3))
  })

  // [TP-R1-04] Verify multiple files would create separate sessions (parse only)
  test("sessionUuid is extracted from session_meta", () => {
    const text = [
      sessionMeta({ id: "custom-uuid-123" }),
      userMessage("Hi"),
    ].join("\n")

    const result = parse(text, SID)!
    expect(result.sessionUuid).toBe("custom-uuid-123")
  })

  // [TP-R1-03] Reasoning emitted BEFORE the first assistant text must not be dropped.
  // Codex routinely writes a reasoning item ahead of the assistant message; an
  // earlier version dropped it because no assistant message was open yet.
  test("restores reasoning that precedes the first assistant message", () => {
    const text = [
      sessionMeta(),
      userMessage("Think first"),
      reasoning("Reasoning before any assistant text"),
      assistantMessage("Done thinking"),
    ].join("\n")

    const result = parse(text, SID)!
    const assistant = result.messages.find((m) => m.info.role === "assistant")!
    const reasoningParts = assistant.parts.filter((p) => p.part.type === "reasoning")
    expect(reasoningParts).toHaveLength(1)
    if (reasoningParts[0].part.type === "reasoning") {
      expect(reasoningParts[0].part.text).toBe("Reasoning before any assistant text")
    }
    const textParts = assistant.parts.filter((p) => p.part.type === "text")
    expect(textParts).toHaveLength(1)
  })

  // [TP-R1-02] A tool call emitted before any assistant text must still be captured,
  // along with its later output (which would otherwise be orphaned).
  test("restores function_call that precedes the first assistant message", () => {
    const text = [
      sessionMeta(),
      userMessage("Run it"),
      functionCall("exec_command", { cmd: ["ls"] }, "call_pre"),
      functionCallOutput("call_pre", "output.txt"),
      assistantMessage("Here is the result"),
    ].join("\n")

    const result = parse(text, SID)!
    const assistant = result.messages.find((m) => m.info.role === "assistant")!
    const toolParts = assistant.parts.filter((p) => p.part.type === "tool")
    expect(toolParts).toHaveLength(1)
    if (toolParts[0].part.type === "tool") {
      expect(toolParts[0].part.tool).toBe("exec_command")
      expect(toolParts[0].part.state.status).toBe("completed")
      if (toolParts[0].part.state.status === "completed") {
        expect(toolParts[0].part.state.output).toContain("output.txt")
      }
    }
  })
})
