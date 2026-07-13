import { test, expect, describe } from "bun:test"
import { parse } from "../../src/session/claude-import"
import { SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"

const SID = SessionID.descending()

function userEntry(content: unknown, ts?: string, extra?: Record<string, unknown>) {
  return JSON.stringify({
    type: "user",
    cwd: "/Users/test/project",
    version: "1.0.0",
    timestamp: ts ?? "2026-06-01T10:00:00.000Z",
    message: { role: "user", content },
    ...extra,
  })
}

function assistantEntry(content: unknown[], ts?: string, model?: string, usage?: Record<string, unknown>) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts ?? "2026-06-01T10:00:05.000Z",
    message: { role: "assistant", model: model ?? "claude-sonnet-4", usage, content },
  })
}

function toolPart(parsed: NonNullable<Awaited<ReturnType<typeof parse>>>) {
  const parts = parsed.messages.flatMap((m) => m.parts.map((p) => p.part))
  return parts.find((p): p is MessageV2.ToolPart => p.type === "tool")
}

describe("claude-import parse", () => {
  test("parses a standard user/assistant conversation", async () => {
    const text = [
      userEntry("hello claude"),
      assistantEntry([{ type: "text", text: "hello human" }]),
    ].join("\n")
    const parsed = await parse(text, SID)
    expect(parsed).toBeDefined()
    expect(parsed!.cwd).toBe("/Users/test/project")
    expect(parsed!.version).toBe("1.0.0")
    expect(parsed!.title).toBe("hello claude")
    expect(parsed!.messages.length).toBe(2)
    expect(parsed!.messages[0].info.role).toBe("user")
    expect(parsed!.messages[1].info.role).toBe("assistant")
    expect(parsed!.timeCreated).toBe(Date.parse("2026-06-01T10:00:00.000Z"))
    expect(parsed!.timeUpdated).toBe(Date.parse("2026-06-01T10:00:05.000Z"))
  })

  test("patches tool_use with its tool_result", async () => {
    const text = [
      userEntry("run a tool"),
      assistantEntry([{ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }]),
      userEntry([{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" }], "2026-06-01T10:00:10.000Z"),
    ].join("\n")
    const parsed = await parse(text, SID)
    const tool = toolPart(parsed!)
    expect(tool).toBeDefined()
    expect(tool!.tool).toBe("bash")
    expect(tool!.state.status).toBe("completed")
    expect((tool!.state as Extract<MessageV2.ToolPart["state"], { status: "completed" }>).output).toBe("file.txt")
  })

  test("marks errored tool_result as error state", async () => {
    const text = [
      userEntry("run a tool"),
      assistantEntry([{ type: "tool_use", id: "call_1", name: "bash", input: {} }]),
      userEntry([{ type: "tool_result", tool_use_id: "call_1", content: "boom", is_error: true }], "2026-06-01T10:00:10.000Z"),
    ].join("\n")
    const parsed = await parse(text, SID)
    const tool = toolPart(parsed!)
    expect(tool!.state.status).toBe("error")
  })

  test("skips malformed lines and parses valid ones", async () => {
    const text = ["not json at all", userEntry("still works"), "{broken", assistantEntry([{ type: "text", text: "ok" }])].join("\n")
    const parsed = await parse(text, SID)
    expect(parsed).toBeDefined()
    expect(parsed!.messages.length).toBe(2)
  })

  test("returns undefined when no line parses as JSON", async () => {
    expect(await parse("garbage\nmore garbage", SID)).toBeUndefined()
    expect(await parse("", SID)).toBeUndefined()
  })

  test("synthesizes a user message when the transcript starts with an assistant turn", async () => {
    const text = [assistantEntry([{ type: "text", text: "resumed reply" }])].join("\n")
    const parsed = await parse(text, SID)
    expect(parsed!.messages.length).toBe(2)
    expect(parsed!.messages[0].info.role).toBe("user")
    expect(parsed!.messages[1].info.role).toBe("assistant")
  })

  test("captures thinking blocks as reasoning parts", async () => {
    const text = [userEntry("think"), assistantEntry([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "done" }])].join("\n")
    const parsed = await parse(text, SID)
    const parts = parsed!.messages[1].parts.map((p) => p.part.type)
    expect(parts).toEqual(["reasoning", "text"])
  })

  test("an async iterable of lines produces the same result as the equivalent string", async () => {
    const lines = [
      userEntry("hello claude"),
      assistantEntry([{ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }]),
      userEntry([{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" }], "2026-06-01T10:00:10.000Z"),
      assistantEntry([{ type: "text", text: "all done" }], "2026-06-01T10:00:15.000Z"),
    ]
    async function* streamed() {
      for (const line of lines) yield line
    }
    const fromString = await parse(lines.join("\n"), SID)
    const fromStream = await parse(streamed(), SID)
    expect(fromStream).toBeDefined()
    // Message/part IDs are freshly generated per parse; compare shape, roles, text and tool states.
    const shape = (p: NonNullable<typeof fromString>) => ({
      cwd: p.cwd,
      title: p.title,
      timeCreated: p.timeCreated,
      timeUpdated: p.timeUpdated,
      messages: p.messages.map((m) => ({
        role: m.info.role,
        parts: m.parts.map((x) => {
          const part = x.part as MessageV2.Part & { text?: string; state?: { status: string; output?: string } }
          return { type: part.type, text: part.text, status: part.state?.status, output: part.state?.output }
        }),
      })),
    })
    expect(shape(fromStream!)).toEqual(shape(fromString!))
  })
})
