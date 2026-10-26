import { MessageV2 } from "../../src/session/message-v2"
import { partExamples } from "./fixtures/parts"
import { describe, expect, test } from "bun:test"
import { extract } from "../../src/history/extract"

describe("history.extract", () => {
  test("user text is indexed", () => {
    const r = extract({ type: "text", text: "hello world" } as any, "user")
    expect(r).toEqual({ kind: "user_text", body: "hello world", body_idx: "hello world", tool_name: null })
  })

  test("assistant text is indexed", () => {
    const r = extract({ type: "text", text: "sure" } as any, "assistant")
    expect(r).toEqual({ kind: "assistant_text", body: "sure", body_idx: "sure", tool_name: null })
  })

  test("empty text → null (streaming chunk filter)", () => {
    const r = extract({ type: "text", text: "" } as any, "user")
    expect(r).toBeNull()
  })

  test("reasoning is indexed", () => {
    const r = extract({ type: "reasoning", text: "thinking" } as any, "assistant")
    expect(r).toEqual({ kind: "reasoning", body: "thinking", body_idx: "thinking", tool_name: null })
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
    expect(r?.body).toContain("Bash")
    expect(r?.body).toContain('"command":"ls"')
    expect(r?.body).toContain("file.txt")
    expect(r?.kind).toBe("tool_output")
    expect(r?.tool_name).toBe("Bash")
  })

  test("tool error includes input and error", () => {
    const part = {
      type: "tool",
      tool: "Read",
      state: { status: "error", input: { file_path: "/tmp/x" }, error: "ENOENT" },
    }
    const r = extract(part as any, "assistant")
    expect(r).toEqual({
      kind: "tool_error", body_idx: expect.any(String),
      body: 'Read {"file_path":"/tmp/x"} ENOENT',
      tool_name: "Read",
    })
  })

  test("execution markers are not indexed", () => {
    for (const type of ["step-start", "step-finish", "snapshot", "checkpoint"]) {
      const r = extract({ type } as any, "assistant")
      expect(r).toBeNull()
    }
  })
})

// extract() and upsertHistoryBody share previewForIndex (cleanDataUrls + tool-result budget).
// FTS writes are single-row — no chunk path.
test("image filename and MIME are searchable without binary payload", () => {
  expect(
    extract({
      type: "file",
      filename: "designneedle.png",
      mime: "image/png",
      url: "data:image/png;base64,YWJj",
    } as any, "assistant"),
  ).toEqual({ kind: "file", body: "designneedle.png image/png", body_idx: "designneedle.png image/png", tool_name: null })
  const r = extract({
    type: "tool",
    tool: "image",
    state: {
      status: "completed",
      input: {},
      output: "data:image/png;base64,YWJj",
      attachments: [{ filename: "diagramneedle.png", mime: "image/png", url: "data:image/png;base64,YWJj" }],
    },
  } as any, "assistant")
  expect(r?.body).toContain("diagramneedle.png")
  expect(r?.body).not.toContain("YWJj")
})

test("every declared part variant has an explicit indexing decision", () => {
  expect(partExamples.map(({ data }) => data.type).sort()).toEqual(
    MessageV2.Part.options.map((schema) => schema.shape.type.value).sort(),
  )
  for (const [i, example] of partExamples.entries()) {
    const part = MessageV2.Part.parse({ id: `prt_${i}`, sessionID: "ses_all", messageID: "msg_all", ...example.data })
    const result = extract(part, "assistant")
    if (example.query) expect(result?.body).toContain(example.query)
    else expect(result).toBeNull()
    expect(result?.body ?? "").not.toContain("YWJj")
  }
})

// kind is write-side classification for consumers outside History.search.
// History.search must NOT expose a kind filter (see tool/history.test.ts "search schema has no content-type filter").
describe("history.extract kind classification", () => {
  test("text kind follows message role", () => {
    expect(extract({ type: "text", text: "hi" } as any, "user")?.kind).toBe("user_text")
    expect(extract({ type: "text", text: "hi" } as any, "assistant")?.kind).toBe("assistant_text")
  })

  test("reasoning / file / tool / misc kinds", () => {
    expect(extract({ type: "reasoning", text: "think" } as any, "assistant")?.kind).toBe("reasoning")
    expect(extract({ type: "file", filename: "a.png", mime: "image/png" } as any, "assistant")?.kind).toBe("file")
    expect(
      extract({ type: "tool", tool: "bash", state: { status: "completed", input: {}, output: "ok" } } as any, "assistant")
        ?.kind,
    ).toBe("tool_output")
    expect(
      extract({ type: "tool", tool: "bash", state: { status: "error", input: {}, error: "e" } } as any, "assistant")
        ?.kind,
    ).toBe("tool_error")
    expect(
      extract({ type: "subtask", prompt: "p", description: "d", agent: "a", command: "c" } as any, "assistant")?.kind,
    ).toBe("subtask")
    expect(extract({ type: "patch", hash: "h", files: ["f.ts"] } as any, "assistant")?.kind).toBe("patch")
    expect(extract({ type: "agent", name: "n" } as any, "assistant")?.kind).toBe("agent")
    expect(
      extract({ type: "retry", message: "m" } as any, "assistant")?.kind,
    ).toBe("retry")
    expect(
      extract({ type: "compaction", projection: { summary: "s", manifest: "m" } } as any, "assistant")?.kind,
    ).toBe("compaction")
  })

  test("every indexed kind is non-empty", () => {
    const samples: Array<[any, "user" | "assistant"]> = [
      [{ type: "text", text: "x" }, "user"],
      [{ type: "reasoning", text: "x" }, "assistant"],
      [{ type: "file", filename: "f", mime: "text/plain" }, "assistant"],
      [{ type: "tool", tool: "t", state: { status: "completed", input: {}, output: "o" } }, "assistant"],
      [{ type: "tool", tool: "t", state: { status: "error", input: {}, error: "e" } }, "assistant"],
    ]
    for (const [part, role] of samples) {
      const r = extract(part as any, role)
      expect(r?.kind).toBeTruthy()
      expect(typeof r?.kind).toBe("string")
    }
  })
})
