import { describe, expect, test } from "bun:test"
import { extract } from "../../src/history/extract"

describe("history.extract", () => {
  test("user text part → user_text", () => {
    const r = extract({ type: "text", text: "hello world" } as any, "user")
    expect(r).toEqual({ kind: "user_text", body: "hello world", tool_name: null })
  })

  test("assistant text part → assistant_text", () => {
    const r = extract({ type: "text", text: "sure" } as any, "assistant")
    expect(r).toEqual({ kind: "assistant_text", body: "sure", tool_name: null })
  })

  test("empty text → null (streaming chunk filter)", () => {
    const r = extract({ type: "text", text: "" } as any, "assistant")
    expect(r).toBeNull()
  })

  test("reasoning is indexed", () => {
    const r = extract({ type: "reasoning", text: "thinking" } as any, "assistant")
    expect(r).toEqual({ kind: "reasoning", body: "thinking", tool_name: null })
  })

  test("tool pending → null (streaming mid-state)", () => {
    const part = { type: "tool", tool: "Bash", state: { status: "pending", input: {} } }
    expect(extract(part as any, "assistant")).toBeNull()
  })

  test("tool running → null (streaming mid-state)", () => {
    const part = { type: "tool", tool: "Bash", state: { status: "running", input: { command: "ls" } } }
    expect(extract(part as any, "assistant")).toBeNull()
  })

  test("completed tool indexes both input and output", () => {
    const part = {
      type: "tool",
      tool: "Bash",
      state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
    }
    const r = extract(part as any, "assistant")
    expect(r?.kind).toBe("tool_output")
    expect(r?.body).toContain("Bash")
    expect(r?.body).toContain('"command":"ls"')
    expect(r?.body).toContain("file.txt")
    expect(r?.tool_name).toBe("Bash")
  })

  test("tool error → tool_error", () => {
    const part = {
      type: "tool",
      tool: "Read",
      state: { status: "error", input: { file_path: "/tmp/x" }, error: "ENOENT" },
    }
    const r = extract(part as any, "assistant")
    expect(r).toEqual({
      kind: "tool_error",
      body: 'Read {"file_path":"/tmp/x"} ENOENT',
      tool_name: "Read",
    })
  })

  test("step-start / step-finish / patch / compaction → null", () => {
    for (const type of ["step-start", "step-finish", "patch", "compaction"]) {
      const r = extract({ type } as any, "assistant")
      expect(r).toBeNull()
    }
  })
})

test("image filename and MIME are searchable without binary payload", () => {
  expect(
    extract(
      { type: "file", filename: "designneedle.png", mime: "image/png", url: "data:image/png;base64,YWJj" } as any,
      "user",
    ),
  ).toEqual({ kind: "file", body: "designneedle.png image/png", tool_name: null })
  const result = extract(
    {
      type: "tool",
      tool: "image",
      state: {
        status: "completed",
        input: {},
        output: "data:image/png;base64,YWJj",
        attachments: [{ filename: "diagramneedle.png", mime: "image/png", url: "data:image/png;base64,YWJj" }],
      },
    } as any,
    "assistant",
  )
  expect(result?.body).toContain("diagramneedle.png")
  expect(result?.body).not.toContain("YWJj")
})
